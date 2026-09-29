import { EventEmitter } from 'node:events';
import type { Logger } from '../infra/logger.js';
import type { McpServerConfig, OpenPulseConfig } from '../config/schema.js';
import {
  McpClient,
  McpError,
  type McpToolDefinition,
  type McpToolResult,
  type TransportOptions,
} from './client.js';

export interface McpServerStatus {
  id: string;
  label: string;
  transport: 'stdio' | 'http';
  /** Where it connects: the command line, or the URL. */
  target: string;
  enabled: boolean;
  state: 'disconnected' | 'connecting' | 'connected' | 'failed';
  trust: 'ask' | 'allow';
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  error?: string;
  toolCount: number;
  connectedAt?: number;
  lastActivityAt?: number;
  logTail: string[];
}

export interface McpToolStatus {
  /** The name the agent sees, e.g. mcp__files__read_file. */
  qualifiedName: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}

interface Connection {
  id: string;
  config: McpServerConfig;
  client?: McpClient;
  status: McpServerStatus;
  tools: McpToolDefinition[];
}

export interface McpManagerDeps {
  config: () => OpenPulseConfig;
  log: Logger;
  /** Injected in tests. */
  createClient?: (
    id: string,
    transport: TransportOptions,
    onLog: (line: string) => void,
  ) => McpClient;
}

/** Tool names are prefixed so an MCP tool can never shadow a built-in one. */
export function qualifiedToolName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Connects the configured MCP servers and keeps track of what they offer.
 *
 * Servers are declared in openpulse.json. Tools they expose become agent tools with a prefixed
 * name, gated by the same allow/deny lists as everything else, and — unless the server is marked
 * trusted — every call asks for approval first.
 */
