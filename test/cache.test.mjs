import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Cache } from '../src/cache.mjs';
import { depsKey } from '../src/deps.mjs';
import { tmp } from './helpers.mjs';

function addFake(cache, dir, content, usedAt) {
  const file = path.join(dir, `${Math.random()}.zip`);
  writeFileSync(file, content);
  const sha = createHash('sha256').update(content).digest('hex');
  cache.addBundle(sha, file);
  cache.index[sha].last_used_at = new Date(usedAt).toISOString();
  cache.saveIndex();
  return sha;
}

test('cache: herkent wat er al is, ook na een herstart', () => {
  const dir = tmp();
  const cache = new Cache(dir, 1024 * 1024);
  const sha = addFake(cache, dir, 'pakket-1', Date.now());
  assert.ok(cache.hasBundle(sha));
  assert.ok(cache.hasBundle(sha, 8));
  assert.ok(!cache.hasBundle(sha, 9), 'andere grootte = niet hetzelfde');
  const again = new Cache(dir, 1024 * 1024);
  assert.ok(again.hasBundle(sha), 'index overleeft een herstart');
  const inv = again.inventory();
  assert.equal(inv.items.length, 1);
  assert.equal(inv.rev, cache.inventory().rev, 'zelfde inhoud, zelfde rev (geen onnodige update naar het dashboard)');
});

test('cache: ruimt het langst ongebruikte op, maar niet wat in gebruik of actief is', () => {
  const dir = tmp();
  // Limiet 30: vier pakketten van 10 bytes passen niet, drie wel.
  const cache = new Cache(dir, 30);
  const oud = addFake(cache, dir, 'a'.repeat(10), Date.now() - 3000);
  const actief = addFake(cache, dir, 'b'.repeat(10), Date.now() - 2000);
  const bezig = addFake(cache, dir, 'c'.repeat(10), Date.now() - 1000);
  const nieuw = addFake(cache, dir, 'd'.repeat(10), Date.now());
  cache.acquire(bezig);
  const removed = cache.evict({ keep: [actief] });
  assert.equal(removed.length, 1);
  assert.ok(!cache.hasBundle(oud), 'oudste weg');
  assert.ok(cache.hasBundle(actief) && cache.hasBundle(bezig) && cache.hasBundle(nieuw));
  cache.release(bezig);
  cache.evict({ all: true });
  assert.equal(cache.inventory().items.length, 0);
});

test('cache: half geïnstalleerde afhankelijkheden gaan altijd weg', () => {
  const dir = tmp();
  const cache = new Cache(dir, 1024);
  mkdirSync(path.join(cache.depsDir, 'halfaf', 'node_modules'), { recursive: true });
  cache.evict({});
  assert.ok(!cache.depsReady('halfaf'));
  utimesSync(dir, new Date(), new Date());
});

test('afhankelijkheden: zelfde pakketlijst = zelfde sleutel', () => {
  const pkg = { name: 'a', version: '1.0.0', devDependencies: { '@playwright/test': '1.56.1' } };
  const lock = { name: 'a', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'a', version: '1.0.0', devDependencies: { '@playwright/test': '1.56.1' } } } };
  const k1 = depsKey(pkg, JSON.stringify(lock));
  const k2 = depsKey({ ...pkg, name: 'b', version: '2.0.0', scripts: { test: 'x' } }, JSON.stringify({ ...lock, name: 'b', version: '2.0.0', packages: { '': { ...lock.packages[''], name: 'b', version: '2.0.0' } } }));
  assert.equal(k1, k2, 'naam, versie en scripts doen er niet toe');
  const k3 = depsKey({ ...pkg, devDependencies: { '@playwright/test': '1.57.0' } }, null);
  assert.notEqual(k1, k3);
  assert.match(k1, /^[0-9a-f]{32}$/);
});
