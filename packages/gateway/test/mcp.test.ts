import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, renderToolResult } from '../src/mcp/client.js';
import { McpManager, qualifiedToolName } from '../src/mcp/manager.js';
import { buildMcpTools } from '../src/agent/tools/mcp-tools.js';
import type { ToolContext } from '../src/agent/tools/types.js';
import { ConfigSchema, type OpenPulseConfig } from '../src/config/schema.js';
import { silentLogger } from '../src/infra/logger.js';
import { DEFAULT_DENY_PATTERNS, FsPolicy } from '../src/policy/fs-policy.js';

const SERVER = fileURLToPath(new URL('./fixtures/mcp-test-server.mjs', import.meta.url));

const clients: McpClient[] = [];
const managers: McpManager[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const manager of managers.splice(0)) await manager.stop();
});

function stdioClient(mode = 'ok'): McpClient {
  const client = new McpClient({
    transport: {
      kind: 'stdio',
      command: process.execPath,
      args: [SERVER],
      env: { MCP_TEST_MODE: mode },
    },
    requestTimeoutMs: 10_000,
  });
  clients.push(client);
  return client;
}

function configWith(servers: Record<string, unknown>): OpenPulseConfig {
  return ConfigSchema.parse({ mcp: { servers } });
}

function manager(config: OpenPulseConfig): McpManager {
  const instance = new McpManager({ config: () => config, log: silentLogger });
  managers.push(instance);
  return instance;
}

const stdioServer = (mode = 'ok', extra: Record<string, unknown> = {}) => ({
  transport: 'stdio',
  command: process.execPath,
  args: [SERVER],
  env: { MCP_TEST_MODE: mode },
  ...extra,
});

describe('MCP client', () => {
  it('completes the handshake with a real server', async () => {
    const client = stdioClient();
    const info = await client.connect();

    expect(info.name).toBe('openpulse-test-server');
    expect(info.version).toBe('1.0.0');
    expect(info.protocolVersion).toBe('2025-06-18');
    expect(client.connected).toBe(true);
  });

  it('discovers tools with their schemas', async () => {
    const client = stdioClient();
    await client.connect();
    const tools = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['echo', 'add', 'explode']);
    expect(tools[0]!.inputSchema).toMatchObject({ type: 'object', required: ['text'] });
  });

  it('calls a tool and returns its content', async () => {
    const client = stdioClient();
    await client.connect();

    const echoed = await client.callTool('echo', { text: 'hello from the test' });
    expect(renderToolResult(echoed)).toBe('hello from the test');
    expect(echoed.isError).toBe(false);

    const sum = await client.callTool('add', { a: 2, b: 40 });
    expect(renderToolResult(sum)).toBe('42');
  });

  it('reports a tool that fails, and an unknown tool', async () => {
    const client = stdioClient();
    await client.connect();

    const failed = await client.callTool('explode', {});
    expect(failed.isError).toBe(true);
    expect(renderToolResult(failed)).toContain('failed on purpose');

    await expect(client.callTool('nope', {})).rejects.toMatchObject({
      name: 'McpError',
      code: -32602,
    });
  });

  it('fails clearly when the server will not start', async () => {
    const client = stdioClient('crash');
    await expect(client.connect()).rejects.toMatchObject({ name: 'McpError' });
  });

  it('refuses to work after it is closed', async () => {
    const client = stdioClient();
    await client.connect();
    await client.close();

    expect(client.connected).toBe(false);
    await expect(client.listTools()).rejects.toMatchObject({ code: 'CLOSED' });
  });
});

