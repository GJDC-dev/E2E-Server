/**
 * Playwright-reporter van de E2E-Server.
 *
 * De agent schuift deze reporter bij elke run naast de gewone uitvoer. Hij
 * schrijft per gebeurtenis één regel JSON naar het bestand in
 * E2E_AGENT_EVENTS; de agent leest dat bestand mee en stuurt de voortgang en
 * de resultaten live naar het dashboard.
 *
 * Bewust CommonJS en zonder afhankelijkheden: Playwright laadt reporters met
 * zijn eigen loader, en dit bestand staat buiten het testpakket.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ANSI = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]', 'g');
const MAX_ERROR = 8000;

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI, '');
}

function outcomeToStatus(test, result) {
  const outcome = test.outcome();
  if (outcome === 'skipped') return 'skipped';
  if (outcome === 'flaky') return 'flaky';
  if (outcome === 'expected') return 'passed';
  if (result.status === 'timedOut') return 'timedout';
  if (result.status === 'interrupted') return 'interrupted';
  return 'failed';
}

class AgentReporter {
  constructor() {
    this.file = process.env.E2E_AGENT_EVENTS || '';
    this.fd = null;
    this.cwd = process.cwd();
    if (this.file) {
      try {
        this.fd = fs.openSync(this.file, 'a');
      } catch {
        this.fd = null;
      }
    }
  }

  printsToStdio() {
    return false;
  }

  emit(event) {
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, JSON.stringify(event) + '\n');
    } catch {
      // De run gaat voor; een gemiste regel ziet het dashboard in het eindtotaal.
    }
  }

  onBegin(config, suite) {
    this.rootDir = config.rootDir || this.cwd;
    this.emit({
      type: 'begin',
      total: suite.allTests().length,
      workers: config.workers,
      version: config.version,
      shard: config.shard ? `${config.shard.current}/${config.shard.total}` : null,
      projects: (config.projects || []).map((p) => p.name).filter(Boolean),
    });
  }

  onTestBegin(test, result) {
    this.emit({ type: 'testBegin', title: this.title(test), retry: result.retry });
  }

  onTestEnd(test, result) {
    // Wordt deze test nog een keer geprobeerd? Dan is dit niet de uitkomst.
    const willRetry = result.status !== 'passed' && result.status !== 'skipped'
      && result.status !== 'interrupted' && result.retry < test.retries;
    if (willRetry) {
      this.emit({ type: 'retry', title: this.title(test), retry: result.retry, status: result.status });
      return;
    }

    const error = result.errors && result.errors.length > 0 ? result.errors[0] : result.error;
    let message = '';
    let location = '';
    if (error) {
      message = stripAnsi(error.message || error.value || '');
      if (error.stack && !message.includes('\n    at ')) {
        const stack = stripAnsi(error.stack).split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 6).join('\n');
        if (stack) message += '\n' + stack;
      }
      if (error.snippet) message += '\n\n' + stripAnsi(error.snippet);
      if (message.length > MAX_ERROR) message = message.slice(0, MAX_ERROR) + '\n…';
      if (error.location) {
        location = `${this.rel(error.location.file)}:${error.location.line}:${error.location.column}`;
      }
    }

    const duration = test.results.reduce((sum, r) => sum + (r.duration > 0 ? r.duration : 0), 0);

    this.emit({
      type: 'test',
      title: this.title(test),
      file: this.rel(test.location.file),
      line: test.location.line,
      project: this.project(test),
      status: outcomeToStatus(test, result),
      duration_ms: Math.round(duration),
      retries: result.retry,
      error: message,
      error_location: location,
      annotations: (test.annotations || []).slice(0, 10).map((a) => ({ type: a.type, description: a.description ? String(a.description).slice(0, 300) : '' })),
    });
  }

  onError(error) {
    this.emit({ type: 'error', message: stripAnsi(error.message || String(error)).slice(0, MAX_ERROR) });
  }

  onEnd(result) {
    this.emit({ type: 'end', status: result.status, duration_ms: Math.round(result.duration || 0) });
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* al dicht */ }
      this.fd = null;
    }
  }

  /** "beschrijving › subbeschrijving › test", zonder project en bestand. */
  title(test) {
    const parts = typeof test.titlePath === 'function' ? test.titlePath() : [test.title];
    // titlePath: ['', project, bestand, ...describes, titel]
    const file = test.location && test.location.file ? path.basename(test.location.file) : '';
    const clean = parts.filter((p, i) => p !== '' && !(i <= 2 && (p === this.project(test) || p.endsWith(file) && file !== '')));
    return clean.join(' › ') || test.title;
  }

  project(test) {
    try {
      return test.parent && typeof test.parent.project === 'function' ? (test.parent.project() || {}).name || '' : '';
    } catch {
      return '';
    }
  }

  rel(file) {
    if (!file) return '';
    return path.relative(this.cwd, file).split(path.sep).join('/');
  }
}

module.exports = AgentReporter;
