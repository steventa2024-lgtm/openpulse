#!/usr/bin/env node
/**
 * A small but real MCP server over stdio, used by the integration tests.
 *
 * It implements the handshake, tools/list and tools/call, so the tests exercise the actual protocol
 * rather than a mock of it. Behaviour is controlled by environment variables so a single file can
 * play the well-behaved server, the failing tool and the server that dies on start.
 */
import { createInterface } from 'node:readline';

const MODE = process.env.MCP_TEST_MODE ?? 'ok';

if (MODE === 'crash') {
  process.stderr.write('test server: refusing to start\n');
  process.exit(3);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the text it was given.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'explode',
    description: 'Always fails, so error handling can be tested.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = message;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'openpulse-test-server', version: '1.0.0' },
      instructions: 'A test server.',
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (name === 'echo') {
      reply(id, { content: [{ type: 'text', text: String(args.text ?? '') }], isError: false });
      return;
    }
    if (name === 'add') {
      reply(id, {
        content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
        isError: false,
      });
      return;
    }
    if (name === 'explode') {
      reply(id, { content: [{ type: 'text', text: 'the tool failed on purpose' }], isError: true });
      return;
    }
    replyError(id, -32602, `unknown tool: ${name}`);
    return;
  }

  if (id !== undefined) replyError(id, -32601, `unknown method: ${method}`);
});