describe('MCP manager', () => {
  it('connects the configured servers and lists their tools', async () => {
    const mcp = manager(configWith({ testing: stdioServer() }));
    await mcp.sync();

    const [status] = mcp.status();
    expect(status).toMatchObject({
      id: 'testing',
      state: 'connected',
      transport: 'stdio',
      toolCount: 3,
    });
    expect(status!.serverName).toBe('openpulse-test-server');

    const tools = mcp.tools();
    expect(tools.map((t) => t.qualifiedName)).toEqual([
      'mcp__testing__add',
      'mcp__testing__echo',
      'mcp__testing__explode',
    ]);
    expect(tools.every((t) => t.enabled)).toBe(true);
  });

  it('records a server that fails to start without taking the runtime down', async () => {
    const mcp = manager(configWith({ broken: stdioServer('crash') }));
    await mcp.sync();

    const [status] = mcp.status();
    expect(status).toMatchObject({ id: 'broken', state: 'failed', toolCount: 0 });
    expect(status!.error).toBeTruthy();
    expect(mcp.activeTools()).toEqual([]);
  });

  it('leaves a disabled server alone', async () => {
    const mcp = manager(configWith({ testing: stdioServer('ok', { enabled: false }) }));
    await mcp.sync();

    expect(mcp.status()[0]).toMatchObject({ state: 'disconnected', enabled: false });
    expect(mcp.activeTools()).toEqual([]);
  });

  it('honours per-tool allow and deny lists', async () => {
    const mcp = manager(
      configWith({ testing: stdioServer('ok', { tools: { deny: ['explode'] } }) }),
    );
    await mcp.sync();

    const enabled = mcp
      .tools()
      .filter((t) => t.enabled)
      .map((t) => t.name);
    expect(enabled).toEqual(['add', 'echo']);
    await expect(mcp.callTool('testing', 'explode', {})).rejects.toMatchObject({
      code: 'DISABLED',
    });
  });

  it('disconnects on request and reconnects on the next sync', async () => {
    const mcp = manager(configWith({ testing: stdioServer() }));
    await mcp.sync();
    await mcp.disconnect('testing');
    expect(mcp.status()[0]!.state).toBe('disconnected');

    await mcp.connect('testing');
    expect(mcp.status()[0]!.state).toBe('connected');
    expect(mcp.activeTools()).toHaveLength(3);
  });

  it('names tools so they cannot shadow a built-in', () => {
    expect(qualifiedToolName('files', 'read_file')).toBe('mcp__files__read_file');
    expect(qualifiedToolName('my server', 'do-it')).toBe('mcp__my_server__do_it');
  });
});

describe('MCP tools inside an agent run', () => {
  function context(approvals: Partial<ToolContext['services']['approvals']>): ToolContext {
    return {
      agentId: 'main',
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      workspace: process.cwd(),
      fsPolicy: new FsPolicy({
        mode: 'balanced',
        readRoots: [],
        writeRoots: [],
        denyPatterns: DEFAULT_DENY_PATTERNS,
      }),
      config: ConfigSchema.parse({}),
      log: silentLogger,
      extraEnv: {},
      isMainSession: true,
      services: { approvals } as ToolContext['services'],
    };
  }

  it('asks for approval before calling an untrusted server, and runs the tool once allowed', async () => {
    const mcp = manager(configWith({ testing: stdioServer() }));
    await mcp.sync();
    const tools = buildMcpTools(mcp);
    const echo = tools.find((t) => t.name === 'mcp__testing__echo')!;

    const asked: string[] = [];
    const ctx = context({
      request: (req: { command: string }) => {
        asked.push(req.command);
        return Promise.resolve({ decision: 'allow-once' as const });
      },
    } as never);

    const result = await echo.execute({ text: 'approved call' }, ctx);
    expect(asked[0]).toContain('mcp testing/echo');
    expect(result.content).toBe('approved call');
    expect(result.isError).toBeFalsy();
  });

  it('does not call the tool when approval is declined', async () => {
    const mcp = manager(configWith({ testing: stdioServer() }));
    await mcp.sync();
    const echo = buildMcpTools(mcp).find((t) => t.name === 'mcp__testing__echo')!;

    const ctx = context({ request: () => Promise.resolve({ decision: 'deny' as const }) } as never);
    const result = await echo.execute({ text: 'should not run' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('declined');
  });

  it('skips the approval for a server marked trusted', async () => {
    const mcp = manager(configWith({ testing: stdioServer('ok', { trust: 'allow' }) }));
    await mcp.sync();
    const add = buildMcpTools(mcp).find((t) => t.name === 'mcp__testing__add')!;

    let asked = false;
    const ctx = context({
      request: () => {
        asked = true;
        return Promise.resolve({ decision: 'deny' as const });
      },
    } as never);

    const result = await add.execute({ a: 20, b: 22 }, ctx);
    expect(asked).toBe(false);
    expect(result.content).toBe('42');
  });

  it('presents the server schema to the model unchanged', async () => {
    const mcp = manager(configWith({ testing: stdioServer('ok', { trust: 'allow' }) }));
    await mcp.sync();
    const echo = buildMcpTools(mcp).find((t) => t.name === 'mcp__testing__echo')!;

    expect(echo.inputSchema).toMatchObject({ type: 'object', required: ['text'] });
    expect(echo.description).toContain('MCP server');
  });
});
