import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ensureBrowsers, hostPlatformFor } from '../src/deps.mjs';
import { JobRunner } from '../src/runner.mjs';
import { tmp } from './helpers.mjs';

/**
 * Een nagebootste Playwright-CLI: kent alleen de platforms in `known`, doet
 * alsof de node `host` draait, en schrijft elke aanroep op.
 */
function fakePackage({ host, known }) {
  const dir = tmp();
  const runDir = path.join(dir, 'run');
  const pw = path.join(runDir, 'node_modules', '@playwright', 'test');
  mkdirSync(pw, { recursive: true });
  writeFileSync(path.join(pw, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.56.1' }));
  writeFileSync(path.join(pw, 'host'), host);
  writeFileSync(path.join(pw, 'known'), known.join(','));
  writeFileSync(path.join(pw, 'calls'), '');
  writeFileSync(path.join(pw, 'cli.js'), `
const fs = require('fs');
const path = require('path');
const [command, browser] = process.argv.slice(2);
const host = fs.readFileSync(path.join(__dirname, 'host'), 'utf8');
const known = fs.readFileSync(path.join(__dirname, 'known'), 'utf8').split(',');
const override = process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE || '';
fs.appendFileSync(path.join(__dirname, 'calls'), command + ' ' + browser + ' ' + (override || '-') + '\\n');
if (host === 'offline') {
  console.log('Failed to install browsers');
  console.log('Error: getaddrinfo ENOTFOUND cdn.playwright.dev');
  process.exit(1);
}
const platform = override || host;
if (!known.includes(platform)) {
  console.log('Failed to install browsers');
  console.log('Error: ERROR: Playwright does not support ' + browser + ' on ' + platform);
  process.exit(1);
}
`);
  const calls = () => readFileSync(path.join(pw, 'calls'), 'utf8').trim().split('\n').filter(Boolean);
  return { runDir, browsersPath: path.join(dir, 'browsers'), calls };
}

test('browsers: een Ubuntu die Playwright nog niet kent krijgt de build van de nieuwste die hij wel kent', async () => {
  const pkg = fakePackage({ host: 'ubuntu26.04-x64', known: ['ubuntu22.04-x64', 'ubuntu24.04-x64'] });
  const lines = [];
  const first = await ensureBrowsers({ runDir: pkg.runDir, browsers: ['chromium'], browsersPath: pkg.browsersPath, chromiumPath: '', onLine: (l) => lines.push(l) });
  assert.deepEqual(first.installed, ['chromium']);
  assert.equal(first.hostPlatform, 'ubuntu24.04-x64');
  assert.deepEqual(pkg.calls(), ['install chromium -', 'install chromium ubuntu24.04-x64']);
  assert.ok(lines.some((l) => l.includes('kent ubuntu26.04-x64 nog niet')), 'de uitvoer zegt waarom');
  assert.equal(hostPlatformFor(pkg.browsersPath, '1.56.1'), 'ubuntu24.04-x64', 'de keuze is bewaard voor de tests en doctor');

  // De volgende run: niets installeren, wel dezelfde keuze.
  const second = await ensureBrowsers({ runDir: pkg.runDir, browsers: ['chromium'], browsersPath: pkg.browsersPath, chromiumPath: '' });
  assert.deepEqual(second.installed, []);
  assert.equal(second.hostPlatform, 'ubuntu24.04-x64');
  assert.equal(pkg.calls().length, 2);
});

test('browsers: kent hij ook 24.04 niet, dan 22.04', async () => {
  const pkg = fakePackage({ host: 'ubuntu26.04-arm64', known: ['ubuntu22.04-arm64'] });
  const result = await ensureBrowsers({ runDir: pkg.runDir, browsers: ['chromium'], browsersPath: pkg.browsersPath, chromiumPath: '' });
  assert.equal(result.hostPlatform, 'ubuntu22.04-arm64');
  assert.deepEqual(pkg.calls(), ['install chromium -', 'install chromium ubuntu24.04-arm64', 'install chromium ubuntu22.04-arm64']);
});

test('browsers: geen enkele bekende Ubuntu: de oorspronkelijke melding van Playwright', async () => {
  const pkg = fakePackage({ host: 'ubuntu26.04-x64', known: [] });
  await assert.rejects(
    ensureBrowsers({ runDir: pkg.runDir, browsers: ['chromium'], browsersPath: pkg.browsersPath, chromiumPath: '' }),
    { message: 'Browser chromium installeren mislukt (Playwright 1.56.1): Playwright does not support chromium on ubuntu26.04-x64' },
  );
  assert.equal(hostPlatformFor(pkg.browsersPath, '1.56.1'), '', 'niets bewaard');
});

test('browsers: een andere fout geeft een duidelijke melding, zonder terugval', async () => {
  const pkg = fakePackage({ host: 'offline', known: ['ubuntu24.04-x64'] });
  await assert.rejects(
    ensureBrowsers({ runDir: pkg.runDir, browsers: ['chromium'], browsersPath: pkg.browsersPath, chromiumPath: '' }),
    { message: 'Browser chromium installeren mislukt (Playwright 1.56.1): getaddrinfo ENOTFOUND cdn.playwright.dev' },
  );
  assert.deepEqual(pkg.calls(), ['install chromium -']);
});

test('browsers: wat de beheerder instelt (PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) wint', async () => {
  const pkg = fakePackage({ host: 'ubuntu26.04-x64', known: ['ubuntu22.04-x64', 'ubuntu24.04-x64'] });
  const result = await ensureBrowsers({ runDir: pkg.runDir, browsers: ['chromium'], browsersPath: pkg.browsersPath, chromiumPath: '', hostPlatform: 'ubuntu22.04-x64' });
  assert.equal(result.hostPlatform, 'ubuntu22.04-x64');
  assert.deepEqual(pkg.calls(), ['install chromium ubuntu22.04-x64']);
  assert.equal(hostPlatformFor(pkg.browsersPath, '1.56.1'), '', 'een instelling wordt niet als eigen keuze bewaard');
});

test('browsers: een ondersteund systeem krijgt geen terugval', async () => {
  const pkg = fakePackage({ host: 'ubuntu24.04-x64', known: ['ubuntu24.04-x64'] });
  const result = await ensureBrowsers({ runDir: pkg.runDir, browsers: ['chromium'], browsersPath: pkg.browsersPath, chromiumPath: '' });
  assert.equal(result.hostPlatform, '');
  assert.deepEqual(pkg.calls(), ['install chromium -']);
});

test('browsers: de tests krijgen hetzelfde platform als de installatie, en een pakket kan dat niet overschrijven', () => {
  const dataDir = tmp();
  const runner = new JobRunner({
    spec: { id: 7, run_id: 3, suite: { slug: 'x', name: 'X' }, env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'mac15', EIGEN: 'ja' } },
    config: { dataDir, browsersPath: path.join(dataDir, 'browsers'), chromiumPath: '' },
    nodeName: 'test',
  });
  runner.hostPlatform = 'ubuntu24.04-x64';
  const env = runner.buildEnv();
  assert.equal(env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, 'ubuntu24.04-x64');
  assert.equal(env.EIGEN, 'ja', 'gewone variabelen van het pakket komen er wel door');

  runner.hostPlatform = '';
  assert.equal(runner.buildEnv().PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, undefined, 'zonder keuze bepaalt Playwright het zelf');
});
