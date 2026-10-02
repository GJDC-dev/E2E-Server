import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildBundle, checkZip, inspect } from '../src/bundle.mjs';
import { tmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('inspect: verplichte bestanden en wat er niet in hoort', () => {
  const files = { 'package.json': '{"devDependencies":{"@playwright/test":"1.56.1"}}' };
  const read = (p) => files[p];
  let r = inspect(['package.json', 'playwright.config.ts', 'tests/a.spec.ts'], read);
  assert.deepEqual(r.errors, []);
  assert.equal(r.info.specs, 1);
  r = inspect(['tests/a.spec.ts', 'node_modules/x/i.js', '.env', '.env.example'], read);
  assert.equal(r.errors.length, 4, r.errors.join(' | '));
});

test('het voorbeeldpakket wordt een geldige, reproduceerbare ZIP', async () => {
  const dir = tmp();
  const src = path.join(here, '..', 'examples', 'voorbeeld');
  const a = await buildBundle(src, path.join(dir, 'a.zip'));
  const b = await buildBundle(src, path.join(dir, 'b.zip'));
  assert.equal(a.sha256, b.sha256);
  const check = await checkZip(path.join(dir, 'a.zip'));
  assert.deepEqual(check.errors, []);
});
