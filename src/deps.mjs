/**
 * Afhankelijkheden van een testpakket installeren, en de browsers.
 *
 * npm install is het duurste deel van een run (tijd én netwerk). Daarom
 * installeren we per unieke combinatie van afhankelijkheden precies één keer:
 * de sleutel is een hash over de afhankelijkheden uit package.json en de
 * lockfile. Een nieuwe versie van de tests met dezelfde afhankelijkheden
 * krijgt de bestaande node_modules via een symbolische link.
 *
 * Browsers staan in een gedeelde map (PLAYWRIGHT_BROWSERS_PATH) en worden per
 * Playwright-versie één keer geïnstalleerd.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dirSize } from './cache.mjs';

/** Velden van package.json die bepalen wát er geïnstalleerd wordt. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'workspaces'];

export function readPackage(dir) {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) throw new Error('package.json ontbreekt in het testpakket.');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`package.json is geen geldige JSON: ${error.message}`);
  }
}

export function lockfileName(dir) {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (existsSync(path.join(dir, name))) return name;
  }
  return null;
}

/** De cachesleutel voor een set afhankelijkheden. */
export function depsKey(pkg, lockText) {
  const relevant = {};
  for (const field of DEP_FIELDS) {
    if (pkg[field] !== undefined) relevant[field] = pkg[field];
  }
  const lock = lockText ? JSON.parse(lockText) : null;
  // In de lockfile staan naam en versie van het pakket zelf; die doen er
  // voor de installatie niet toe.
  if (lock) {
    delete lock.name;
    delete lock.version;
    if (lock.packages?.['']) {
      lock.packages[''] = { ...lock.packages[''] };
      delete lock.packages[''].name;
      delete lock.packages[''].version;
    }
  }
  return createHash('sha256')
    .update(JSON.stringify({
      node: process.versions.node.split('.')[0],
      platform: process.platform,
      arch: process.arch,
      deps: relevant,
      lock,
    }))
    .digest('hex')
    .slice(0, 32);
}

/** Welke versie van Playwright er in een node_modules staat. */
export function playwrightVersion(nodeModules) {
  for (const pkg of ['@playwright/test', 'playwright', 'playwright-core']) {
    const file = path.join(nodeModules, pkg, 'package.json');
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).version ?? '';
      } catch { /* volgende proberen */ }
    }
  }
  return '';
}

/** Het pad naar de Playwright-CLI binnen een testpakket. */
export function playwrightCli(runDir) {
  for (const rel of ['node_modules/@playwright/test/cli.js', 'node_modules/playwright/cli.js']) {
    const file = path.join(runDir, rel);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Draait een opdracht en stuurt de uitvoer regel voor regel naar `onLine`.
 * Wordt na `timeoutMs` of via `signal` afgebroken.
 */
export function runCommand(command, args, { cwd, env, onLine, timeoutMs = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let timedOut = false;
    let aborted = false;
    const tail = [];

    const kill = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* al weg */ }
      setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* al weg */ }
      }, 5000).unref();
    };

    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
    const onAbort = () => { aborted = true; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const feed = (stream) => {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        rest += chunk;
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) {
          tail.push(line);
          if (tail.length > 40) tail.shift();
          onLine?.(line);
        }
      });
      stream.on('end', () => {
        if (rest) {
          tail.push(rest);
          onLine?.(rest);
        }
      });
    };
    feed(child.stdout);
    feed(child.stderr);

    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(Object.assign(new Error('Afgebroken'), { aborted: true }));
      else if (timedOut) reject(new Error(`${path.basename(command)} duurde te lang en is afgebroken.`));
      else if (code !== 0) reject(Object.assign(new Error(`${path.basename(command)} ${args[0] ?? ''} eindigde met code ${code}`), { tail }));
      else resolve({ code, tail });
    });
  });
}

const installing = new Map();

/**
 * Zorgt dat de afhankelijkheden van het pakket in `runDir` klaarstaan.
 *
 * @returns {Promise<{key: string, hit: boolean, playwright: string}>}
 */
