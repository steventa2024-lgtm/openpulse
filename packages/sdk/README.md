# @openpulse/sdk

The official TypeScript/JavaScript SDK for [OpenPulse](https://github.com/steventa2024-lgtm/openpulse).
It talks to an OpenPulse gateway over the same WebSocket protocol the CLI and the dashboard use, so
anything you can do in the app you can do from code.

- No runtime dependencies — uses the WebSocket and WebCrypto built into Node 22+ and browsers.
- Typed methods, streamed agent tasks, and structured errors (`OpenPulseError` with a `code`).

## Install

```bash
npm install @openpulse/sdk
```

> The package is prepared for publishing but has not been published to npm yet. Until it is, use it
> from this repository (`packages/sdk`).

## Connect

The gateway token is in `~/.openpulse/openpulse.json` under `gateway.auth.token`.

```ts
import { OpenPulseClient } from '@openpulse/sdk';

const op = await OpenPulseClient.connect({
  url: 'http://127.0.0.1:18789',
  token: process.env.OPENPULSE_TOKEN,
});

console.log(op.hello.server.version);
await op.close();
```

Connections from the same machine only need the token. From another machine the gateway also
requires a paired device: create one with `createDeviceIdentity()`, keep the exported keys, and
approve the device once with `openpulse devices approve <requestId>`.

## Run an agent task

Wait for the answer:

```ts
const result = await op.run('Summarise the README in three bullet points');
console.log(result.text, result.usage);
```

Or stream everything that happens:

```ts
for await (const update of op.runTask('Find the failing test and explain it')) {
  switch (update.type) {
    case 'text':
      process.stdout.write(update.delta);
      break;
    case 'tool':
      console.log(`tool ${update.phase}: ${update.summary ?? update.name}`);
      break;
    case 'approval':
      await op.approve(update.id, 'deny');
      break;
    case 'done':
      console.log('\nfinished');
      break;
    case 'error':
      console.error(update.message);
      break;
  }
}
```

`approval` updates appear when the agent wants to run something the gateway's policy says a person
must confirm. Answer with `allow-once`, `allow-always` or `deny`.

## Other capabilities

| Call                                                          | What it does                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `op.health()`, `op.status()`                                  | Gateway health and state                                     |
| `op.sessions.list()`, `.history(key)`, `.reset(key)`          | Conversations                                                |
| `op.models.list()`, `.detect()`, `.test(ref)`                 | Configured models, local providers, a live test              |
| `op.tools.list()`                                             | Tools an agent run would get right now, including MCP tools  |
| `op.runs.list()`, `.trace(runId)`, `.cancel(sessionKey)`      | Execution history and traces                                 |
| `op.workflows.start(id, request)`, `.wait(id)`, `.cancel(id)` | Multi-agent workflows                                        |
| `op.on(event, listener)`                                      | Any gateway event, e.g. `chat`, `agent`, `workflows.changed` |
| `op.request(method, params)`                                  | Any gateway method directly                                  |

## Errors

Every failure is an `OpenPulseError`:

```ts
try {
  await op.workflows.get('nope');
} catch (error) {
  if (error instanceof OpenPulseError && error.code === 'NOT_FOUND') {
    /* … */
  }
}
```

Common codes: `UNAUTHORIZED`, `PAIRING_REQUIRED`, `NOT_FOUND`, `INVALID_REQUEST`, `CONFLICT`,
`FORBIDDEN`, `TIMEOUT`, `CLOSED`, `CONNECT_FAILED`. `error.retryable` is true for connection
problems worth retrying.

## Example

[`examples/stream-task.ts`](examples/stream-task.ts) connects, streams a task and handles approvals:

```bash
OPENPULSE_TOKEN=<token> npx tsx examples/stream-task.ts "What changed in the last commit?"
```
