/**
 * ZIP-bestanden lezen, veilig uitpakken en maken — zonder afhankelijkheden.
 *
 * Uitpakken is waar het mis kan gaan, dus daar zijn we streng (net als het
 * dashboard bij het uploaden):
 *   - geen paden die uit de doelmap ontsnappen (zip-slip: ../, /, C:);
 *   - geen symbolische links;
 *   - geen versleutelde of exotisch gecomprimeerde bestanden;
 *   - een harde grens aan grootte en aantal (zip-bom);
 *   - de CRC32 van elk bestand moet kloppen.
 *
 * Maken gebeurt streamend (met data descriptors), zodat een rapport met
 * video's niet in zijn geheel in het geheugen hoeft.
 */

import { open, mkdir, readdir, stat, writeFile, lstat, realpath } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import zlib from 'node:zlib';

export class ZipError extends Error {}

// ── CRC32 ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 zoals ZIP en gzip hem gebruiken; incrementeel door `previous` mee te geven. */
export function crc32(buffer, previous = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer, previous) >>> 0;
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Paden ───────────────────────────────────────────────────────────────────

/** Maakt een naam uit een ZIP tot veilig relatief pad, of null als hij ontsnapt. */
export function safePath(name) {
  const normalized = String(name).replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (normalized === '' || /[\x00-\x1f\x7f]/.test(normalized)) return null;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = [];
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/** Wat zippers ongevraagd toevoegen. */
export function isJunk(p) {
  if (p === '__MACOSX' || p.startsWith('__MACOSX/')) return true;
  const base = p.split('/').pop();
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini' || base.startsWith('._');
}

// ── Lezen ───────────────────────────────────────────────────────────────────

export class ZipReader {
  static async open(file) {
    const reader = new ZipReader();
    reader.fh = await open(file, 'r');
    reader.size = (await reader.fh.stat()).size;
    try {
      await reader.readCentralDirectory();
    } catch (error) {
      await reader.close();
      throw error;
    }
    return reader;
  }

  async close() {
    await this.fh?.close().catch(() => {});
    this.fh = null;
  }

  async readAt(offset, length) {
    if (offset < 0 || offset + length > this.size) throw new ZipError('De ZIP is beschadigd: verwijzing buiten het bestand.');
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.fh.read(buffer, done, length - done, offset + done);
      if (bytesRead === 0) throw new ZipError('De ZIP is beschadigd: onverwacht einde.');
      done += bytesRead;
    }
    return buffer;
  }

  async readCentralDirectory() {
    if (this.size < 22) throw new ZipError('Dit is geen ZIP-bestand (te klein).');
    const tailLength = Math.min(this.size, 65535 + 22);
    const tail = await this.readAt(this.size - tailLength, tailLength);
    let pos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { pos = i; break; }
    }
    if (pos === -1) throw new ZipError('Dit is geen geldig ZIP-bestand (geen inhoudsopgave gevonden).');

    const eocdOffset = this.size - tailLength + pos;
    let entries = tail.readUInt16LE(pos + 10);
    let cdSize = tail.readUInt32LE(pos + 12);
    let cdOffset = tail.readUInt32LE(pos + 16);
    if (tail.readUInt16LE(pos + 4) !== 0 || tail.readUInt16LE(pos + 6) !== 0) {
      throw new ZipError('Gesplitste ZIP-bestanden worden niet ondersteund.');
    }

    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (eocdOffset < 20) throw new ZipError('ZIP64-inhoudsopgave ontbreekt.');
      const locator = await this.readAt(eocdOffset - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new ZipError('ZIP64-inhoudsopgave ontbreekt.');
      const record = await this.readAt(Number(locator.readBigUInt64LE(8)), 56);
      if (record.readUInt32LE(0) !== 0x06064b50) throw new ZipError('ZIP64-inhoudsopgave is beschadigd.');
      entries = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
    if (entries > 100000) throw new ZipError('De ZIP bevat te veel bestanden.');

    const cd = await this.readAt(cdOffset, cdSize);
    this.entries = [];
    let p = 0;
    for (let i = 0; i < entries; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('De inhoudsopgave van de ZIP is beschadigd.');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let offset = cd.readUInt32LE(p + 42);
      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      p += 46 + nameLen + extraLen + commentLen;

      if (size === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
        let q = 0;
        while (q + 4 <= extra.length) {
          const id = extra.readUInt16LE(q);
          const len = extra.readUInt16LE(q + 2);
          if (id === 0x0001) {
            let r = q + 4;
            if (size === 0xffffffff) { size = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (offset === 0xffffffff) { offset = Number(extra.readBigUInt64LE(r)); }
            break;
          }
          q += 4 + len;
        }
      }

      const name = (flags & 0x0800) !== 0 || isUtf8(rawName) ? rawName.toString('utf8') : rawName.toString('latin1');
      const unixMode = (madeBy >> 8) === 3 ? (external >>> 16) & 0xffff : 0;
      this.entries.push({
        name,
        isDir: name.replace(/\\/g, '/').endsWith('/') || (unixMode & 0xf000) === 0x4000,
        isSymlink: (unixMode & 0xf000) === 0xa000,
        encrypted: (flags & 0x0001) !== 0,
        method,
        crc,
        compressedSize: csize,
        size,
        offset,
        mode: unixMode & 0o777,
      });
    }
  }

  async dataOffset(entry) {
    const local = await this.readAt(entry.offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`De ZIP is beschadigd bij ${entry.name}.`);
    return entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  }

  /** De inhoud van één bestand, met controle van grootte en CRC. */
  async read(entry, limit = 256 * 1024 * 1024) {
    if (entry.encrypted) throw new ZipError(`${entry.name} is versleuteld; maak de ZIP zonder wachtwoord.`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`${entry.name} gebruikt een compressie die niet ondersteund wordt (methode ${entry.method}). Maak de ZIP opnieuw met gewone deflate-compressie.`);
    }
    if (entry.size > limit) throw new ZipError(`${entry.name} is te groot om uit te pakken.`);
    const start = await this.dataOffset(entry);
    const compressed = await this.readAt(start, entry.compressedSize);
    let data;
    if (entry.method === 8) {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
      } catch (error) {
        throw new ZipError(`${entry.name} is beschadigd of groter dan aangegeven (${error.code ?? error.message}).`);
      }
    } else {
      data = compressed;
    }
    if (data.length !== entry.size) throw new ZipError(`${entry.name} heeft niet de grootte die de ZIP aangeeft.`);
    if (crc32(data) !== entry.crc) throw new ZipError(`${entry.name} is beschadigd (CRC klopt niet).`);
    return data;
  }

  /**
   * Pakt alles uit naar `target`. `strip` haalt een gedeelde bovenmap weg.
   * @returns {Promise<{files: number, bytes: number}>}
   */
  async extractTo(target, { strip = '', maxBytes = 512 * 1024 * 1024, maxFiles = 20000 } = {}) {
    await mkdir(target, { recursive: true });
    const root = await realpath(target);
    let files = 0;
    let bytes = 0;

    for (const entry of this.entries) {
      let rel = safePath(entry.name);
      if (rel === null) throw new ZipError(`Onveilig pad in de ZIP: ${entry.name}`);
      if (isJunk(rel) || entry.isSymlink) continue;
      if (strip) {
        if (!`${rel}/`.startsWith(`${strip}/`)) continue;
        rel = rel.slice(strip.length).replace(/^\/+/, '');
        if (rel === '') continue;
      }
      const dest = path.join(root, rel);
      if (!dest.startsWith(root + path.sep)) throw new ZipError(`Onveilig pad in de ZIP: ${entry.name}`);

      if (entry.isDir) {
        await mkdir(dest, { recursive: true });
        continue;
      }
      if (++files > maxFiles) throw new ZipError('De ZIP bevat te veel bestanden.');
      if (bytes + entry.size > maxBytes) throw new ZipError('De ZIP pakt groter uit dan toegestaan.');

      await mkdir(path.dirname(dest), { recursive: true });
      // Geen symlink onderweg die ons buiten de doelmap brengt.
      const realDir = await realpath(path.dirname(dest));
      if (realDir !== root && !realDir.startsWith(root + path.sep)) throw new ZipError(`Onveilig pad in de ZIP: ${entry.name}`);

      const data = await this.read(entry, maxBytes - bytes);
      await writeFile(dest, data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
      bytes += data.length;
    }
    return { files, bytes };
  }
}

function isUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * De map die als wortel van het pakket geldt: '' als de configuratie in de
 * wortel staat, anders de ene map waar alles in zit.
 */
export function detectRoot(paths) {
  const markers = /^(playwright\.config\.(ts|js|mjs|cjs|mts|cts)|package\.json)$/;
  if (paths.some((p) => markers.test(p))) return '';
  let top = null;
  for (const p of paths) {
    if (!p.includes('/')) return '';
    const first = p.split('/')[0];
    if (top === null) top = first;
    else if (top !== first) return '';
  }
  return top ?? '';
}

// ── Maken ───────────────────────────────────────────────────────────────────

const STORE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.webm', '.mp4', '.zip', '.gz', '.br', '.woff', '.woff2']);

function dosDateTime(date) {
  const d = date < new Date(1980, 0, 1) ? new Date(1980, 0, 1) : date;
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

/**
 * Schrijft een ZIP streamend weg.
 *
 *   const zip = await ZipWriter.create('uit.zip');
 *   await zip.addFile('pad/in/zip.txt', '/echt/bestand.txt');
 *   await zip.finish();
 */
export class ZipWriter {
  static async create(file, { fixedTime = null } = {}) {
    const writer = new ZipWriter();
    writer.out = createWriteStream(file);
    writer.offset = 0;
    writer.entries = [];
    writer.fixedTime = fixedTime;
    return writer;
  }

  async write(buffer) {
    this.offset += buffer.length;
    if (!this.out.write(buffer)) await once(this.out, 'drain');
  }

  async addFile(name, source) {
    const info = await stat(source);
    const compress = !STORE_EXT.has(path.extname(name).toLowerCase()) && info.size > 0;
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const { time, day } = dosDateTime(this.fixedTime ?? info.mtime);
    const headerOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt16LE(nameBuf.length, 26);
    await this.write(header);
    await this.write(nameBuf);

    let crc = 0;
    let size = 0;
    let csize = 0;
    const input = createReadStream(source);
    if (compress) {
      const deflate = zlib.createDeflateRaw({ level: 6 });
      const pump = (async () => {
        for await (const chunk of deflate) {
          csize += chunk.length;
          await this.write(chunk);
        }
      })();
      for await (const chunk of input) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        if (!deflate.write(chunk)) await once(deflate, 'drain');
      }
      deflate.end();
      await pump;
    } else {
      for await (const chunk of input) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        csize += chunk.length;
        await this.write(chunk);
      }
    }
    if (size >= 0xffffffff || this.offset >= 0xffffffff) throw new ZipError('Bestand te groot voor een ZIP zonder ZIP64.');

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(csize, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);

    this.entries.push({ nameBuf, compress, time, day, crc, csize, size, headerOffset, mode: info.mode & 0o777 });
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | 20, 4); // gemaakt op Unix
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(e.compress ? 8 : 0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.day, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(((0o100000 | (e.mode || 0o644)) << 16) >>> 0, 38);
      h.writeUInt32LE(e.headerOffset, 42);
      await this.write(h);
      await this.write(e.nameBuf);
    }
    const cdSize = this.offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.write(end);
    this.out.end();
    await once(this.out, 'close');
  }
}

/**
 * Alle bestanden onder `dir`, als relatieve paden met /, gesorteerd.
 * Symbolische links worden overgeslagen; `skip(rel, isDir)` kan meer weglaten.
 */
export async function listFiles(dir, skip = () => false) {
  const out = [];
  async function walk(current, rel) {
    const items = await readdir(current, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      const full = path.join(current, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!skip(childRel, true)) await walk(full, childRel);
      } else if (info.isFile() && !skip(childRel, false)) {
        out.push(childRel);
      }
    }
  }
  await walk(dir, '');
  return out;
}

/** Zipt een hele map. Geeft het aantal bestanden terug. */
export async function zipDirectory(dir, file, { skip, fixedTime } = {}) {
  const files = await listFiles(dir, skip);
  const zip = await ZipWriter.create(file, { fixedTime });
  for (const rel of files) {
    await zip.addFile(rel, path.join(dir, rel));
  }
  await zip.finish();
  return files.length;
}
