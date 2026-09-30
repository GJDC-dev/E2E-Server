/**
 * Logregels naar stdout/stderr. Onder systemd komen ze in het journaal
 * (journalctl -u gjdc-e2e-server); daar staat de tijd al bij, dus die laten
 * we dan weg.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const underSystemd = Boolean(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);

let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function write(level, message, extra) {
  if (LEVELS[level] < threshold) return;
  const prefix = underSystemd ? '' : `${new Date().toISOString()} `;
  const tag = level === 'info' ? '' : `[${level}] `;
  let line = `${prefix}${tag}${message}`;
  if (extra instanceof Error) {
    line += `: ${extra.message}`;
    if (threshold <= LEVELS.debug && extra.stack) line += `\n${extra.stack}`;
  } else if (extra !== undefined) {
    line += ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
