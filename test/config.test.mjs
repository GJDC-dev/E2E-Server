import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseEnvFile, validateConfig } from '../src/config.mjs';
import { tmp } from './helpers.mjs';

test('agent.env: commentaar, aanhalingstekens en export', () => {
  const env = parseEnvFile([
    '# commentaar',
    'DASHBOARD_URL=https://testing.gjdc.nl',
    'NODE_NAME="mini 01"',
    "NODE_LABELS='zolder,chromium'",
    'export MAX_JOBS=2',
    'CACHE_MAX_MB=8192 # acht GB',
    'kapot regel',
    '1FOUT=x',
  ].join('\n'));
  assert.deepEqual(env, {
    DASHBOARD_URL: 'https://testing.gjdc.nl',
    NODE_NAME: 'mini 01',
    NODE_LABELS: 'zolder,chromium',
    MAX_JOBS: '2',
    CACHE_MAX_MB: '8192',
  });
});

test('instellingen: bestand, omgeving en grenzen', (t) => {
  // De omgeving van de testmachine mag de uitkomst niet beïnvloeden.
  for (const key of ['PLAYWRIGHT_BROWSERS_PATH', 'DASHBOARD_URL', 'DATA_DIR', 'MAX_JOBS', 'CACHE_MAX_MB', 'NODE_LABELS']) {
    const old = process.env[key];
    delete process.env[key];
    t.after(() => { if (old !== undefined) process.env[key] = old; });
  }
  const dir = tmp();
  const file = path.join(dir, 'agent.env');
  writeFileSync(file, `DASHBOARD_URL=https://testing.gjdc.nl/\nDATA_DIR=${dir}/data\nMAX_JOBS=99\nNODE_LABELS=Zolder, Chromium\n`);
  const config = loadConfig({ configFile: file, overrides: { CACHE_MAX_MB: '10' } });
  assert.equal(config.dashboardUrl, 'https://testing.gjdc.nl', 'afsluitende slash eraf');
  assert.equal(config.maxJobs, 16, 'begrensd');
  assert.equal(config.cacheMaxMb, 256, 'ondergrens');
  assert.deepEqual(config.labels, ['zolder', 'chromium']);
  assert.equal(config.browsersPath, path.join(dir, 'data', 'browsers'));
  assert.deepEqual(validateConfig(config), []);
});

test('instellingen: https verplicht, behalve lokaal', () => {
  const base = loadConfig({ configFile: '/bestaat/niet', overrides: { DASHBOARD_URL: 'http://testing.gjdc.nl', DATA_DIR: tmp() } });
  assert.equal(validateConfig(base).length, 1);
  assert.match(validateConfig(base)[0], /https/);
  assert.deepEqual(validateConfig({ ...base, dashboardUrl: 'http://localhost:8100' }), []);
  assert.deepEqual(validateConfig({ ...base, allowHttp: true }), []);
  assert.equal(validateConfig({ ...base, dashboardUrl: '' }).length, 1);
});
