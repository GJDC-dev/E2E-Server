/**
 * Instellingen van de node.
 *
 * Komen uit /etc/gjdc-e2e-server/agent.env (of --config <bestand>), met
 * omgevingsvariabelen daar bovenop. Alles heeft een verstandige standaard
 * behalve het adres van het dashboard.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = '/etc/gjdc-e2e-server/agent.env';

/** Leest KEY=waarde-regels; # is commentaar, aanhalingstekens mogen. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim().replace(/^export\s+/, '');
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'ja'].includes(String(value).toLowerCase());
}

/**
 * @param {{ configFile?: string, overrides?: Record<string, string> }} options
 */
export function loadConfig(options = {}) {
  const file = options.configFile ?? process.env.E2E_SERVER_CONFIG ?? DEFAULT_CONFIG_FILE;
  let fromFile = {};
  let fileLoaded = null;
  if (file && existsSync(file)) {
    try {
      fromFile = parseEnvFile(readFileSync(file, 'utf8'));
      fileLoaded = file;
    } catch (error) {
      throw new Error(`Kan ${file} niet lezen: ${error.message}`);
    }
  }

  const get = (key) => options.overrides?.[key] ?? process.env[key] ?? fromFile[key];

  const dataDir = path.resolve(get('DATA_DIR') || (process.getuid?.() === 0 || existsSync('/var/lib/gjdc-e2e-server')
    ? '/var/lib/gjdc-e2e-server'
    : path.join(os.homedir(), '.gjdc-e2e-server')));

  const dashboardUrl = String(get('DASHBOARD_URL') ?? '').trim().replace(/\/+$/, '');

  return {
    file: fileLoaded,
    dashboardUrl,
    nodeName: String(get('NODE_NAME') ?? '').trim(),
    labels: String(get('NODE_LABELS') ?? '').split(/[,\s]+/).map((l) => l.trim().toLowerCase()).filter(Boolean),
    maxJobs: int(get('MAX_JOBS'), 1, 1, 16),
    dataDir,
    cacheMaxMb: int(get('CACHE_MAX_MB'), 4096, 256, 1048576),
    browsersPath: path.resolve(get('PLAYWRIGHT_BROWSERS_PATH') || path.join(dataDir, 'browsers')),
    chromiumPath: String(get('E2E_CHROMIUM_PATH') ?? '').trim(),
    keepRuns: int(get('KEEP_RUNS'), 3, 0, 100),
    logLevel: String(get('LOG_LEVEL') ?? 'info').toLowerCase(),
    allowHttp: bool(get('ALLOW_HTTP')),
    npmRegistry: String(get('NPM_REGISTRY') ?? '').trim(),
    shutdownGrace: int(get('SHUTDOWN_GRACE'), 20, 0, 3600),
    installTimeout: int(get('INSTALL_TIMEOUT'), 900, 60, 7200),
    enrollmentToken: String(get('ENROLLMENT_TOKEN') ?? '').trim(),
  };
}

/** Controleert wat er minimaal moet kloppen voordat de agent kan starten. */
export function validateConfig(config) {
  const problems = [];
  if (!config.dashboardUrl) {
    problems.push(`DASHBOARD_URL ontbreekt. Zet hem in ${config.file ?? DEFAULT_CONFIG_FILE}, bijvoorbeeld DASHBOARD_URL=https://testing.gjdc.nl`);
  } else {
    let url;
    try {
      url = new URL(config.dashboardUrl);
    } catch {
      problems.push(`DASHBOARD_URL "${config.dashboardUrl}" is geen geldig adres.`);
    }
    if (url && url.protocol !== 'https:' && !config.allowHttp && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      problems.push('DASHBOARD_URL moet https gebruiken: over http gaan het token van de node en de geheimen van de tests onversleuteld over het netwerk. (Alleen voor lokaal testen: ALLOW_HTTP=1.)');
    }
  }
  return problems;
}
