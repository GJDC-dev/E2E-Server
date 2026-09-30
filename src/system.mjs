/**
 * Wat er met de machine zelf aan de hand is: CPU, geheugen, schijf, netwerk,
 * temperatuur, en een vaste beschrijving (OS, processor, versies).
 *
 * Linux eerst (dat draait op de mini-pc's): /proc en /sys geven de eerlijkste
 * cijfers. Op andere systemen vallen we terug op wat Node zelf weet, zodat de
 * agent ook op een laptop te proberen is.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ── CPU ─────────────────────────────────────────────────────────────────────

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// ── Geheugen ────────────────────────────────────────────────────────────────

export function memoryInfo() {
  const meminfo = read('/proc/meminfo');
  if (meminfo) {
    const kb = (key) => {
      const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return match ? Number(match[1]) * 1024 : null;
    };
    const total = kb('MemTotal');
    const available = kb('MemAvailable') ?? kb('MemFree');
    const swapTotal = kb('SwapTotal') ?? 0;
    const swapFree = kb('SwapFree') ?? 0;
    if (total) {
      return {
        mem: { total, used: total - (available ?? 0), available },
        swap: { total: swapTotal, used: Math.max(0, swapTotal - swapFree) },
      };
    }
  }
  const total = os.totalmem();
  const free = os.freemem();
  return { mem: { total, used: total - free, available: free }, swap: { total: 0, used: 0 } };
}

// ── Schijf ──────────────────────────────────────────────────────────────────

export function diskInfo(dir) {
  try {
    const s = statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    return { path: dir, total, used, free };
  } catch {
    return { path: dir, total: null, used: null, free: null };
  }
}

// ── Netwerk ─────────────────────────────────────────────────────────────────

const VIRTUAL_IF = /^(lo|docker|veth|br-|virbr|vmnet|tailscale|zt|wg|tun|tap)/;

function netCounters() {
  const text = read('/proc/net/dev');
  if (!text) return null;
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    if (VIRTUAL_IF.test(name.trim())) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    rx += fields[0] || 0;
    tx += fields[8] || 0;
  }
  return { rx, tx };
}

// ── Temperatuur ─────────────────────────────────────────────────────────────

const CPU_SENSOR = /(x86_pkg_temp|coretemp|k10temp|zenpower|cpu[_-]?thermal|soc[_-]?thermal|acpitz|cpu)/i;

export function temperature() {
  const readings = [];
  const thermal = '/sys/class/thermal';
  if (existsSync(thermal)) {
    for (const zone of safeReaddir(thermal).filter((z) => z.startsWith('thermal_zone'))) {
      const type = read(path.join(thermal, zone, 'type'))?.trim() ?? '';
      const temp = Number(read(path.join(thermal, zone, 'temp')));
      if (Number.isFinite(temp) && temp > 0) readings.push({ type, value: temp / 1000 });
    }
  }
  const hwmon = '/sys/class/hwmon';
  if (existsSync(hwmon)) {
    for (const mon of safeReaddir(hwmon)) {
      const name = read(path.join(hwmon, mon, 'name'))?.trim() ?? '';
      for (const file of safeReaddir(path.join(hwmon, mon)).filter((f) => /^temp\d+_input$/.test(f))) {
        const temp = Number(read(path.join(hwmon, mon, file)));
        if (Number.isFinite(temp) && temp > 0) readings.push({ type: name, value: temp / 1000 });
      }
    }
  }
  const cpu = readings.filter((r) => CPU_SENSOR.test(r.type));
  const pick = cpu.length > 0 ? cpu : readings;
  if (pick.length === 0) return null;
  return Math.round(Math.max(...pick.map((r) => r.value)) * 10) / 10;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── Metingen over tijd ──────────────────────────────────────────────────────

/**
 * Houdt de vorige meting bij, zodat CPU en netwerk als percentage en snelheid
 * over de laatste periode gerapporteerd worden in plaats van sinds het opstarten.
 */
export class MetricsSampler {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.lastCpu = cpuTimes();
    this.lastNet = netCounters();
    this.lastAt = Date.now();
  }

  sample() {
    const now = Date.now();
    const cpu = cpuTimes();
    const dTotal = cpu.total - this.lastCpu.total;
    const dIdle = cpu.idle - this.lastCpu.idle;
    const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : null;

    const net = netCounters();
    const seconds = Math.max(0.001, (now - this.lastAt) / 1000);
    let rx = null;
    let tx = null;
    if (net && this.lastNet) {
      rx = Math.max(0, Math.round((net.rx - this.lastNet.rx) / seconds));
      tx = Math.max(0, Math.round((net.tx - this.lastNet.tx) / seconds));
    }

    this.lastCpu = cpu;
    this.lastNet = net;
    this.lastAt = now;

    const { mem, swap } = memoryInfo();
    return {
      cpu: cpuPct === null ? null : Math.round(cpuPct * 10) / 10,
      cores: os.cpus().length,
      load: os.loadavg().map((l) => Math.round(l * 100) / 100),
      mem,
      swap,
      disk: diskInfo(this.dataDir),
      net: { rx_bps: rx, tx_bps: tx },
      temp: temperature(),
      uptime: Math.round(os.uptime()),
    };
  }
}

// ── Vaste beschrijving ──────────────────────────────────────────────────────

let npmVersion = null;

async function detectNpmVersion() {
  if (npmVersion !== null) return npmVersion;
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { timeout: 15000 });
    npmVersion = stdout.trim();
  } catch {
    npmVersion = '';
  }
  return npmVersion;
}

function osName() {
  const release = read('/etc/os-release');
  if (release) {
    const match = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (match) return match[1];
  }
  return `${os.type()} ${os.release()}`;
}

function ipAddresses() {
  const out = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const a of addresses ?? []) {
      if (!a.internal && !a.address.startsWith('fe80')) out.push(a.address);
    }
  }
  return out;
}

/** Welke browsers er in de gedeelde browsermap staan (chromium-1194, ...). */
export function installedBrowsers(browsersPath) {
  return safeReaddir(browsersPath)
    .filter((d) => /^(chromium|chromium_headless_shell|chromium-tip-of-tree|firefox|webkit|ffmpeg)-\d+$/.test(d))
    .sort();
}

/**
 * @param {{dataDir: string, browsersPath: string, startedAt: Date, playwrightVersions: string[]}} options
 */
export async function systemInfo({ dataDir, browsersPath, startedAt, playwrightVersions = [] }) {
  const cpus = os.cpus();
  const info = {
    hostname: os.hostname(),
    os: osName(),
    kernel: os.release(),
    arch: os.arch(),
    platform: os.platform(),
    cpu_model: (cpus[0]?.model ?? '').replace(/\s+/g, ' ').trim(),
    cpu_cores: cpus.length,
    mem_total: memoryInfo().mem.total,
    node_version: process.version,
    npm_version: await detectNpmVersion(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    data_dir: dataDir,
    ips: ipAddresses(),
    browsers: installedBrowsers(browsersPath),
    playwright: [...new Set(playwrightVersions)].sort(),
    boot_time: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    started_at: startedAt.toISOString(),
  };
  // Alleen wat echt verandert telt mee voor de revisie; de opstarttijd van
  // de machine schommelt met een seconde per meting.
  const { boot_time, ...stable } = info;
  const rev = createHash('sha1').update(JSON.stringify(stable)).digest('hex');
  return { info, rev };
}
