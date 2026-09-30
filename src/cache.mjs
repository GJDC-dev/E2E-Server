/**
 * De cache van de node. Hier zit de netwerkbesparing:
 *
 *   cache/bundles/<sha256>.zip   testpakketten, op inhoud geadresseerd. Heeft
 *                                de node een pakket ooit gehad, dan staat het
 *                                hier en wordt het niet opnieuw gedownload.
 *   cache/deps/<sleutel>/        geïnstalleerde node_modules, per combinatie
 *                                van package.json-afhankelijkheden en
 *                                lockfile. Nieuwe versie van de tests met
 *                                dezelfde afhankelijkheden? Geen npm install.
 *   cache/npm/                   de downloadcache van npm zelf.
 *   browsers/                    Playwright-browsers, één keer per versie.
 *
 * Wat de node in zijn cache heeft, meldt hij bij elke heartbeat (als het
 * veranderd is). Zo ziet het dashboard per node welke versie er staat.
 *
 * Is de cache voller dan CACHE_MAX_MB, dan gaat eerst weg wat het langst niet
 * gebruikt is — nooit iets dat nu in gebruik is of dat het dashboard als
 * actieve versie opgeeft.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from './http.mjs';

export class Cache {
  constructor(dataDir, maxBytes) {
    this.dir = path.join(dataDir, 'cache');
    this.bundleDir = path.join(this.dir, 'bundles');
    this.depsDir = path.join(this.dir, 'deps');
    this.npmDir = path.join(this.dir, 'npm');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.maxBytes = maxBytes;
    this.indexFile = path.join(this.bundleDir, 'index.json');
    for (const dir of [this.bundleDir, this.depsDir, this.npmDir, this.tmpDir]) {
      mkdirSync(dir, { recursive: true });
    }
    this.index = this.loadIndex();
    this.inUse = new Map(); // sleutel -> aantal gebruikers
  }

  loadIndex() {
    let index = {};
    try {
      index = JSON.parse(readFileSync(this.indexFile, 'utf8')) ?? {};
    } catch {
      index = {};
    }
    // De index volgt de bestanden, niet andersom.
    for (const file of readdirSync(this.bundleDir)) {
      const match = file.match(/^([0-9a-f]{64})\.zip$/);
      if (match && !index[match[1]]) {
        const s = statSync(path.join(this.bundleDir, file));
        index[match[1]] = { size: s.size, cached_at: s.mtime.toISOString(), last_used_at: s.mtime.toISOString() };
      }
    }
    for (const sha of Object.keys(index)) {
      if (!existsSync(this.bundlePath(sha))) delete index[sha];
    }
    return index;
  }

  saveIndex() {
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.index, null, 1));
    renameSync(tmp, this.indexFile);
  }

  bundlePath(sha) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('Ongeldige sha256');
    return path.join(this.bundleDir, `${sha}.zip`);
  }

  hasBundle(sha, size) {
    const entry = this.index[sha];
    if (!entry || !existsSync(this.bundlePath(sha))) return false;
    return size === undefined || statSync(this.bundlePath(sha)).size === size;
  }

  /** Controleert of een pakket in de cache nog heel is (sha256 opnieuw berekenen). */
  async verifyBundle(sha) {
    try {
      return (await sha256File(this.bundlePath(sha))) === sha;
    } catch {
      return false;
    }
  }

  /** Zet een gedownload en gecontroleerd bestand in de cache. */
  addBundle(sha, file, meta = {}) {
    renameSync(file, this.bundlePath(sha));
    const now = new Date().toISOString();
    this.index[sha] = { size: statSync(this.bundlePath(sha)).size, cached_at: now, last_used_at: now, ...meta };
    this.saveIndex();
  }

  touchBundle(sha, meta = {}) {
    if (!this.index[sha]) return;
    Object.assign(this.index[sha], meta, { last_used_at: new Date().toISOString() });
    this.saveIndex();
  }

  removeBundle(sha) {
    rmSync(this.bundlePath(sha), { force: true });
    rmSync(`${this.bundlePath(sha)}.part`, { force: true });
    delete this.index[sha];
    this.saveIndex();
  }

  /** Wat in de heartbeat meegaat. */
  inventory() {
    const items = Object.entries(this.index)
      .map(([sha256, e]) => ({ sha256, size: e.size, cached_at: e.cached_at, last_used_at: e.last_used_at }))
      .sort((a, b) => a.sha256.localeCompare(b.sha256));
    const rev = createHash('sha1').update(items.map((i) => `${i.sha256}:${i.size}`).join('\n')).digest('hex');
    return { rev, items, bytes: this.totalBytes(), limit: this.maxBytes };
  }

  // ── Afhankelijkheden ──────────────────────────────────────────────────────

  depsPath(key) {
    return path.join(this.depsDir, key);
  }

  depsReady(key) {
    return existsSync(path.join(this.depsPath(key), '.complete'));
  }

  depsMeta(key) {
    try {
      return JSON.parse(readFileSync(path.join(this.depsPath(key), '.complete'), 'utf8'));
    } catch {
      return null;
    }
  }

  touchDeps(key) {
    const meta = this.depsMeta(key);
    if (!meta) return;
    meta.last_used_at = new Date().toISOString();
    writeFileSync(path.join(this.depsPath(key), '.complete'), JSON.stringify(meta));
  }

  /** De Playwright-versies waarvoor al afhankelijkheden klaarstaan. */
  playwrightVersions() {
    const out = [];
    for (const key of safeReaddir(this.depsDir)) {
      const meta = this.depsMeta(key);
      if (meta?.playwright) out.push(meta.playwright);
    }
    return out;
  }

  // ── In gebruik ────────────────────────────────────────────────────────────

  acquire(key) {
    this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
  }

  release(key) {
    const n = (this.inUse.get(key) ?? 1) - 1;
    if (n <= 0) this.inUse.delete(key);
    else this.inUse.set(key, n);
  }

  // ── Ruimte ────────────────────────────────────────────────────────────────

  totalBytes() {
    let total = 0;
    for (const e of Object.values(this.index)) total += e.size ?? 0;
    for (const key of safeReaddir(this.depsDir)) {
      total += this.depsMeta(key)?.size ?? 0;
    }
    return total;
  }

  /**
   * Ruimt op tot de cache onder de limiet zit. `keep` zijn sha256's die het
   * dashboard als actieve versie opgaf.
   *
   * @returns {string[]} beschrijving van wat er weg is
   */
  evict({ keep = [], maxBytes = this.maxBytes, all = false } = {}) {
    const removed = [];
    const keepSet = new Set(keep);
    const candidates = [];

    for (const [sha, e] of Object.entries(this.index)) {
      if (this.inUse.has(sha) || (!all && keepSet.has(sha))) continue;
      candidates.push({ kind: 'bundle', key: sha, size: e.size ?? 0, used: Date.parse(e.last_used_at ?? e.cached_at ?? 0) || 0 });
    }
    for (const key of safeReaddir(this.depsDir)) {
      if (key.startsWith('.')) continue;
      const meta = this.depsMeta(key);
      if (!meta) {
        // Half geïnstalleerd en niet in gebruik: altijd weg.
        if (!this.inUse.has(`deps:${key}`)) rmSync(this.depsPath(key), { recursive: true, force: true });
        continue;
      }
      if (this.inUse.has(`deps:${key}`)) continue;
      candidates.push({ kind: 'deps', key, size: meta.size ?? 0, used: Date.parse(meta.last_used_at ?? meta.created_at ?? 0) || 0 });
    }

    candidates.sort((a, b) => a.used - b.used);
    let total = this.totalBytes();
    for (const c of candidates) {
      if (!all && total <= maxBytes) break;
      if (c.kind === 'bundle') {
        this.removeBundle(c.key);
        removed.push(`testpakket ${c.key.slice(0, 12)}`);
      } else {
        rmSync(this.depsPath(c.key), { recursive: true, force: true });
        removed.push(`afhankelijkheden ${c.key.slice(0, 12)}`);
      }
      total -= c.size;
    }
    return removed;
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Grootte van een map in bytes (voor de deps-cache, eenmalig na installatie). */
export function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let items;
    try {
      items = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) {
        try { total += statSync(full).size; } catch { /* weg tijdens het tellen */ }
      }
    }
  }
  return total;
}
