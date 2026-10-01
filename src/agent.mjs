/**
 * De agent: draait als dienst op een testnode.
 *
 * Een node is van buitenaf niet bereikbaar, dus hij belt zelf aan bij het
 * dashboard: elke paar seconden een heartbeat met zijn metingen, zijn cache en
 * de jobs waar hij mee bezig is. In het antwoord staan de opdrachten: een run
 * starten of afbreken, testpakketten alvast binnenhalen, de cache legen, ...
 *
 * Valt het dashboard even weg, dan gaan lopende runs gewoon door; resultaten
 * worden bewaard en verstuurd zodra het dashboard er weer is.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api, ApiError, AGENT_VERSION, sleep } from './http.mjs';
import { Cache } from './cache.mjs';
import { log } from './log.mjs';
import { JobRunner, fmtBytes } from './runner.mjs';
import { State } from './state.mjs';
import { MetricsSampler, systemInfo, diskInfo } from './system.mjs';

const MIN_FREE_BYTES = 1024 * 1024 * 1024;

export class Agent {
  constructor(config) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
    for (const dir of ['runs', 'spool', 'tmp']) mkdirSync(path.join(config.dataDir, dir), { recursive: true });

    this.state = new State(config.dataDir);
    this.api = new Api(config.dashboardUrl, () => this.state.token);
    this.cache = new Cache(config.dataDir, config.cacheMaxMb * 1024 * 1024);
    this.sampler = new MetricsSampler(config.dataDir);
    this.startedAt = new Date();

    this.jobs = new Map();
    this.settings = {
      heartbeat_idle: 10,
      heartbeat_busy: 5,
      log_flush_ms: 1500,
      cache_limit_mb: 0,
      artifact_max_bytes: 200 * 1024 * 1024,
      chunk_bytes: 4 * 1024 * 1024,
    };
    this.serverSystemRev = '';
    this.serverCacheRev = '';
    this.acks = [];
    this.events = [];
    this.keep = [];
    this.prefetchQueue = [];
    this.prefetching = false;
    this.nodeStatus = this.state.data.status ?? 'unknown';
    this.nodeName = config.nodeName || this.state.data.name || os.hostname();
    this.stopping = false;
    this.wakeUp = null;
    this.problem = '';
    this.lastWarning = {};
    this.system = null;
    this.systemAt = 0;
  }

  // ── Starten en stoppen ───────────────────────────────────────────────────

  async start() {
    log.info(`GJDC E2E-Server ${AGENT_VERSION} · dashboard ${this.config.dashboardUrl} · data ${this.config.dataDir}`);

    if (this.state.dashboardUrl && this.state.dashboardUrl !== this.config.dashboardUrl && this.state.registered) {
      log.warn(`De node was aangemeld bij ${this.state.dashboardUrl}, maar DASHBOARD_URL is nu ${this.config.dashboardUrl}. Meld de node opnieuw aan (e2e-server register).`);
      this.state.forgetRegistration();
    }

    if (!this.state.registered) {
      await this.registerWithRetry();
    }

    await this.recoverAfterCrash();

    const stop = (signal) => {
      if (this.stopping) {
        log.warn(`Nog een ${signal}: nu meteen stoppen.`);
        process.exit(1);
      }
      this.shutdown(`${signal} ontvangen`).then(() => process.exit(0));
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));

    await this.loop();
  }

  async registerWithRetry() {
    if (!this.config.enrollmentToken) {
      throw new Error('Deze node is nog niet aangemeld. Draai eerst: e2e-server register --url <dashboard> --token <registratietoken> (het token maak je in het dashboard onder Nodes → Node toevoegen).');
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await register(this.config, this.state, this.api, {});
        return;
      } catch (error) {
        if (error instanceof ApiError && !error.retryable) throw error;
        const wait = Math.min(60, 2 ** attempt);
        log.warn(`Aanmelden lukt nog niet (${error.message}); opnieuw over ${wait} s`);
        await sleep(wait * 1000);
      }
    }
  }

  /**
   * Na een crash of een harde herstart: jobs die nog liepen melden als fout,
   * en resultaten die nog niet verstuurd waren alsnog versturen.
   */
  async recoverAfterCrash() {
    const activeFile = path.join(this.config.dataDir, 'active-jobs.json');
    let orphaned = [];
    try {
      orphaned = JSON.parse(readFileSync(activeFile, 'utf8'));
    } catch { /* geen bestand: netjes afgesloten */ }

    const spoolDir = path.join(this.config.dataDir, 'spool');
    const spooled = new Set(readdirSync(spoolDir).filter((f) => f.endsWith('.json')).map((f) => Number.parseInt(f, 10)));

    for (const id of orphaned) {
      if (spooled.has(id)) continue;
      writeFileSync(path.join(spoolDir, `${id}.json`), JSON.stringify({
        status: 'error',
        error: 'De agent stopte onverwacht tijdens deze run (crash of harde herstart van de node).',
        totals: {},
        logs: [],
        tests: [],
      }));
    }
    this.persistActive();
    await this.flushSpool();
  }

  async flushSpool() {
    const spoolDir = path.join(this.config.dataDir, 'spool');
    for (const file of readdirSync(spoolDir).filter((f) => f.endsWith('.json'))) {
      const id = Number.parseInt(file, 10);
      let body;
      try {
        body = JSON.parse(readFileSync(path.join(spoolDir, file), 'utf8'));
      } catch {
        rmSync(path.join(spoolDir, file), { force: true });
        continue;
      }
      try {
        await this.api.post(`api/agent/jobs/${id}/finish`, body, { timeout: 60000 });
        rmSync(path.join(spoolDir, file), { force: true });
        log.info(`Bewaard resultaat van job ${id} alsnog verstuurd.`);
      } catch (error) {
        if (error instanceof ApiError && !error.retryable) {
          rmSync(path.join(spoolDir, file), { force: true });
        }
        // Anders: volgende keer opnieuw.
      }
    }
  }

  persistActive() {
    try {
      writeFileSync(path.join(this.config.dataDir, 'active-jobs.json'), JSON.stringify([...this.jobs.keys()]));
    } catch (error) {
      log.warn('Kan active-jobs.json niet schrijven', error);
    }
  }

  async shutdown(reason) {
    this.stopping = true;
    log.info(`Stoppen: ${reason}`);
    this.wake();

    const deadline = Date.now() + this.config.shutdownGrace * 1000;
    while (this.jobs.size > 0 && Date.now() < deadline) {
      await sleep(500);
    }
    for (const runner of this.jobs.values()) {
      runner.cancel('De agent op de node stopt (herstart of update); de run gaat terug in de wachtrij', { requeue: true });
    }
    const hard = Date.now() + 45000;
    while (this.jobs.size > 0 && Date.now() < hard) {
      await sleep(500);
    }

    try {
      await this.heartbeat();
    } catch { /* laatste groet mag mislukken */ }
    await this.flushEvents();
  }

  // ── Hoofdlus ─────────────────────────────────────────────────────────────

  wake() {
    this.wakeUp?.();
  }

  async loop() {
    let failures = 0;
    while (!this.stopping) {
      let wait;
      try {
        const interval = await this.heartbeat();
        if (failures > 0) log.info('Verbinding met het dashboard is er weer.');
        failures = 0;
        this.problem = '';
        wait = interval * 1000;
      } catch (error) {
        failures++;
        wait = this.handleHeartbeatError(error, failures);
      }

      await this.flushEvents();
      if (this.jobs.size === 0) this.runPrefetch();
      if (failures === 0 && existsSync(path.join(this.config.dataDir, 'spool'))) await this.flushSpool();

      // Wachten, tenzij er iets gebeurt (job klaar) dat een snelle heartbeat waard is.
      const jitter = Math.round(wait * 0.1 * Math.random());
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait + jitter);
        this.wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeUp = null;
    }
  }

  handleHeartbeatError(error, failures) {
    if (error instanceof ApiError && error.status === 401) {
      this.warnOnce('401', 'Het dashboard kent dit token niet (meer). Is de node verwijderd? Meld hem opnieuw aan met: e2e-server register --url … --token … --force');
      return 60000;
    }
    if (error instanceof ApiError && error.code === 'node_disabled') {
      this.warnOnce('disabled', 'Deze node is uitgeschakeld in het dashboard; hij wacht tot hij weer aan staat.');
      this.nodeStatus = 'disabled';
      return 60000;
    }
    if (error instanceof ApiError && error.code === 'protocol_unsupported') {
      this.warnOnce('protocol', error.message);
      return 300000;
    }
    const wait = Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
    if (failures === 1 || failures % 10 === 0) {
      log.warn(`Heartbeat mislukt (${error.message}); opnieuw over ${Math.round(wait / 1000)} s. Lopende runs gaan gewoon door.`);
    }
    return wait;
  }

  warnOnce(key, message) {
    const last = this.lastWarning[key] ?? 0;
    if (Date.now() - last > 15 * 60000) {
      log.error(message);
      this.lastWarning[key] = Date.now();
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  currentState() {
    if (this.stopping) return ['stopping', 'De agent stopt'];
    const disk = diskInfo(this.config.dataDir);
    if (disk.free !== null && disk.free < MIN_FREE_BYTES) {
      return ['error', `Te weinig schijfruimte: nog ${fmtBytes(disk.free)} vrij in ${this.config.dataDir}`];
    }
    if (this.jobs.size > 0) return ['busy', ''];
    if (this.prefetching) return ['idle', 'Testpakketten vooraf ophalen'];
    return ['idle', ''];
  }

  async heartbeat() {
    // Systeeminformatie eens per minuut opnieuw opbouwen; meesturen alleen
    // als ze veranderd is.
    if (!this.system || Date.now() - this.systemAt > 60000) {
      this.system = await systemInfo({
        dataDir: this.config.dataDir,
        browsersPath: this.config.browsersPath,
        startedAt: this.startedAt,
        playwrightVersions: this.cache.playwrightVersions(),
      });
      this.systemAt = Date.now();
    }

    const inventory = this.cache.inventory();
    const [state, stateMessage] = this.currentState();
    const acks = this.acks.splice(0);

    const body = {
      state,
      state_message: stateMessage,
      agent_version: AGENT_VERSION,
      max_jobs: this.config.maxJobs,
      metrics: this.sampler.sample(),
      system_rev: this.system.rev,
      system: this.system.rev !== this.serverSystemRev ? this.system.info : undefined,
      cache: {
        rev: inventory.rev,
        items: inventory.rev !== this.serverCacheRev ? inventory.items : null,
        bytes: inventory.bytes,
        limit: inventory.limit,
      },
      jobs: [...this.jobs.values()].map((j) => j.summary),
      acked_commands: acks,
    };

    let result;
    try {
      result = await this.api.post('api/agent/heartbeat', body, { timeout: 30000 });
    } catch (error) {
      this.acks.unshift(...acks);
      throw error;
    }

    this.serverSystemRev = result.system_rev ?? '';
    this.serverCacheRev = result.cache_rev ?? '';
    this.settings = { ...this.settings, ...(result.settings ?? {}) };
    this.keep = result.keep ?? [];
    if (result.node) {
      if (result.node.status !== this.nodeStatus) {
        log.info(result.node.status === 'pending'
          ? 'Aangemeld; de node wacht op goedkeuring in het dashboard.'
          : `Status in het dashboard: ${result.node.status}`);
        this.nodeStatus = result.node.status;
        this.state.update({ status: result.node.status, name: result.node.name });
      }
      this.nodeName = result.node.name || this.nodeName;
    }

    // Cachelimiet uit het dashboard gaat voor die van de node.
    const limitMb = Number(this.settings.cache_limit_mb) || 0;
    if (limitMb > 0) this.cache.maxBytes = limitMb * 1024 * 1024;

    for (const command of result.commands ?? []) {
      try {
        await this.handleCommand(command);
      } catch (error) {
        log.warn(`Opdracht ${command.type} mislukt`, error);
        if (command.id) this.acks.push({ id: command.id, result: `Mislukt: ${error.message}`.slice(0, 480) });
      }
    }

    const busy = this.jobs.size > 0;
    return Math.max(2, Number(result.interval) || (busy ? this.settings.heartbeat_busy : this.settings.heartbeat_idle));
  }

  // ── Opdrachten ───────────────────────────────────────────────────────────

  async handleCommand(command) {
    switch (command.type) {
      case 'run':
        return this.startJob(command.job);

      case 'cancel': {
        const runner = this.jobs.get(Number(command.job_id));
        if (runner) runner.cancel(command.reason || 'Geannuleerd in het dashboard');
        return undefined;
      }

      case 'prefetch':
        for (const bundle of command.bundles ?? []) {
          if (!this.cache.hasBundle(bundle.sha256, bundle.size) && !this.prefetchQueue.some((b) => b.sha256 === bundle.sha256)) {
            this.prefetchQueue.push(bundle);
          }
        }
        return undefined;

      case 'purge_cache': {
        const removed = this.cache.evict({ all: true });
        this.event('cache.purged', 'info', `Cache geleegd op verzoek: ${removed.length} onderdelen verwijderd`);
        this.acks.push({ id: command.id, result: `${removed.length} onderdelen verwijderd` });
        this.serverCacheRev = '';
        return undefined;
      }

      case 'evict': {
        let n = 0;
        for (const sha of command.payload?.sha256 ?? []) {
          if (this.cache.inUse.has(sha)) continue;
          if (this.cache.hasBundle(sha)) {
            this.cache.removeBundle(sha);
            n++;
          }
        }
        this.acks.push({ id: command.id, result: `${n} testpakket(ten) verwijderd` });
        return undefined;
      }

      case 'refresh_system':
        this.system = null;
        this.serverSystemRev = '';
        this.acks.push({ id: command.id, result: 'Systeeminformatie opnieuw verstuurd' });
        return undefined;

      case 'restart':
        this.acks.push({ id: command.id, result: 'De agent herstart' });
        this.event('agent.restart', 'info', 'Agent herstart op verzoek uit het dashboard');
        await this.heartbeat().catch(() => {});
        await this.shutdown('herstart op verzoek uit het dashboard');
        // systemd (Restart=always) start hem opnieuw.
        process.exit(0);
        return undefined;

      default:
        if (command.id) this.acks.push({ id: command.id, result: `Onbekende opdracht "${command.type}"; werk de E2E-Server bij.` });
        return undefined;
    }
  }

  startJob(spec) {
    if (!spec || typeof spec.id !== 'number') return;
    if (this.jobs.has(spec.id)) return; // al bezig (dubbel aangeboden)
    if (this.stopping || this.jobs.size >= this.config.maxJobs) {
      this.api.post(`api/agent/jobs/${spec.id}/reject`, { reason: this.stopping ? 'de agent stopt' : 'geen vrije plek' }).catch(() => {});
      return;
    }

    const runner = new JobRunner({
      spec,
      api: this.api,
      cache: this.cache,
      config: this.config,
      settings: () => this.settings,
      event: (e) => this.events.push(e),
      nodeName: this.nodeName,
    });
    this.jobs.set(spec.id, runner);
    this.persistActive();
    log.info(`Run #${spec.run_id} (job ${spec.id}): ${spec.suite?.name} v${spec.bundle?.version}`);

    runner.run()
      .then((status) => {
        if (status !== 'rejected') log.info(`Job ${spec.id} klaar: ${status}`);
      })
      .catch((error) => log.error(`Job ${spec.id} liep vast`, error))
      .finally(() => {
        this.jobs.delete(spec.id);
        this.persistActive();
        this.tidyCache();
        this.wake(); // meteen melden dat er weer plek is
      });
  }

  tidyCache() {
    try {
      const removed = this.cache.evict({ keep: this.keep });
      if (removed.length > 0) {
        this.event('cache.evicted', 'info', `Cache opgeruimd (limiet ${fmtBytes(this.cache.maxBytes)}): ${removed.join(', ')}`);
      }
    } catch (error) {
      log.warn('Cache opruimen mislukt', error);
    }
  }

  // ── Vooraf verspreiden ───────────────────────────────────────────────────

  async runPrefetch() {
    if (this.prefetching || this.prefetchQueue.length === 0 || this.stopping) return;
    this.prefetching = true;
    try {
      while (this.prefetchQueue.length > 0 && this.jobs.size === 0 && !this.stopping) {
        const bundle = this.prefetchQueue.shift();
        if (this.cache.hasBundle(bundle.sha256, bundle.size)) continue;
        const tmp = path.join(this.cache.tmpDir, `${bundle.sha256}.zip`);
        try {
          const bytes = await this.api.download(String(bundle.url).replace(/^\//, ''), tmp, { sha256: bundle.sha256, size: bundle.size });
          this.cache.addBundle(bundle.sha256, tmp, { suite: bundle.suite, version: bundle.version });
          this.event('bundle.prefetched', 'info', `${bundle.name ?? bundle.suite} v${bundle.version} vooraf gedownload (${fmtBytes(bytes)})`);
          log.info(`Vooraf gedownload: ${bundle.suite} v${bundle.version}`);
        } catch (error) {
          log.warn(`Vooraf downloaden van ${bundle.suite} v${bundle.version} mislukt`, error);
        }
      }
    } finally {
      this.prefetching = false;
    }
  }

  // ── Gebeurtenissen ───────────────────────────────────────────────────────

  event(type, level, message, jobId) {
    this.events.push({ type, level, message, ...(jobId ? { job_id: jobId } : {}) });
  }

  async flushEvents() {
    if (this.events.length === 0) return;
    const batch = this.events.splice(0, 50);
    try {
      await this.api.post('api/agent/events', { events: batch }, { timeout: 15000 });
    } catch {
      this.events.unshift(...batch);
      if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    }
  }
}

/**
 * Meldt de node aan bij het dashboard met een registratietoken en bewaart
 * het token dat hij terugkrijgt.
 */
export async function register(config, state, api, { token, name, labels } = {}) {
  const system = await systemInfo({
    dataDir: config.dataDir,
    browsersPath: config.browsersPath,
    startedAt: new Date(),
  });
  const enrollment = token || config.enrollmentToken;
  if (!enrollment) throw new Error('Geen registratietoken opgegeven.');

  const result = await api.post('api/agent/register', {
    enrollment_token: enrollment,
    uuid: state.uuid,
    hostname: os.hostname(),
    name: name || config.nodeName || os.hostname(),
    labels: labels ?? config.labels,
    agent_version: AGENT_VERSION,
    max_jobs: config.maxJobs,
    system: system.info,
  });

  state.update({
    node_id: result.node_id,
    token: result.token,
    status: result.status,
    name: result.name,
    dashboard_url: config.dashboardUrl,
    registered_at: new Date().toISOString(),
  });
  log.info(`Aangemeld als "${result.name}" (node ${result.node_id})${result.status === 'pending' ? ' — wacht op goedkeuring in het dashboard' : ''}.`);
  return result;
}
