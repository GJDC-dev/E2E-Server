import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

/** Een tijdelijke map die na de testfile weer opgeruimd wordt. */
export function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gjdc-e2e-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
