/**
 * Example: connect to a local OpenPulse gateway, stream an agent task, and answer approvals.
 *
 *   OPENPULSE_TOKEN=<gateway.auth.token> npx tsx examples/stream-task.ts "Summarise the README"
 *
 * The token is in ~/.openpulse/openpulse.json under gateway.auth.token.
 */
import { OpenPulseClient, OpenPulseError } from '../src/index.js';

const url = process.env.OPENPULSE_URL ?? 'http://127.0.0.1:18789';
const token = process.env.OPENPULSE_TOKEN;
const prompt =
  process.argv.slice(2).join(' ') || 'Say hello and tell me which model you are running on.';

async function main(): Promise<void> {
  const op = await OpenPulseClient.connect({
    url,
    ...(token && { token }),
    clientName: 'SDK example',
  });
  console.log(`connected to OpenPulse ${op.hello.server.version} on ${op.hello.server.host}\n`);

  try {
    for await (const update of op.runTask(prompt)) {
      switch (update.type) {
        case 'text':
          process.stdout.write(update.delta);
          break;
        case 'tool':
          if (update.phase === 'start') console.log(`\n  ⚙ ${update.summary ?? update.name}`);
          break;
        case 'approval':
          // A real integration would ask a person. This example declines anything risky.
          console.log(`\n  approval requested: ${update.command} (${update.reason}) — declining`);
          await op.approve(update.id, 'deny');
          break;
        case 'error':
          console.error(`\nrun failed: ${update.message}`);
          break;
        case 'done':
          console.log('\n\n(done)');
          break;
        default:
          break;
      }
    }
  } finally {
    await op.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof OpenPulseError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.code === 'UNAUTHORIZED')
      console.error('Set OPENPULSE_TOKEN to gateway.auth.token from openpulse.json.');
  } else {
    console.error(error);
  }
  process.exit(1);
});