export class McpManager extends EventEmitter<{ changed: [{ serverId: string; reason: string }] }> {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly deps: McpManagerDeps) {
    super();
    this.setMaxListeners(50);
  }

  /** Bring connections in line with the configuration: connect, disconnect, reconnect as needed. */
  async sync(): Promise<void> {
    const configured = this.deps.config().mcp.servers;

    for (const [id, connection] of this.connections) {
      const next = configured[id];
      if (!next || !next.enabled) {
        await this.disconnect(id);
        if (!next) this.connections.delete(id);
        continue;
      }
      // Only a change to how we reach the server warrants a reconnect; trust and tool switches
      // take effect immediately without dropping the connection.
      if (connectionKey(next) !== connectionKey(connection.config)) {
        await this.disconnect(id);
        connection.config = next;
        connection.status = initialStatus(id, next);
        await this.connect(id);
      } else {
        connection.config = next;
        connection.status.label = next.label ?? id;
        connection.status.trust = next.trust;
      }
    }

    for (const [id, config] of Object.entries(configured)) {
      if (this.connections.has(id)) continue;
      this.connections.set(id, { id, config, status: initialStatus(id, config), tools: [] });
      if (config.enabled) await this.connect(id);
    }
  }

  async connect(id: string): Promise<McpServerStatus> {
    const connection = this.connections.get(id);
    if (!connection) throw new McpError(`No MCP server called "${id}" is configured.`, 'NOT_FOUND');
    if (connection.client?.connected) return connection.status;

    connection.status.state = 'connecting';
    delete connection.status.error;
    this.emit('changed', { serverId: id, reason: 'connecting' });

    const transport = transportOf(connection.config);
    const onLog = (line: string) => {
      connection.status.logTail.push(line);
      if (connection.status.logTail.length > 50) connection.status.logTail.shift();
    };
    const client = this.deps.createClient
      ? this.deps.createClient(id, transport, onLog)
      : new McpClient({
          transport,
          clientName: 'openpulse',
          onLog,
          requestTimeoutMs: connection.config.timeoutMs,
        });
    connection.client = client;

    client.on('close', ({ reason }) => {
      connection.status.state = connection.status.state === 'failed' ? 'failed' : 'disconnected';
      if (reason && reason !== 'closed') connection.status.error = reason;
      connection.status.toolCount = 0;
      connection.tools = [];
      this.emit('changed', { serverId: id, reason: 'closed' });
    });

    try {
      const info = await client.connect();
      connection.tools = await client.listTools();
      connection.status = {
        ...connection.status,
        state: 'connected',
        serverName: info.name,
        ...(info.version !== undefined && { serverVersion: info.version }),
        ...(info.protocolVersion !== undefined && { protocolVersion: info.protocolVersion }),
        toolCount: connection.tools.length,
        connectedAt: Date.now(),
      };
      delete connection.status.error;
      this.deps.log.info(`mcp connected: ${id} (${connection.tools.length} tools)`, {
        server: info.name,
      });
      this.emit('changed', { serverId: id, reason: 'connected' });
      return connection.status;
    } catch (error) {
      connection.status.state = 'failed';
      connection.status.error = (error as Error).message;
      connection.status.toolCount = 0;
      connection.tools = [];
      await client.close('failed').catch(() => undefined);
      connection.client = undefined;
      this.deps.log.warn(`mcp connection failed: ${id}: ${(error as Error).message}`);
      this.emit('changed', { serverId: id, reason: 'failed' });
      return connection.status;
    }
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection?.client) return;
    await connection.client.close('disconnected').catch(() => undefined);
    connection.client = undefined;
    connection.tools = [];
    connection.status.state = 'disconnected';
    connection.status.toolCount = 0;
    delete connection.status.connectedAt;
    this.emit('changed', { serverId: id, reason: 'disconnected' });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  status(): McpServerStatus[] {
    // Configured-but-never-connected servers still show up, so the UI can explain why.
    const configured = this.deps.config().mcp.servers;
    for (const [id, config] of Object.entries(configured)) {
      if (!this.connections.has(id)) {
        this.connections.set(id, { id, config, status: initialStatus(id, config), tools: [] });
      }
    }
    return [...this.connections.values()].map((c) => ({
      ...c.status,
      logTail: [...c.status.logTail],
    }));
  }

  /** Every discovered tool, with the enabled flag the config gives it. */
  tools(): McpToolStatus[] {
    const out: McpToolStatus[] = [];
    for (const connection of this.connections.values()) {
      for (const tool of connection.tools) {
        out.push({
          qualifiedName: qualifiedToolName(connection.id, tool.name),
          serverId: connection.id,
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          inputSchema: tool.inputSchema,
          enabled: this.toolEnabled(connection.config, tool.name, connection.id),
        });
      }
    }
    return out.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  }

  /** Tools an agent run may use: connected servers, enabled tools only. */
  activeTools(): (McpToolStatus & { trust: 'ask' | 'allow'; serverLabel: string })[] {
    return this.tools()
      .filter((tool) => {
        const connection = this.connections.get(tool.serverId);
        return tool.enabled && connection?.status.state === 'connected';
      })
      .map((tool) => {
        const connection = this.connections.get(tool.serverId)!;
        return { ...tool, trust: connection.config.trust, serverLabel: connection.status.label };
      });
  }

  async callTool(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const connection = this.connections.get(serverId);
    if (!connection) throw new McpError(`No MCP server called "${serverId}".`, 'NOT_FOUND');
    if (!connection.client?.connected) {
      throw new McpError(
        `The MCP server "${connection.status.label}" is not connected.`,
        'DISCONNECTED',
      );
    }
    if (!this.toolEnabled(connection.config, tool, serverId)) {
      throw new McpError(
        `The tool "${tool}" is switched off for "${connection.status.label}".`,
        'DISABLED',
      );
    }
    const result = await connection.client.callTool(tool, args, connection.config.timeoutMs);
    connection.status.lastActivityAt = Date.now();
    return result;
  }

  /** Read the live config so a tool toggle applies without a reconnect. */
  private toolEnabled(config: McpServerConfig, tool: string, serverId?: string): boolean {
    const live = serverId ? (this.deps.config().mcp.servers[serverId] ?? config) : config;
    if (live.tools.deny.includes(tool)) return false;
    if (live.tools.allow && live.tools.allow.length > 0) return live.tools.allow.includes(tool);
    return true;
  }
}

function initialStatus(id: string, config: McpServerConfig): McpServerStatus {
  return {
    id,
    label: config.label ?? id,
    transport: config.transport,
    target:
      config.transport === 'stdio'
        ? [config.command, ...(config.args ?? [])].join(' ')
        : (config.url ?? ''),
    enabled: config.enabled,
    state: 'disconnected',
    trust: config.trust,
    toolCount: 0,
    logTail: [],
  };
}

function transportOf(config: McpServerConfig): TransportOptions {
  if (config.transport === 'http') {
    if (!config.url) throw new McpError('An HTTP MCP server needs a url.', 'INVALID');
    return { kind: 'http', url: config.url, ...(config.headers && { headers: config.headers }) };
  }
  if (!config.command) throw new McpError('A stdio MCP server needs a command.', 'INVALID');
  return {
    kind: 'stdio',
    command: config.command,
    ...(config.args && { args: config.args }),
    ...(config.env && { env: config.env }),
    ...(config.cwd && { cwd: config.cwd }),
  };
}

/** The parts of a server definition that decide whether an existing connection can be kept. */
function connectionKey(config: McpServerConfig): string {
  return JSON.stringify([
    config.enabled,
    config.transport,
    config.command,
    config.args,
    config.env,
    config.cwd,
    config.url,
    config.headers,
    config.timeoutMs,
  ]);
}
