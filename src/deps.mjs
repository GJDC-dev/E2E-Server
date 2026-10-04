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
export function runCommand(command, args, { cwd, env, onLine, timeoutMs = 0, signal, label = '' } = {}) {
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
      else if (timedOut) reject(Object.assign(new Error(`${label || path.basename(command)} duurde te lang en is afgebroken.`), { timedOut: true, tail }));
      else if (code !== 0) reject(Object.assign(new Error(`${label || `${path.basename(command)} ${args[0] ?? ''}`.trim()} eindigde met code ${code}`), { tail }));
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
 * Een oudere Playwright kent een nieuwere Ubuntu nog niet. Op Ubuntu 26.04
 * zegt Playwright 1.56 bijvoorbeeld "does not support chromium on
 * ubuntu26.04-x64" en downloadt hij niets. De build voor de nieuwste Ubuntu
 * die die versie wél kent, werkt daar gewoon; Playwright kiest hem als
 * PLAYWRIGHT_HOST_PLATFORM_OVERRIDE gezet is. Die keuze wordt per
 * Playwright-versie bewaard, zodat ook de tests zelf hem gebruiken.
 */
const UNSUPPORTED_PLATFORM = /does not support \S+ on (ubuntu\d+\.\d+)-(x64|arm64)/;
const UBUNTU_FALLBACKS = ['24.04', '22.04'];

/**
 * Het systeem waarvoor de browsers geïnstalleerd zijn, zoals
 * "ubuntu-26.04-x64". Na een upgrade van de node kijkt de agent daardoor
 * opnieuw of Playwright het systeem kent.
 */
export function osTag() {
  let id = process.platform;
  let version = '';
  try {
    const release = readFileSync('/etc/os-release', 'utf8');
    id = release.match(/^ID="?([^"\n]*)"?/m)?.[1] || id;
    version = release.match(/^VERSION_ID="?([^"\n]*)"?/m)?.[1] ?? '';
  } catch { /* geen os-release: geen Linux */ }
  return [id, version, process.arch].filter(Boolean).join('-').replace(/[^A-Za-z0-9._-]/g, '_');
}

function platformFile(browsersPath, version) {
  return path.join(browsersPath, `.gjdc-platform-${version}-${osTag()}`);
}

/**
 * Het platform dat Playwright `version` op deze node moet aannemen: wat de
 * beheerder instelde, anders wat de agent eerder voor deze versie koos, en
 * anders niets (Playwright bepaalt het zelf).
 */
export function hostPlatformFor(browsersPath, version, explicit = '') {
  if (explicit) return explicit;
  try {
    return readFileSync(platformFile(browsersPath, version), 'utf8').trim();
  } catch {
    return '';
  }
}

/** De regel uit de uitvoer die zegt wat er misging. */
function failureReason(tail) {
  const lines = (tail ?? []).map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /error|failed|denied|not found|enospc|eacces/i.test(l)) ?? lines.at(-1) ?? '';
  return line.replace(/^(error:\s*)+/i, '');
}

function browserInstallError(error, version, browser) {
  if (error.aborted || error.timedOut) return error;
  const reason = failureReason(error.tail) || error.message;
  return Object.assign(new Error(`Browser ${browser} installeren mislukt (Playwright ${version}): ${reason}`), { tail: error.tail });
}

/**
 * Installeert de browsers die een pakket nodig heeft, als dat voor deze
 * Playwright-versie op dit systeem nog niet gebeurd is.
 *
 * @returns {Promise<{installed: string[], skipped: string[], version: string, hostPlatform: string}>}
 *   `hostPlatform`: het platform dat ook de tests moeten aannemen ('' = geen).
 */
export async function ensureBrowsers({ runDir, browsers, browsersPath, chromiumPath, hostPlatform = '', onLine, signal }) {
  const cli = playwrightCli(runDir);
  if (!cli) throw new Error('Playwright staat niet in de afhankelijkheden van dit pakket (@playwright/test ontbreekt).');
  const version = playwrightVersion(path.join(runDir, 'node_modules'));
  mkdirSync(browsersPath, { recursive: true });

  let platform = hostPlatformFor(browsersPath, version, hostPlatform);
  const install = (browser, override) => runCommand(process.execPath, [cli, 'install', browser], {
    label: `playwright install ${browser}`,
    cwd: runDir,
    env: {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? runDir,
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      ...(override ? { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: override } : {}),
      ...passthroughEnv(),
    },
    onLine,
    timeoutMs: 20 * 60 * 1000,
    signal,
  });

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
    const marker = path.join(browsersPath, `.gjdc-installed-${version}-${browser}-${osTag()}`);
    if (existsSync(marker)) continue;

    onLine?.(`Playwright ${version}: ${browser} installeren…`);
    try {
      await install(browser, platform);
    } catch (error) {
      const unsupported = !platform && UNSUPPORTED_PLATFORM.exec((error.tail ?? []).join('\n'));
      if (!unsupported) throw browserInstallError(error, version, browser);

      // Een nieuwere Ubuntu dan deze Playwright kent: neem de nieuwste die
      // hij wel kent.
      let lastError = error;
      for (const ubuntu of UBUNTU_FALLBACKS) {
        const candidate = `ubuntu${ubuntu}-${unsupported[2]}`;
        onLine?.(`Playwright ${version} kent ${unsupported[1]}-${unsupported[2]} nog niet; de build voor ${candidate} gebruiken…`);
        try {
          await install(browser, candidate);
          platform = candidate;
          writeFileSync(platformFile(browsersPath, version), candidate);
          lastError = null;
          break;
        } catch (retryError) {
          // Kent hij ook deze niet, dan de volgende; bij een andere fout
          // (netwerk, schijf) is dat de melding die telt.
          if (!UNSUPPORTED_PLATFORM.test((retryError.tail ?? []).join('\n'))) {
            lastError = retryError;
            break;
          }
        }
      }
      if (lastError) throw browserInstallError(lastError, version, browser);
    }
    writeFileSync(marker, new Date().toISOString());
    installed.push(browser);
  }
  return { installed, skipped, version, hostPlatform: platform };
}
