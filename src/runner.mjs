/**
 * Eén job draaien: van "het dashboard wijst me werk toe" tot "resultaat
 * ingestuurd".
 *
 *   1. accepteren          het dashboard weet dat we eraan beginnen
 *   2. testpakket          uit de cache, of downloaden + sha256 controleren
 *   3. uitpakken           in een verse map per job
 *   4. afhankelijkheden    uit de cache, of npm ci (één keer per lockfile)
 *   5. browsers            één keer per Playwright-versie
 *   6. tests draaien       Playwright, met live uitvoer en resultaten
 *   7. rapport             bij een mislukte run (of altijd) inpakken en uploaden
 *   8. afronden            eindstatus en tellingen naar het dashboard
 *
 * Tussendoor stuurt de runner elke ~1,5 s nieuwe logregels, voortgang en
 * testresultaten in één verzoek. In het antwoord staat of de run moet
 * stoppen (geannuleerd in het dashboard).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, sleep } from './http.mjs';
import { ensureBrowsers, ensureDeps, passthroughEnv, playwrightCli } from './deps.mjs';
import { LineSplitter, Redactor } from './redact.mjs';
import { ZipReader, detectRoot, isJunk, safePath, zipDirectory } from './zip.mjs';
import { log } from './log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_REPORTER = path.join(HERE, '..', 'reporter', 'agent-reporter.cjs');
const STATUS_REPORTER = path.join(HERE, '..', 'reporter', 'status-reporter.cjs');

/** Omgevingsvariabelen die een testpakket niet mag zetten. */
const BLOCKED_ENV = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_HTML_REPORT',
  'PLAYWRIGHT_HTML_OPEN', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', 'CI', 'FORCE_COLOR',
]);

const MAX_PENDING_LOG = 4 * 1024 * 1024;
const MAX_CHUNK = 256 * 1024;

class Cancelled extends Error {}

