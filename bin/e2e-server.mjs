#!/usr/bin/env node
/**
 * GJDC E2E-Server — de software op de testnodes.
 * Zie README.md of: e2e-server help
 */

import { main } from '../src/cli.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`Node.js 20 of nieuwer is nodig (dit is ${process.version}).\n`);
  process.exit(1);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code);
  },
  (error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  },
);
