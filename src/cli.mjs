/**
 * De opdrachtregel van de E2E-Server.
 */

import { existsSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Agent, register } from './agent.mjs';
import { buildBundle, checkZip } from './bundle.mjs';
import { Cache } from './cache.mjs';
import { loadConfig, validateConfig, DEFAULT_CONFIG_FILE } from './config.mjs';
import { Api, ApiError, AGENT_VERSION } from './http.mjs';
import { log, setLogLevel } from './log.mjs';
import { fmtBytes } from './runner.mjs';
import { State } from './state.mjs';
import { diskInfo, installedBrowsers } from './system.mjs';

const HELP = `GJDC E2E-Server ${AGENT_VERSION} — de software op de testnodes

Gebruik: e2e-server <opdracht> [opties]

  run                     de agent starten (dit draait systemd)
  register                de node aanmelden bij het dashboard
      --url <adres>         adres van het dashboard (anders DASHBOARD_URL)
      --token <token>       registratietoken uit het dashboard (Nodes → Node toevoegen)
      --name <naam>         naam in het dashboard (standaard de hostnaam)
      --labels <a,b>        labels, bijvoorbeeld "zolder,snel"
      --force               ook als de node al aangemeld is
  status                  instellingen, aanmelding en verbinding
  doctor                  alles nalopen wat een run nodig heeft
  bundle <map> [-o zip]   een testpakket (ZIP) maken van een map met tests
  check-zip <bestand>     een bestaande ZIP nakijken zoals het dashboard dat doet
  cache [list|clear]      de cache bekijken of leegmaken
  version                 versie tonen

Algemene opties:
  --config <bestand>      instellingen (standaard ${DEFAULT_CONFIG_FILE})
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') {
      args.output = argv[++i];
    } else if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'help';

  if (command === 'help' || args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'version' || args.version) {
    process.stdout.write(`${AGENT_VERSION}\n`);
    return 0;
  }
  if (command === 'bundle') return cmdBundle(args);
  if (command === 'check-zip') return cmdCheckZip(args);

  const overrides = {};
  if (typeof args.url === 'string') overrides.DASHBOARD_URL = args.url;
  if (typeof args.name === 'string') overrides.NODE_NAME = args.name;
  if (typeof args.labels === 'string') overrides.NODE_LABELS = args.labels;
  if (typeof args['data-dir'] === 'string') overrides.DATA_DIR = args['data-dir'];
  const config = loadConfig({ configFile: typeof args.config === 'string' ? args.config : undefined, overrides });
  setLogLevel(config.logLevel);

  switch (command) {
    case 'run': {
      const problems = validateConfig(config);
      if (problems.length > 0) {
        for (const p of problems) log.error(p);
        return 78; // EX_CONFIG: systemd start dan niet eindeloos opnieuw
      }
      await new Agent(config).start();
      return 0;
    }
    case 'register':
      return cmdRegister(config, args);
    case 'status':
      return cmdStatus(config, args);
    case 'doctor':
      return cmdDoctor(config);
    case 'cache':
      return cmdCache(config, args);
    default:
      process.stderr.write(`Onbekende opdracht "${command}".\n\n${HELP}`);
      return 2;
  }
}

async function cmdRegister(config, args) {
  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const p of problems) log.error(p);
    return 78;
  }
  const token = typeof args.token === 'string' ? args.token : config.enrollmentToken;
  if (!token) {
    log.error('Geef een registratietoken mee: --token gjdcreg_… (maak er een in het dashboard onder Nodes → Node toevoegen).');
    return 2;
  }
  const state = new State(config.dataDir);
  if (state.registered && !args.force) {
    log.error(`Deze node is al aangemeld (node ${state.nodeId} bij ${state.dashboardUrl}). Gebruik --force om opnieuw aan te melden.`);
    return 1;
  }
  const api = new Api(config.dashboardUrl, () => '');
  try {
    await register(config, state, api, { token, name: config.nodeName, labels: config.labels });
    return 0;
  } catch (error) {
    log.error(`Aanmelden mislukt: ${error.message}`);
    return 1;
  }
}

async function ping(config, state) {
  const api = new Api(config.dashboardUrl, () => state.token);
  const started = Date.now();
  const result = await api.get('api/agent/ping', { timeout: 15000 });
  const latency = Date.now() - started;
  const skew = result.server_time ? Math.round((Date.now() - latency / 2 - Date.parse(result.server_time)) / 1000) : null;
  return { ...result, latency, skew };
}

async function cmdStatus(config, args) {
  const state = new State(config.dataDir);
  const cache = new Cache(config.dataDir, config.cacheMaxMb * 1024 * 1024);
  const inventory = cache.inventory();
  const out = {
    version: AGENT_VERSION,
    config_file: config.file,
    dashboard: config.dashboardUrl,
    data_dir: config.dataDir,
    node: state.registered ? { id: state.nodeId, name: state.data.name, status: state.data.status } : null,
    cache: { bundles: inventory.items.length, bytes: inventory.bytes, limit: cache.maxBytes },
    connection: null,
  };
  if (state.registered && config.dashboardUrl) {
    try {
      out.connection = await ping(config, state);
    } catch (error) {
      out.connection = { error: error.message };
    }
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const line = (k, v) => process.stdout.write(`  ${k.padEnd(14)} ${v}\n`);
  process.stdout.write(`GJDC E2E-Server ${AGENT_VERSION}\n\n`);
  line('Instellingen', config.file ?? '(geen bestand, alleen omgevingsvariabelen)');
  line('Dashboard', config.dashboardUrl || '(DASHBOARD_URL ontbreekt)');
  line('Data', config.dataDir);
  line('Node', out.node ? `${out.node.name} (id ${out.node.id}, ${out.node.status})` : 'nog niet aangemeld');
  line('Cache', `${inventory.items.length} testpakketten, ${fmtBytes(inventory.bytes)} van ${fmtBytes(cache.maxBytes)}`);
  if (out.connection?.error) line('Verbinding', `✗ ${out.connection.error}`);
  else if (out.connection) line('Verbinding', `✓ dashboard ${out.connection.version}, ${out.connection.latency} ms${out.connection.skew !== null ? `, klokverschil ${out.connection.skew} s` : ''}`);
  return 0;
}

async function cmdDoctor(config) {
  let failed = 0;
  const check = (ok, label, help = '') => {
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}${!ok && help ? `\n      ${help}` : ''}\n`);
    if (!ok) failed++;
  };
  process.stdout.write(`GJDC E2E-Server ${AGENT_VERSION} — controle\n\n`);

  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 20, `Node.js ${process.versions.node}`, 'Installeer Node.js 20 of nieuwer.');

  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8' });
  check(npm.status === 0, `npm ${npm.stdout?.trim() ?? ''}`, 'npm ontbreekt; dat is nodig om de afhankelijkheden van testpakketten te installeren.');

  const problems = validateConfig(config);
  check(problems.length === 0, 'Instellingen', problems.join(' '));

  let writable = true;
  try {
    accessSync(config.dataDir, constants.W_OK);
  } catch {
    writable = false;
  }
  check(writable, `Datamap ${config.dataDir} is schrijfbaar`, 'Maak de map aan en geef de gebruiker van de agent schrijfrechten.');

  const disk = diskInfo(existsSync(config.dataDir) ? config.dataDir : os.homedir());
  check(disk.free === null || disk.free > 2 * 1024 ** 3, `Vrije schijfruimte: ${fmtBytes(disk.free)}`, 'Minder dan 2 GB vrij. Browsers en afhankelijkheden hebben ruimte nodig.');

  const state = new State(config.dataDir);
  check(state.registered, state.registered ? `Aangemeld als node ${state.nodeId}` : 'Aangemeld bij het dashboard', 'Draai e2e-server register --url … --token ….');

  if (state.registered && problems.length === 0) {
    try {
      const result = await ping(config, state);
      check(true, `Dashboard bereikbaar (${result.latency} ms), node "${result.node.name}" is ${result.node.status}`);
      if (result.skew !== null) check(Math.abs(result.skew) < 30, `Klok loopt gelijk met het dashboard (${result.skew} s verschil)`, 'Zet tijdsynchronisatie aan: sudo timedatectl set-ntp true');
    } catch (error) {
      check(false, 'Dashboard bereikbaar', error instanceof ApiError && error.status === 401 ? 'Het token wordt niet (meer) geaccepteerd; meld opnieuw aan met --force.' : error.message);
    }
  }

  const browsers = installedBrowsers(config.browsersPath);
  check(true, browsers.length > 0 ? `Browsers in ${config.browsersPath}: ${browsers.join(', ')}` : `Nog geen browsers in ${config.browsersPath} (worden bij de eerste run geïnstalleerd)`);

  // Kan Chromium hier echt starten? Alleen te proberen als er al een
  // installatie van Playwright in de cache staat.
  const depsDir = path.join(config.dataDir, 'cache', 'deps');
  const deps = existsSync(depsDir) ? readdirSync(depsDir).filter((d) => !d.startsWith('.')) : [];
  const withCore = deps.map((d) => path.join(depsDir, d, 'node_modules', 'playwright-core')).find((p) => existsSync(p));
  if (withCore && browsers.some((b) => b.startsWith('chromium'))) {
    const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(withCore)}).chromium.launch(${config.chromiumPath ? JSON.stringify({ executablePath: config.chromiumPath }) : ''}).then(b => b.close()).then(() => process.exit(0), e => { console.error(e.message.split('\\n')[0]); process.exit(1); })`], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: config.browsersPath },
      encoding: 'utf8',
      timeout: 60000,
    });
    check(probe.status === 0, 'Chromium start', `${probe.stderr?.trim() ?? ''} — ontbreken systeembibliotheken? sudo npx playwright install-deps chromium`);
  }

  process.stdout.write(`\n${failed === 0 ? 'Alles in orde.' : `${failed} punt(en) om op te lossen.`}\n`);
  return failed === 0 ? 0 : 1;
}

async function cmdCache(config, args) {
  const cache = new Cache(config.dataDir, config.cacheMaxMb * 1024 * 1024);
  if (args._[1] === 'clear') {
    const removed = cache.evict({ all: true });
    process.stdout.write(`${removed.length} onderdelen verwijderd.\n`);
    return 0;
  }
  const inventory = cache.inventory();
  process.stdout.write(`Testpakketten (${inventory.items.length}):\n`);
  for (const item of inventory.items) {
    const meta = cache.index[item.sha256] ?? {};
    process.stdout.write(`  ${item.sha256.slice(0, 12)}  ${String(meta.suite ?? '?').padEnd(24)} v${String(meta.version ?? '?').padEnd(4)} ${fmtBytes(item.size).padStart(9)}  laatst ${item.last_used_at ?? '?'}\n`);
  }
  const depsDir = cache.depsDir;
  const deps = existsSync(depsDir) ? readdirSync(depsDir).filter((d) => !d.startsWith('.')) : [];
  process.stdout.write(`\nAfhankelijkheden (${deps.length}):\n`);
  for (const key of deps) {
    const meta = cache.depsMeta(key);
    process.stdout.write(`  ${key.slice(0, 12)}  Playwright ${String(meta?.playwright ?? '?').padEnd(10)} ${fmtBytes(meta?.size ?? 0).padStart(9)}  laatst ${meta?.last_used_at ?? '?'}\n`);
  }
  process.stdout.write(`\nTotaal ${fmtBytes(inventory.bytes)} van ${fmtBytes(cache.maxBytes)}.\n`);
  return 0;
}

function printInspection(result) {
  for (const e of result.errors) process.stdout.write(`  ✗ ${e}\n`);
  for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
  const i = result.info;
  process.stdout.write(`\n  Configuratie   ${i.config || '—'}\n  Tests          ${i.specs} spec-bestand(en)\n  Playwright     ${i.playwright || '—'}\n  Lockfile       ${i.lockfile ? 'ja' : 'nee'}\n`);
  if (i.manifest?.name) process.stdout.write(`  e2e.json       ${i.manifest.name}${i.manifest.slug ? ` (${i.manifest.slug})` : ''}\n`);
}

async function cmdBundle(args) {
  const dir = args._[1];
  if (!dir) {
    process.stderr.write('Gebruik: e2e-server bundle <map> [-o bestand.zip]\n');
    return 2;
  }
  const result = await buildBundle(dir, args.output);
  printInspection(result);
  if (!result.output) {
    process.stdout.write('\nGeen ZIP gemaakt: los eerst de fouten hierboven op.\n');
    return 1;
  }
  process.stdout.write(`\n✓ ${result.output}\n  ${fmtBytes(result.size)} · ${result.info.files} bestanden · sha256 ${result.sha256}\n\nUpload deze ZIP in het dashboard bij Testpakketten.\n`);
  return 0;
}

async function cmdCheckZip(args) {
  const file = args._[1];
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    process.stderr.write('Gebruik: e2e-server check-zip <bestand.zip>\n');
    return 2;
  }
  const result = await checkZip(file);
  printInspection(result);
  process.stdout.write(`\n  sha256         ${result.sha256}\n  Grootte        ${fmtBytes(result.size)}${result.info.root ? `\n  Wortel         ${result.info.root}/` : ''}\n\n${result.errors.length === 0 ? '✓ Klaar om te uploaden.' : '✗ Niet goed: los de fouten hierboven op.'}\n`);
  return result.errors.length === 0 ? 0 : 1;
}