export async function ensureDeps({ cache, runDir, onLine, timeoutSec = 900, npmRegistry = '', signal }) {
  const pkg = readPackage(runDir);
  const lockName = lockfileName(runDir);
  const lockText = lockName ? readFileSync(path.join(runDir, lockName), 'utf8') : null;
  const key = depsKey(pkg, lockText);
  cache.acquire(`deps:${key}`);

  let hit = cache.depsReady(key);
  if (!hit) {
    // Twee jobs met dezelfde afhankelijkheden tegelijk: één installeert.
    if (!installing.has(key)) {
      installing.set(key, install({ cache, key, pkg, lockName, lockText, onLine, timeoutSec, npmRegistry, signal }).finally(() => installing.delete(key)));
    } else {
      onLine?.('Dezelfde afhankelijkheden worden al geïnstalleerd voor een andere run; even wachten…');
    }
    await installing.get(key);
    hit = false;
  } else {
    cache.touchDeps(key);
  }

  const target = path.join(cache.depsPath(key), 'node_modules');
  const link = path.join(runDir, 'node_modules');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

  return { key, hit, playwright: cache.depsMeta(key)?.playwright ?? playwrightVersion(target) };
}

async function install({ cache, key, pkg, lockName, lockText, onLine, timeoutSec, npmRegistry, signal }) {
  const tmp = path.join(cache.depsDir, `.tmp-${key}-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try {
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
    if (lockName && lockText) writeFileSync(path.join(tmp, lockName), lockText);

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = lockName
      ? ['ci', '--no-audit', '--no-fund', '--loglevel=warn']
      : ['install', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=warn'];

    const env = {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: tmp,
      LANG: process.env.LANG ?? 'C.UTF-8',
      CI: '1',
      npm_config_cache: cache.npmDir,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      // Browsers regelen we zelf, gedeeld tussen alle pakketten.
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      ...(npmRegistry ? { npm_config_registry: npmRegistry } : {}),
      ...passthroughEnv(),
    };

    onLine?.(`npm ${args.join(' ')}`);
    await runCommand(npm, args, { cwd: tmp, env, onLine, timeoutMs: timeoutSec * 1000, signal });

    const nodeModules = path.join(tmp, 'node_modules');
    if (!existsSync(nodeModules)) throw new Error('npm maakte geen node_modules aan.');
    const now = new Date().toISOString();
    writeFileSync(path.join(tmp, '.complete'), JSON.stringify({
      key,
      created_at: now,
      last_used_at: now,
      playwright: playwrightVersion(nodeModules),
      size: dirSize(tmp),
    }));

    const final = cache.depsPath(key);
    if (existsSync(final)) {
      rmSync(tmp, { recursive: true, force: true });
    } else {
      renameSync(tmp, final);
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

/** Proxy- en certificaatinstellingen van de machine gaan mee. */
export function passthroughEnv() {
  const out = {};
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    if (process.env[key]) out[key] = process.env[key];
  }
  return out;
}

const INSTALLABLE = new Set(['chromium', 'firefox', 'webkit']);

/**
 * Installeert de browsers die een pakket nodig heeft, als dat voor deze
 * Playwright-versie nog niet gebeurd is.
 *
 * @returns {Promise<{installed: string[], skipped: string[]}>}
 */
export async function ensureBrowsers({ runDir, browsers, browsersPath, chromiumPath, onLine, signal }) {
  const cli = playwrightCli(runDir);
  if (!cli) throw new Error('Playwright staat niet in de afhankelijkheden van dit pakket (@playwright/test ontbreekt).');
  const version = playwrightVersion(path.join(runDir, 'node_modules'));
  mkdirSync(browsersPath, { recursive: true });

  const installed = [];
  const skipped = [];
  for (const browser of browsers.length > 0 ? browsers : ['chromium']) {
    if (!INSTALLABLE.has(browser)) {
      // chrome en msedge zijn de echte merkbrowsers: die moet de beheerder
      // zelf op de node zetten (npx playwright install chrome, met root).
      skipped.push(browser);
      continue;
    }
    if (browser === 'chromium' && chromiumPath) {
      skipped.push(browser);
      continue;
    }
    const marker = path.join(browsersPath, `.gjdc-installed-${version}-${browser}`);
    if (existsSync(marker)) continue;

    onLine?.(`Playwright ${version}: ${browser} installeren…`);
    await runCommand(process.execPath, [cli, 'install', browser], {
      cwd: runDir,
      env: {
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? runDir,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        ...passthroughEnv(),
      },
      onLine,
      timeoutMs: 20 * 60 * 1000,
      signal,
    });
    writeFileSync(marker, new Date().toISOString());
    installed.push(browser);
  }
  return { installed, skipped, version };
}
