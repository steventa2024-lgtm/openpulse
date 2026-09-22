#!/usr/bin/env node
import { startGateway } from './start.js';

const gateway = await startGateway({
  logConsole: (r) => {
    if (r.level === 'trace' || r.level === 'debug') return;
    process.stdout.write(
      `${r.time.slice(11, 19)} ${r.level.toUpperCase().padEnd(5)} [${r.subsystem}] ${r.msg}\n`,
    );
  },
});
process.stdout.write(
  `OpenPulse gateway on ${gateway.url}  (state: ${gateway.runtime.paths.stateDir})\n`,
);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void gateway.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
