/**
 * Praten met het dashboard.
 *
 * Alles gaat van de node naar het dashboard (de node is van buitenaf niet
 * bereikbaar). Elk verzoek draagt het token van de node in X-Node-Token; die
 * header komt ook aan bij hostings die Authorization niet doorgeven aan PHP.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync, renameSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';

export const PROTOCOL_VERSION = 1;
export const AGENT_VERSION = '1.0.0';

export class ApiError extends Error {
  constructor(message, status = 0, code = 'error', data = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }

  /** Netwerkfout of 5xx: later opnieuw proberen heeft zin. */
  get retryable() {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

export class Api {
  /**
   * @param {string} baseUrl  https://testing.gjdc.nl
   * @param {() => string} tokenFn
   */
  constructor(baseUrl, tokenFn) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokenFn = tokenFn;
    this.queryStyle = false; // /api/index.php?path=... als rewrites ontbreken
    this.userAgent = `gjdc-e2e-server/${AGENT_VERSION} (${os.platform()} ${os.arch()}; node ${process.versions.node})`;
  }

  url(path) {
    const clean = String(path).replace(/^\/+/, '');
    if (clean.startsWith('api/')) {
      const rest = clean.slice(4);
      const [route, query] = rest.split('?');
      if (this.queryStyle) {
        return `${this.baseUrl}/api/index.php?path=/${route}${query ? `&${query}` : ''}`;
      }
      return `${this.baseUrl}/api/${rest}`;
    }
    return `${this.baseUrl}/${clean}`;
  }

  headers(extra = {}) {
    const headers = {
      'User-Agent': this.userAgent,
      'X-E2E-Protocol': String(PROTOCOL_VERSION),
      Accept: 'application/json',
      ...extra,
    };
    const token = this.tokenFn?.();
    if (token) headers['X-Node-Token'] = token;
    return headers;
  }

  /**
   * JSON heen en terug. Geeft `data` uit het antwoord terug, of gooit een
   * ApiError met de melding van het dashboard.
   */
  async request(method, path, body, { timeout = 30000, raw = null, contentType = null } = {}) {
    const init = {
      method,
      headers: this.headers(contentType ? { 'Content-Type': contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      signal: AbortSignal.timeout(timeout),
    };
    if (raw !== null) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);

    let response;
    try {
      response = await fetch(this.url(path), init);
    } catch (error) {
      const reason = error?.cause?.code || error?.name === 'TimeoutError' ? (error?.cause?.code ?? 'time-out') : error.message;
      throw new ApiError(`Dashboard niet bereikbaar (${reason})`, 0, 'network');
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    // Geen JSON op een 404: waarschijnlijk werken de rewrites niet. Dan de
    // variant met ?path= proberen, en die blijven gebruiken.
    if (json === null && response.status === 404 && !this.queryStyle && String(path).startsWith('api/')) {
      this.queryStyle = true;
      return this.request(method, path, body, { timeout, raw, contentType });
    }

    if (json === null) {
      throw new ApiError(`Onverwacht antwoord van het dashboard (HTTP ${response.status})`, response.status, 'bad_response');
    }
    if (!response.ok || json.success === false) {
      throw new ApiError(json.error || `HTTP ${response.status}`, response.status, json.code || 'error', json);
    }
    return json.data;
  }

  post(path, body, options) {
    return this.request('POST', path, body ?? {}, options);
  }

  get(path, options) {
    return this.request('GET', path, undefined, options);
  }

  /**
   * Downloadt een bestand naar `dest`, hervat een afgebroken download (Range)
   * en controleert de sha256. Geeft het aantal gedownloade bytes terug.
   */
  async download(path, dest, { sha256, size, timeout = 600000, onProgress } = {}) {
    const part = `${dest}.part`;
    let offset = existsSync(part) ? statSync(part).size : 0;
    if (size !== undefined && offset > size) {
      rmSync(part, { force: true });
      offset = 0;
    }

    const hash = createHash('sha256');
    if (offset > 0) {
      // Wat er al staat moet mee in de hash.
      await hashInto(hash, part);
    }

    const headers = this.headers({ Accept: 'application/zip, application/octet-stream' });
    if (offset > 0) headers.Range = `bytes=${offset}-`;

    let response;
    try {
      response = await fetch(this.url(path), { headers, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw new ApiError(`Download mislukt (${error?.cause?.code ?? error.message})`, 0, 'network');
    }

    if (response.status === 416 && size !== undefined && offset === size) {
      // Alles was er al.
      await response.body?.cancel().catch(() => {});
    } else if (response.status === 200 && offset > 0) {
      // De server hervat niet: opnieuw beginnen.
      await response.body?.cancel().catch(() => {});
      rmSync(part, { force: true });
      return this.download(path, dest, { sha256, size, timeout, onProgress });
    } else if (response.status !== 200 && response.status !== 206) {
      let message = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        message = json.error ?? message;
        throw new ApiError(message, response.status, json.code ?? 'download_failed');
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(message, response.status, 'download_failed');
      }
    }

    let received = 0;
    if (response.body && response.status !== 416) {
      const out = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          received += chunk.length;
          if (!out.write(chunk)) await once(out, 'drain');
          onProgress?.(offset + received);
        }
      } finally {
        out.end();
        await once(out, 'close');
      }
    }

    const total = statSync(part).size;
    if (size !== undefined && total !== size) {
      throw new ApiError(`Download onvolledig (${total} van ${size} bytes)`, 0, 'incomplete');
    }
    const digest = hash.digest('hex');
    if (sha256 && digest !== sha256) {
      rmSync(part, { force: true });
      throw new ApiError('De sha256 van de download klopt niet; het bestand is weggegooid.', 0, 'checksum');
    }
    renameSync(part, dest);
    return received;
  }

  /**
   * Stuurt een bestand in stukken naar het dashboard. Zo doen de
   * upload-limieten van PHP er niet toe, en kan een onderbroken upload verder
   * waar hij was.
   */
  async upload(jobId, file, { kind, filename, sha256, onProgress }) {
    const size = statSync(file).size;
    const digest = sha256 ?? (await sha256File(file));
    const announced = await this.post(`api/agent/jobs/${jobId}/artifacts`, { kind, filename, size, sha256: digest });
    const id = announced.artifact_id;
    const chunkSize = Math.max(65536, Number(announced.chunk_bytes) || 4194304);

    const fd = openSync(file, 'r');
    try {
      let offset = 0;
      let failures = 0;
      while (offset < size) {
        const length = Math.min(chunkSize, size - offset);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, offset);
        try {
          const result = await this.request('POST', `api/agent/jobs/${jobId}/artifacts/${id}/chunk?offset=${offset}`, undefined, {
            raw: buffer,
            contentType: 'application/octet-stream',
            timeout: 120000,
          });
          offset = Number(result.received);
          failures = 0;
          onProgress?.(offset, size);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'offset_mismatch' && error.data?.received !== undefined) {
            offset = Number(error.data.received);
            continue;
          }
          if (error instanceof ApiError && error.retryable && failures < 5) {
            failures++;
            await sleep(1000 * 2 ** failures);
            continue;
          }
          throw error;
        }
      }
    } finally {
      closeSync(fd);
    }

    await this.post(`api/agent/jobs/${jobId}/artifacts/${id}/complete`, {}, { timeout: 300000 });
    return { id, size };
  }
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  await hashInto(hash, file);
  return hash.digest('hex');
}

async function hashInto(hash, file) {
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
