/**
 * Gateway entry used by the desktop app.
 *
 * This is bundled (with its dependencies) into `resources/gateway/main.mjs` and run by the
 * Electron binary with ELECTRON_RUN_AS_NODE=1, so an installed OpenPulse needs no Node on the
 * machine. Paths that normally resolve through the pnpm workspace are passed in as environment
 * variables by the supervisor, because a bundle has no node_modules to look in.
 */
import { startGateway } from '@openpulse/gateway';

const port = Number(process.env.OPENPULSE_PORT ?? 18789);
const controlUiDir = process.env.OPENPULSE_CONTROL_UI_DIR;
const bundledSkillsDir = process.env.OPENPULSE_BUNDLED_SKILLS_DIR;

const gateway = await startGateway({
  ...(Number.isInteger(port) && port > 0 ? { port } : {}),
  ...(controlUiDir ? { controlUiDir } : {}),
  ...(bundledSkillsDir ? { bundledSkillsDir } : {}),
  logConsole: (record) => {
    if (record.level === 'trace' || record.level === 'debug') return;
    process.stdout.write(
      `${record.time.slice(11, 19)} ${record.level.toUpperCase().padEnd(5)} [${record.subsystem}] ${record.msg}\n`,
    );
  },
});

process.stdout.write(`openpulse-gateway-ready ${gateway.url}\n`);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void gateway.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (message) => {
  if (message === 'openpulse:shutdown') shutdown();
});
