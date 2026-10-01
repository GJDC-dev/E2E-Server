/**
 * Een testpakket (ZIP) maken en nakijken, met dezelfde regels als het
 * dashboard bij het uploaden hanteert. Zo weet je vóór het uploaden al of
 * het goed is.
 *
 *   e2e-server bundle ./mijn-tests            → mijn-tests.zip
 *   e2e-server check-zip mijn-tests.zip
 *
 * De ZIP is reproduceerbaar: vaste volgorde en vaste tijdstempels. Dezelfde
 * inhoud geeft dus dezelfde sha256, en het dashboard (en elke node) herkent
 * hem als al bekend.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from './http.mjs';
import { ZipReader, detectRoot, isJunk, listFiles, safePath, zipDirectory } from './zip.mjs';

const CONFIG_FILES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'playwright.config.mts', 'playwright.config.cts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'blob-report', '.artifacts', '.cache', '.idea', '.vscode']);
const FIXED_TIME = new Date(2020, 0, 1, 0, 0, 0);

function isEnvFile(base) {
  return /^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|dist|template)$/.test(base);
}

/**
 * Kijkt een lijst paden plus de inhoud van package.json/e2e.json na.
 * @returns {{errors: string[], warnings: string[], info: object}}
 */
export function inspect(paths, readText) {
  const errors = [];
  const warnings = [];
  const info = { config: '', specs: 0, files: paths.length, playwright: '', lockfile: false, manifest: null };

  for (const p of paths) {
    const segments = p.split('/');
    const base = segments.at(-1);
    if (segments.includes('node_modules')) errors.push('Er zit node_modules in. Laat die weg: de node installeert de afhankelijkheden zelf.');
    if (segments.includes('.git')) errors.push('Er zit een .git-map in. Laat die weg.');
    if (isEnvFile(base)) errors.push(`"${p}" hoort er niet in: geheimen zet je als (geheime) variabele in het dashboard.`);
    if (/\.(spec|test)\.(c|m)?[jt]sx?$/.test(p)) info.specs++;
  }

  info.config = CONFIG_FILES.find((f) => paths.includes(f)) ?? '';
  if (!info.config) errors.push('Geen playwright.config.ts (of .js/.mjs/.cjs) in de wortel.');

  if (!paths.includes('package.json')) {
    errors.push('Geen package.json. Die is nodig zodat de node weet welke versie van @playwright/test hij moet installeren.');
  } else {
    try {
      const pkg = JSON.parse(readText('package.json'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      info.playwright = deps['@playwright/test'] ?? deps.playwright ?? '';
      if (!info.playwright) errors.push('package.json noemt @playwright/test niet.');
    } catch (error) {
      errors.push(`package.json is geen geldige JSON: ${error.message}`);
    }
  }

  info.lockfile = paths.includes('package-lock.json') || paths.includes('npm-shrinkwrap.json');
  if (!info.lockfile) warnings.push('Geen package-lock.json: maak er een met "npm install --package-lock-only". Met lockfile draait elke run met dezelfde versies en hergebruikt de node zijn cache.');
  if (info.specs === 0) warnings.push('Geen *.spec.ts of *.test.ts gevonden.');

  if (paths.includes('e2e.json')) {
    try {
      info.manifest = JSON.parse(readText('e2e.json'));
      if (info.manifest.slug && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(info.manifest.slug)) {
        errors.push('e2e.json: "slug" mag alleen kleine letters, cijfers en streepjes bevatten.');
      }
    } catch (error) {
      errors.push(`e2e.json is geen geldige JSON: ${error.message}`);
    }
  } else {
    warnings.push('Geen e2e.json. Niet verplicht, maar daarmee weet het dashboard naam, adres en welke variabelen de tests nodig hebben.');
  }

  return { errors: [...new Set(errors)], warnings, info };
}

/** Maakt een ZIP van een map met tests. */
export async function buildBundle(dir, output) {
  const root = path.resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${dir} is geen map.`);

  const skip = (rel, isDir) => {
    const base = rel.split('/').at(-1);
    if (isDir) return SKIP_DIRS.has(base);
    return isJunk(rel) || isEnvFile(base) || base.endsWith('.zip');
  };
  const files = await listFiles(root, skip);
  const result = inspect(files, (p) => readFileSync(path.join(root, p), 'utf8'));
  if (result.errors.length > 0) return { ...result, output: null };

  const out = path.resolve(output ?? `${path.basename(root)}.zip`);
  if (out.startsWith(root + path.sep)) throw new Error('Zet de ZIP buiten de map die je inpakt.');
  await zipDirectory(root, out, { skip, fixedTime: FIXED_TIME });
  return { ...result, output: out, size: statSync(out).size, sha256: await sha256File(out) };
}

/** Kijkt een bestaande ZIP na. */
export async function checkZip(file) {
  const zip = await ZipReader.open(file);
  try {
    const all = [];
    const errors = [];
    for (const entry of zip.entries) {
      const p = safePath(entry.name);
      if (p === null) {
        errors.push(`Onveilig pad in de ZIP: ${entry.name}`);
        continue;
      }
      if (isJunk(p) || entry.isDir) continue;
      if (entry.isSymlink) errors.push(`"${p}" is een symbolische link; die worden niet uitgepakt.`);
      if (entry.encrypted) errors.push(`"${p}" is versleuteld.`);
      if (entry.method !== 0 && entry.method !== 8) errors.push(`"${p}" gebruikt een compressie die niet ondersteund wordt.`);
      all.push(p);
    }
    const root = detectRoot(all);
    const rel = root ? all.filter((p) => p.startsWith(`${root}/`)).map((p) => p.slice(root.length + 1)) : all;
    const byRel = new Map(zip.entries.map((e) => {
      const p = safePath(e.name);
      return [root && p?.startsWith(`${root}/`) ? p.slice(root.length + 1) : p, e];
    }));
    const texts = {};
    for (const name of ['package.json', 'e2e.json']) {
      const entry = byRel.get(name);
      if (entry) texts[name] = (await zip.read(entry, 1024 * 1024)).toString('utf8');
    }
    const result = inspect(rel, (p) => texts[p] ?? '');
    result.errors.unshift(...errors);
    result.info.root = root;
    return { ...result, size: statSync(file).size, sha256: await sha256File(file) };
  } finally {
    await zip.close();
  }
}
