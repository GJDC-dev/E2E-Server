/**
 * Kopie van @gjdc/status-reporter uit GJDC-E2E (packages/status-reporter/index.js),
 * ongewijzigd. De E2E-Server schuift hem bij een run erbij als het testpakket
 * de variabelen GJDC_STATUS_URL en GJDC_STATUS_TOKEN heeft: dan komt het
 * resultaat, naast het testdashboard, ook op status.gjdc.nl.
 *
 * Bijwerken: kopieer de nieuwe versie uit GJDC-E2E over dit bestand heen.
 */

/**
 * Playwright-reporter die de uitkomst van een run naar de GJDC-statuspagina stuurt.
 *
 * In je playwright.config.ts:
 *
 *   reporter: [
 *     ['list'],
 *     ['@gjdc/status-reporter', { suite: 'gjdc-mijn' }],
 *   ]
 *
 * URL en token komen uit de omgeving (GJDC_STATUS_URL, GJDC_STATUS_TOKEN) of uit
 * de opties hierboven. Ontbreken ze, dan doet de reporter niets en zegt dat één
 * keer — een testrun hoort niet te stranden omdat de statuspagina er niet is.
 *
 * De reporter is bewust een gewoon CommonJS-bestand zonder afhankelijkheden:
 * hij moet in elk project van elke applicatie zonder gedoe te laden zijn.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

/** ANSI-kleurcodes uit een foutmelding halen; die horen niet in een database. */
const ANSI_PATTERN = new RegExp('\\u001b\\[[0-9;]*m', 'g');

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '');
}

/** Leest een git-waarde, of geeft '' terug als git niets weet. */
function gitValue(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Vertaalt de uitkomst van Playwright naar de woorden van de statuspagina. */
function caseStatus(test) {
  const outcome = test.outcome();
  if (outcome === 'skipped') return 'skipped';
  if (outcome === 'flaky') return 'flaky';
  if (outcome === 'expected') return 'passed';

  const last = test.results[test.results.length - 1];
  return last && last.status === 'timedOut' ? 'timedout' : 'failed';
}

/** De projectnaam waaronder een test draaide (chromium, mobile, …). */
function projectName(test) {
  if (typeof test.parent?.project === 'function') {
    return test.parent.project()?.name ?? '';
  }
  // Oudere Playwright-versies hangen het project aan het titelpad.
  return typeof test.titlePath === 'function' ? test.titlePath()[1] ?? '' : '';
}

/** Pad ten opzichte van de projectwortel, altijd met forward slashes. */
function relative(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

class StatusReporter {
  constructor(options = {}) {
    this.options = options;

    this.url = options.url || process.env.GJDC_STATUS_URL || '';
    this.token = options.token || process.env.GJDC_STATUS_TOKEN || '';
    this.environment = options.environment || process.env.GJDC_STATUS_ENVIRONMENT || '';
    this.runner = options.runner || process.env.GJDC_STATUS_RUNNER || os.hostname();
    this.reportUrl = options.reportUrl || process.env.GJDC_STATUS_REPORT_URL || '';
    this.externalId = options.externalId || process.env.GJDC_STATUS_RUN_ID || '';

    /** Laat de run falen als insturen niet lukt. Standaard uit. */
    this.required = options.required ?? process.env.GJDC_STATUS_REQUIRED === '1';

    /** Alleen problemen meesturen; scheelt bij duizenden groene tests. */
    this.onlyProblems = options.onlyProblems ?? process.env.GJDC_STATUS_ONLY_PROBLEMS === '1';

    this.timeoutMs = Number(options.timeoutMs || process.env.GJDC_STATUS_TIMEOUT_MS || 20000);

    this.startedAt = new Date();
    this.rootSuite = null;
    this.rootDir = process.cwd();
  }

  /** Zonder URL of token slaan we het insturen over. */
  get enabled() {
    return this.url !== '' && this.token !== '';
  }

  printsToStdio() {
    // We schrijven hooguit één regel; laat de andere reporters hun gang gaan.
    return false;
  }

  onBegin(config, suite) {
    this.rootSuite = suite;
    this.rootDir = config.rootDir || process.cwd();
    this.startedAt = new Date();

    if (!this.enabled) {
      console.log(
        '[status] GJDC_STATUS_URL of GJDC_STATUS_TOKEN ontbreekt — het resultaat wordt niet ingestuurd.',
      );
    }
  }

  async onEnd(result) {
    if (!this.enabled) return;

    const payload = this.buildPayload(result);

    try {
      const response = await this.post(payload);
      if (response.ok) {
        const link = response.body?.url ? ` → ${response.body.url}` : '';
        console.log(`[status] Resultaat ingestuurd naar de statuspagina${link}`);
        return;
      }

      const reason = response.body?.error || `HTTP ${response.status}`;
      this.reportProblem(`de statuspagina weigerde het resultaat: ${reason}`, result);
    } catch (error) {
      this.reportProblem(`insturen mislukte: ${error.message}`, result);
    }
  }

  /** Meldt het probleem, en laat de run alleen falen als dat gevraagd is. */
  reportProblem(message, result) {
    console.error(`[status] ${message}`);
    if (this.required && result.status === 'passed') {
      result.status = 'failed';
    }
  }

  buildPayload(result) {
    const tests = [];
    const totals = { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };

    for (const test of this.rootSuite ? this.rootSuite.allTests() : []) {
      const status = caseStatus(test);
      totals.total += 1;

      if (status === 'passed') totals.passed += 1;
      else if (status === 'flaky') totals.flaky += 1;
      else if (status === 'skipped') totals.skipped += 1;
      else totals.failed += 1;

      if (this.onlyProblems && (status === 'passed' || status === 'skipped')) {
        continue;
      }

      const last = test.results[test.results.length - 1];
      const error = last?.error;
      const file = relative(this.rootDir, test.location.file);

      // titlePath is [root, project, bestand, describe…, titel]; de eerste twee
      // staan al in andere velden, dus die laten we hier weg.
      const titlePath = typeof test.titlePath === 'function' ? test.titlePath() : [];
      const title = titlePath.filter(Boolean).slice(2).join(' › ') || test.title;

      tests.push({
        title,
        file,
        project: projectName(test),
        status,
        duration_ms: test.results.reduce((sum, item) => sum + (item.duration || 0), 0),
        retries: Math.max(0, test.results.length - 1),
        error_message: error ? stripAnsi(error.message || error.value || '') : undefined,
        error_location: error?.location
          ? `${relative(this.rootDir, error.location.file)}:${error.location.line}:${error.location.column}`
          : `${file}:${test.location.line}`,
      });
    }

    const finishedAt = new Date();

    return {
      external_id: this.externalId,
      status: result.status,
      started_at: this.startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - this.startedAt.getTime(),
      environment: this.environment,
      runner: this.runner,
      report_url: this.reportUrl,
      git: {
        branch:
          process.env.GITHUB_REF_NAME ||
          process.env.CI_COMMIT_REF_NAME ||
          gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], this.rootDir),
        sha:
          process.env.GITHUB_SHA ||
          process.env.CI_COMMIT_SHA ||
          gitValue(['rev-parse', 'HEAD'], this.rootDir),
      },
      totals,
      tests,
    };
  }

  async post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = StatusReporter;
module.exports.default = StatusReporter;
