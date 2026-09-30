/**
 * Wat de node over zichzelf onthoudt: zijn vaste uuid en het token dat het
 * dashboard bij de aanmelding uitgaf. Staat in DATA_DIR/state.json, alleen
 * leesbaar voor de gebruiker van de agent.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

export class State {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.data = {};
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf8')) ?? {};
      } catch {
        this.data = {};
      }
    }
    if (!this.data.uuid) {
      this.data.uuid = randomUUID();
      this.save();
    }
  }

  get uuid() { return this.data.uuid; }
  get token() { return this.data.token ?? ''; }
  get nodeId() { return this.data.node_id ?? null; }
  get dashboardUrl() { return this.data.dashboard_url ?? ''; }
  get registered() { return Boolean(this.data.token); }

  update(values) {
    Object.assign(this.data, values);
    this.save();
  }

  forgetRegistration() {
    delete this.data.token;
    delete this.data.node_id;
    delete this.data.status;
    this.save();
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* bestand op een systeem zonder rechten */ }
  }
}