const cyan = (s) => `\u001b[36m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;

export class JobRunner {
  /**
   * @param {object} deps
   * @param {object} deps.spec     de job zoals het dashboard hem stuurde
   * @param {import('./http.mjs').Api} deps.api
   * @param {import('./cache.mjs').Cache} deps.cache
   * @param {object} deps.config
   * @param {() => object} deps.settings  actuele instellingen uit de heartbeat
   * @param {(e: object) => void} deps.event  gebeurtenis voor de tijdlijn
   * @param {string} deps.nodeName
   */
  constructor({ spec, api, cache, config, settings, event, nodeName }) {
    this.spec = spec;
    this.id = spec.id;
    this.api = api;
    this.cache = cache;
    this.config = config;
    this.settings = settings;
    this.event = event;
    this.nodeName = nodeName;

    this.phase = 'preparing';
    this.message = '';
    this.progress = { total: null, done: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
    this.meta = {};
    this.startedAt = Date.now();

    this.runDir = path.join(config.dataDir, 'runs', String(this.id));
    this.workDir = path.join(this.runDir, '.e2e');

    this.buffer = '';
    this.pending = []; // brokken met een vast seq-nummer, tot het dashboard ze heeft
    this.seq = 0;
    this.tests = [];
    this.dirty = true;
    this.flushing = null;
    this.logTruncated = false;

    this.cancelRequested = false;
    this.cancelReason = '';
    this.timedOut = false;
    this.abort = new AbortController();
    this.child = null;
    this.lastLines = [];
    this.globalErrors = [];
    this.endStatus = null;
    this.acquired = [];

    // Geheimen komen nooit in de logs: alle waarden van geheime variabelen
    // worden weggepoetst voordat een regel de node verlaat.
    const secretValues = (spec.secrets ?? []).map((name) => spec.env?.[name]).filter(Boolean);
    this.redactor = new Redactor(secretValues);
  }

  get summary() {
    return {
      id: this.id,
      phase: this.phase,
      tests_total: this.progress.total,
      tests_done: this.progress.done,
      passed: this.progress.passed,
      failed: this.progress.failed,
    };
  }

  // ── Log ──────────────────────────────────────────────────────────────────

  write(text) {
    const clean = this.redactor.redact(text);
    this.buffer += clean;
    this.dirty = true;
    try {
      appendFileSync(path.join(this.workDir, 'output.log'), clean);
    } catch { /* de map is er nog niet */ }
    // Te veel ongestuurd (dashboard lang weg): het oudste deel laten vallen.
    if (this.buffer.length > MAX_PENDING_LOG) {
      this.buffer = `${dim('[… eerdere uitvoer overgeslagen: het dashboard was een tijd niet bereikbaar; alles staat in output.log op de node …]')}\n${this.buffer.slice(-MAX_PENDING_LOG / 2)}`;
    }
  }

  line(text) {
    this.write(`${text}\n`);
  }

  /** Een regel van de agent zelf, herkenbaar tussen de uitvoer van Playwright. */
  say(text) {
    this.line(`${cyan('▸')} ${text}`);
  }

  setPhase(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.dirty = true;
  }

  // ── Naar het dashboard ───────────────────────────────────────────────────

  takeChunks() {
    while (this.buffer.length > 0) {
      let cut = this.buffer.length;
      if (cut > MAX_CHUNK) {
        const nl = this.buffer.lastIndexOf('\n', MAX_CHUNK);
        cut = nl > 0 ? nl + 1 : MAX_CHUNK;
      }
      this.pending.push({ seq: ++this.seq, ts: new Date().toISOString(), text: this.buffer.slice(0, cut) });
      this.buffer = this.buffer.slice(cut);
    }
  }

  payload() {
    this.takeChunks();
    return {
      phase: this.phase,
      message: this.message,
      progress: this.progress,
      meta: this.meta,
      logs: this.pending.slice(0, 40),
      tests: this.tests.slice(0, 500),
    };
  }

  /** Stuurt wat er is; één verzoek tegelijk. */
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.dirty && this.buffer === '' && this.pending.length === 0 && this.tests.length === 0) return undefined;

    this.flushing = (async () => {
      const body = this.payload();
      const sentLogs = body.logs.length;
      const sentTests = body.tests.length;
      this.dirty = false;
      try {
        const result = await this.api.post(`api/agent/jobs/${this.id}/update`, body, { timeout: 30000 });
        this.pending.splice(0, sentLogs);
        this.tests.splice(0, sentTests);
        if (result?.log_truncated) this.logTruncated = true;
        if (result?.cancel && !this.cancelRequested) {
          this.cancel('Geannuleerd in het dashboard');
        }
      } catch (error) {
        this.dirty = true;
        if (error instanceof ApiError && error.code === 'job_gone') {
          this.cancel('De run bestaat niet meer in het dashboard');
        } else {
          log.debug(`job ${this.id}: bijwerken mislukt`, error);
        }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  startFlusher() {
    const tick = async () => {
      await this.flush();
      if (!this.stopped) this.flushTimer = setTimeout(tick, this.settings().log_flush_ms ?? 1500);
    };
    this.flushTimer = setTimeout(tick, 300);
  }

  stopFlusher() {
    this.stopped = true;
    clearTimeout(this.flushTimer);
  }

  // ── Annuleren ────────────────────────────────────────────────────────────

  /**
   * Breekt de job af. Met requeue (de agent stopt voor een herstart of
   * update) vraagt hij het dashboard de job opnieuw in te plannen in plaats
   * van hem als geannuleerd te boeken.
   */
  cancel(reason, { requeue = false } = {}) {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    this.cancelReason = reason;
    this.requeue = requeue;
    this.say(red(`Afbreken: ${reason}`));
    this.abort.abort();
    this.killChild();
  }

  killChild() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const signal = (sig) => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* al weg */ }
    };
    signal('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) signal('SIGKILL');
    }, 10000).unref();
  }

  checkCancelled() {
    if (this.cancelRequested) throw new Cancelled(this.cancelReason);
  }

  // ── Verloop ──────────────────────────────────────────────────────────────

  /**
   * Draait de job helemaal. Geeft nooit een fout; alles eindigt in een
   * eindstatus die naar het dashboard gaat.
   */
  async run() {
    if (!(await this.accept())) return 'rejected';

    mkdirSync(this.workDir, { recursive: true });
    this.startFlusher();

    let status = 'error';
    let error = '';
    let exitCode = null;

    try {
      this.say(`Run #${this.spec.run_id} · ${this.spec.suite.name} v${this.spec.bundle.version}${this.spec.shard ? ` · shard ${this.spec.shard.index}/${this.spec.shard.total}` : ''} · node ${this.nodeName}`);
      for (const warning of this.spec.warnings ?? []) this.say(red(warning));
      await this.prepare();
      this.checkCancelled();
      ({ status, error, exitCode } = await this.runTests());
    } catch (err) {
      if (err instanceof Cancelled || this.cancelRequested) {
        status = 'cancelled';
        error = this.cancelReason || 'Geannuleerd';
      } else {
        status = 'error';
        error = err.message;
        this.say(red(`Fout: ${err.message}`));
        if (err.tail?.length) this.line(dim(err.tail.slice(-15).join('\n')));
      }
    }

    try {
      await this.uploadArtifacts(status);
    } catch (err) {
      this.say(red(`Rapport uploaden mislukt: ${err.message}`));
    }

    this.stopFlusher();
    await this.finish(status, error, exitCode);
    this.cleanup();
    return status;
  }

  async accept() {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await this.api.post(`api/agent/jobs/${this.id}/accept`, {});
        return true;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 409 || error.status === 403 || error.status === 404)) {
          log.info(`Job ${this.id} is niet meer beschikbaar: ${error.message}`);
          return false;
        }
        if (attempt === 4) {
          log.warn(`Job ${this.id} kon niet bevestigd worden`, error);
          return false;
        }
        await sleep(1000 * 2 ** attempt);
      }
    }
    return false;
  }

  async prepare() {
    const { bundle } = this.spec;

    // Testpakket: uit de cache of downloaden.
    this.setPhase('downloading');
    const sha = bundle.sha256;
    this.cache.acquire(sha);
    this.acquired.push(sha);
    let fromCache = false;
    if (this.cache.hasBundle(sha, bundle.size)) {
      this.setPhase('verifying');
      fromCache = await this.cache.verifyBundle(sha);
      if (!fromCache) {
        this.say('Het pakket in de cache is beschadigd; opnieuw downloaden.');
        this.cache.removeBundle(sha);
      }
    }
    if (fromCache) {
      this.meta.cache_hit = true;
      this.meta.download_bytes = 0;
      this.say(`Testpakket v${bundle.version} staat al in de cache (${fmtBytes(bundle.size)}, sha256 ${sha.slice(0, 12)}…) — niets gedownload.`);
      this.cache.touchBundle(sha, { suite: this.spec.suite.slug, version: bundle.version });
      this.event({ type: 'bundle.cached', level: 'info', job_id: this.id, message: `${this.spec.suite.name} v${bundle.version} uit de cache gebruikt (geen download)` });
    } else {
      this.say(`Testpakket v${bundle.version} downloaden (${fmtBytes(bundle.size)})…`);
      const started = Date.now();
      const tmp = path.join(this.cache.tmpDir, `${sha}.zip`);
      let bytes = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          bytes = await this.api.download(bundle.url.replace(/^\//, ''), tmp, { sha256: sha, size: bundle.size });
          break;
        } catch (error) {
          this.checkCancelled();
          if (attempt >= 4 || (error instanceof ApiError && !error.retryable && error.code !== 'incomplete')) throw error;
          this.say(`Download mislukt (${error.message}); opnieuw over ${2 ** attempt} s…`);
          await sleep(1000 * 2 ** attempt, this.abort.signal);
        }
      }
      this.cache.addBundle(sha, tmp, { suite: this.spec.suite.slug, version: bundle.version });
      this.meta.cache_hit = false;
      this.meta.download_bytes = bytes;
      this.say(`Gedownload en sha256 gecontroleerd in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
      this.event({ type: 'bundle.downloaded', level: 'info', job_id: this.id, message: `${this.spec.suite.name} v${bundle.version} gedownload (${fmtBytes(bytes)})` });
    }
    this.checkCancelled();

    // Uitpakken in een verse map.
    this.setPhase('extracting');
    for (const item of existsSync(this.runDir) ? readdirSync(this.runDir) : []) {
      if (item !== '.e2e') rmSync(path.join(this.runDir, item), { recursive: true, force: true });
    }
    const zip = await ZipReader.open(this.cache.bundlePath(sha));
    try {
      // Zit alles in één bovenmap, dan is die de wortel. Het dashboard heeft
      // dat bij het uploaden al bepaald; anders doen we het zelf.
      const filePaths = zip.entries.filter((e) => !e.isDir).map((e) => safePath(e.name)).filter((p) => p && !isJunk(p));
      const root = typeof bundle.root === 'string' ? bundle.root : detectRoot(filePaths);
      const { files } = await zip.extractTo(this.runDir, { strip: root });
      this.say(`${files} bestanden uitgepakt.`);
    } finally {
      await zip.close();
    }
    this.checkCancelled();

    // Afhankelijkheden.
    this.setPhase('installing');
    const deps = await ensureDeps({
      cache: this.cache,
      runDir: this.runDir,
      timeoutSec: this.config.installTimeout,
      npmRegistry: this.config.npmRegistry,
      signal: this.abort.signal,
      onLine: (l) => this.line(dim(`  npm │ ${l}`)),
    });
    this.acquired.push(`deps:${deps.key}`);
    this.meta.deps_cache_hit = deps.hit;
    this.meta.playwright = deps.playwright;
    if (deps.hit) {
      this.say(`Afhankelijkheden uit de cache (Playwright ${deps.playwright || '?'}) — geen npm install nodig.`);
    } else {
      this.say(`Afhankelijkheden geïnstalleerd en bewaard voor volgende runs (Playwright ${deps.playwright || '?'}).`);
      this.event({ type: 'deps.installed', level: 'info', job_id: this.id, message: `Afhankelijkheden voor ${this.spec.suite.name} geïnstalleerd (Playwright ${deps.playwright})` });
    }
    this.checkCancelled();

    // Browsers.
    this.setPhase('browsers');
    const browsers = await ensureBrowsers({
      runDir: this.runDir,
      browsers: this.spec.browsers ?? ['chromium'],
      browsersPath: this.config.browsersPath,
      chromiumPath: this.config.chromiumPath,
      signal: this.abort.signal,
      onLine: (l) => this.line(dim(`  browsers │ ${l}`)),
    });
    if (browsers.installed.length > 0) {
      this.say(`Browsers geïnstalleerd: ${browsers.installed.join(', ')}.`);
      this.event({ type: 'browsers.installed', level: 'info', job_id: this.id, message: `${browsers.installed.join(', ')} geïnstalleerd voor Playwright ${browsers.version}` });
    }
    for (const skipped of browsers.skipped) {
      if (skipped !== 'chromium') this.say(`${skipped} wordt niet automatisch geïnstalleerd; zorg dat hij op deze node staat.`);
    }
  }

  buildArgs() {
    const o = this.spec.options ?? {};
    const reporters = ['list', AGENT_REPORTER];
    if (this.spec.artifacts !== 'never') reporters.push('html');
    const env = this.spec.env ?? {};
    if (env.GJDC_STATUS_URL && env.GJDC_STATUS_TOKEN) reporters.push(STATUS_REPORTER);

    const args = ['test', `--reporter=${reporters.join(',')}`];
    if (o.grep) args.push('--grep', String(o.grep));
    if (o.grepInvert) args.push('--grep-invert', String(o.grepInvert));
    for (const project of [].concat(o.project ?? [])) args.push('--project', String(project));
    if (o.workers !== undefined) args.push('--workers', String(o.workers));
    if (o.retries !== undefined) args.push('--retries', String(o.retries));
    if (o.repeatEach !== undefined && Number(o.repeatEach) > 1) args.push('--repeat-each', String(o.repeatEach));
    if (o.maxFailures !== undefined && Number(o.maxFailures) > 0) args.push('--max-failures', String(o.maxFailures));
    if (o.testTimeout !== undefined) args.push('--timeout', String(o.testTimeout));
    if (o.shard) args.push(`--shard=${o.shard}`);
    for (const file of o.files ?? []) {
      if (/^[A-Za-z0-9_./@-]+(:\d+)?$/.test(file) && !file.includes('..')) args.push(file);
    }
    return args;
  }

  buildEnv() {
    const home = path.join(this.workDir, 'home');
    const tmp = path.join(this.workDir, 'tmp');
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });

    const env = {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      TMPDIR: tmp,
      LANG: process.env.LANG ?? 'C.UTF-8',
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
      CI: '1',
      FORCE_COLOR: '1',
      PLAYWRIGHT_BROWSERS_PATH: this.config.browsersPath,
      PLAYWRIGHT_HTML_OPEN: 'never',
      PW_TEST_HTML_REPORT_OPEN: 'never',
      PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(this.workDir, 'report'),
      PLAYWRIGHT_HTML_REPORT: path.join(this.workDir, 'report'),
      E2E_AGENT_EVENTS: path.join(this.workDir, 'events.ndjson'),
      E2E_NODE_NAME: this.nodeName,
      ...(this.config.chromiumPath ? { E2E_CHROMIUM_PATH: this.config.chromiumPath } : {}),
      ...passthroughEnv(),
    };

    for (const [key, value] of Object.entries(this.spec.env ?? {})) {
      const upper = key.toUpperCase();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || BLOCKED_ENV.has(upper) || upper.startsWith('E2E_AGENT_') || upper.startsWith('NPM_CONFIG_')) continue;
      env[key] = String(value);
    }

    // Voor de reporter van status.gjdc.nl, als die meedoet.
    if (env.GJDC_STATUS_URL && env.GJDC_STATUS_TOKEN) {
      env.GJDC_STATUS_SUITE ??= this.spec.suite.slug;
      env.GJDC_STATUS_RUNNER ??= this.nodeName;
      env.GJDC_STATUS_REPORT_URL ??= this.spec.run_url ?? '';
      env.GJDC_STATUS_RUN_ID ??= String(this.spec.run_id);
    }
    return env;
  }

  async runTests() {
    this.setPhase('running');
    const cli = playwrightCli(this.runDir);
    if (!cli) throw new Error('Playwright staat niet in de afhankelijkheden van dit pakket.');

    const args = this.buildArgs();
    const eventsFile = path.join(this.workDir, 'events.ndjson');
    writeFileSync(eventsFile, '');
    rmSync(path.join(this.workDir, 'report'), { recursive: true, force: true });

    const visibleArgs = args.map((a) => (a.startsWith('--reporter=') ? '--reporter=…' : a)).join(' ');
    this.say(`playwright ${visibleArgs}${this.spec.base_url ? ` · E2E_BASE_URL=${this.spec.base_url}` : ''}`);
    this.line('');

    const child = spawn(process.execPath, [cli, ...args], {
      cwd: this.runDir,
      env: this.buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;

    // Tijdslimiet over de hele job, gerekend vanaf het oppakken.
    const limitMs = Math.max(60000, (this.spec.timeout_minutes ?? 30) * 60000 - (Date.now() - this.startedAt));
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.say(red(`Tijdslimiet van ${this.spec.timeout_minutes} minuten bereikt; de run wordt afgebroken.`));
      this.killChild();
    }, limitMs);

    // Per stroom in hele regels, zodat het wegpoetsen van geheimen nooit
    // een half geheim over twee stukken mist.
    const splitters = [];
    const onOutput = (stream) => {
      const splitter = new LineSplitter((text) => {
        this.write(text);
        for (const l of text.split(/\r?\n|\r/)) {
          if (l.trim() === '') continue;
          this.lastLines.push(this.redactor.redact(l));
          if (this.lastLines.length > 30) this.lastLines.shift();
        }
      });
      splitters.push(splitter);
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => splitter.push(chunk));
    };
    onOutput(child.stdout);
    onOutput(child.stderr);

    // De reporter schrijft gebeurtenissen weg; hier lezen we ze mee.
    let offset = 0;
    let rest = '';
    const readEvents = () => {
      let fd;
      try {
        const size = statSync(eventsFile).size;
        if (size <= offset) return;
        fd = openSync(eventsFile, 'r');
        const buffer = Buffer.alloc(size - offset);
        readSync(fd, buffer, 0, buffer.length, offset);
        offset = size;
        rest += buffer.toString('utf8');
      } catch {
        return;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) {
        if (!l) continue;
        try {
          this.onEvent(JSON.parse(l));
        } catch { /* halve regel of rommel */ }
      }
    };
    const poll = setInterval(readEvents, 400);

    const exitCode = await new Promise((resolve) => {
      child.on('error', (error) => {
        this.globalErrors.push(error.message);
        resolve(null);
      });
      child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : null)));
    });
    clearTimeout(timer);
    clearInterval(poll);
    for (const splitter of splitters) splitter.end();
    readEvents();
    this.child = null;

    this.line('');
    const p = this.progress;
    let status;
    let error = '';

    if (this.cancelRequested) {
      status = 'cancelled';
      error = this.cancelReason;
    } else if (this.timedOut) {
      status = 'timeout';
      error = `De run duurde langer dan ${this.spec.timeout_minutes} minuten.`;
    } else if (this.endStatus === 'timedout') {
      status = 'timeout';
      error = 'De globale time-out uit de Playwright-configuratie is bereikt.';
    } else if (p.failed > 0 || (this.endStatus === 'failed' && p.done > 0)) {
      status = 'failed';
    } else if (this.endStatus === 'passed' && exitCode === 0) {
      status = p.total === 0 && p.done === 0 ? 'error' : 'passed';
      if (status === 'error') error = 'Er zijn geen tests gevonden.';
    } else {
      status = 'error';
      error = this.globalErrors[0]
        ?? (this.endStatus === null ? `Playwright stopte onverwacht (exitcode ${exitCode}).` : `Playwright eindigde met status "${this.endStatus}" (exitcode ${exitCode}).`);
      const tail = this.lastLines.slice(-6).join(' ⏎ ');
      if (tail && !this.globalErrors.length) error += ` Laatste uitvoer: ${tail}`;
    }

    const summary = `${p.passed} geslaagd, ${p.failed} mislukt${p.flaky ? `, ${p.flaky} flaky` : ''}${p.skipped ? `, ${p.skipped} overgeslagen` : ''}`;
    this.say(`Klaar: ${status} — ${summary} in ${((Date.now() - this.startedAt) / 1000).toFixed(1)} s.`);
    return { status, error: error.slice(0, 990), exitCode };
  }

  onEvent(event) {
    const p = this.progress;
    switch (event.type) {
      case 'begin':
        p.total = Number(event.total) || 0;
        this.message = `${p.total} tests${event.workers ? ` · ${event.workers} workers` : ''}${event.shard ? ` · shard ${event.shard}` : ''}`;
        this.dirty = true;
        break;
      case 'test': {
        p.done++;
        if (event.status === 'passed') p.passed++;
        else if (event.status === 'flaky') { p.passed++; p.flaky++; }
        else if (event.status === 'skipped') p.skipped++;
        else p.failed++;
        this.tests.push({
          title: event.title,
          file: event.file,
          line: event.line,
          project: event.project,
          status: event.status,
          duration_ms: event.duration_ms,
          retries: event.retries,
          error: event.error ? this.redactor.redact(event.error) : '',
          error_location: event.error_location,
          annotations: event.annotations,
        });
        this.dirty = true;
        break;
      }
      case 'error':
        this.globalErrors.push(this.redactor.redact(String(event.message ?? '')).split('\n')[0]);
        break;
      case 'end':
        this.endStatus = event.status;
        break;
      default:
        break;
    }
  }

  async uploadArtifacts(status) {
    const policy = this.spec.artifacts ?? 'failed';
    const wanted = policy === 'always' || (policy === 'failed' && ['failed', 'error', 'timeout'].includes(status));
    const reportDir = path.join(this.workDir, 'report');
    const settings = this.settings();
    const max = Number(settings.artifact_max_bytes) || 200 * 1024 * 1024;

    if (wanted && existsSync(path.join(reportDir, 'index.html'))) {
      this.setPhase('uploading', 'Rapport inpakken');
      await this.flush();
      const zipFile = path.join(this.workDir, 'report.zip');
      const files = await zipDirectory(reportDir, zipFile);
      const size = statSync(zipFile).size;
      if (size > max) {
        this.say(red(`Het rapport is ${fmtBytes(size)}, groter dan het maximum van ${fmtBytes(max)}; niet geüpload. Het staat op de node in ${reportDir}.`));
      } else {
        this.say(`Rapport uploaden (${files} bestanden, ${fmtBytes(size)})…`);
        this.setPhase('uploading', 'Rapport uploaden');
        await this.api.upload(this.id, zipFile, { kind: 'report', filename: 'playwright-report.zip' });
        this.say('Rapport staat in het dashboard.');
      }
    }

    // De volledige log als bestand als het dashboard hem heeft afgekapt.
    const output = path.join(this.workDir, 'output.log');
    if (this.logTruncated && existsSync(output) && statSync(output).size <= max) {
      await this.api.upload(this.id, output, { kind: 'log', filename: 'output.log' });
    }
  }

  async finish(status, error, exitCode) {
    this.setPhase('finishing');
    const body = {
      ...this.payload(),
      status,
      error,
      requeue: status === 'cancelled' && this.requeue === true,
      exit_code: exitCode,
      duration_ms: Date.now() - this.startedAt,
      totals: {
        total: this.progress.total ?? this.progress.done,
        done: this.progress.done,
        passed: this.progress.passed,
        failed: this.progress.failed,
        flaky: this.progress.flaky,
        skipped: this.progress.skipped,
      },
    };
    // Alle nog niet verstuurde logs en tests gaan mee.
    body.logs = this.pending;
    body.tests = this.tests;

    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await this.api.post(`api/agent/jobs/${this.id}/finish`, body, { timeout: 60000 });
        this.pending = [];
        this.tests = [];
        return;
      } catch (err) {
        if (err instanceof ApiError && !err.retryable) {
          log.warn(`Job ${this.id}: afronden geweigerd`, err);
          return;
        }
        await sleep(Math.min(60000, 2000 * 2 ** attempt));
      }
    }
    // Dashboard onbereikbaar: bewaren en later versturen (zie agent.mjs).
    const spool = path.join(this.config.dataDir, 'spool');
    mkdirSync(spool, { recursive: true });
    writeFileSync(path.join(spool, `${this.id}.json`), JSON.stringify(body));
    log.warn(`Job ${this.id}: resultaat bewaard in spool/, wordt later verstuurd.`);
  }

  cleanup() {
    for (const key of this.acquired) this.cache.release(key);
    this.acquired = [];
    // De laatste KEEP_RUNS mappen blijven staan om na te kijken.
    const runsDir = path.join(this.config.dataDir, 'runs');
    try {
      const dirs = readdirSync(runsDir)
        .filter((d) => /^\d+$/.test(d))
        .map((d) => ({ d, t: statSync(path.join(runsDir, d)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { d } of dirs.slice(this.config.keepRuns)) {
        if (Number(d) !== this.id || this.config.keepRuns === 0) rmSync(path.join(runsDir, d), { recursive: true, force: true });
      }
    } catch { /* niets op te ruimen */ }
  }
}

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}
