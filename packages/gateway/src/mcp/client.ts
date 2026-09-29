import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpContentPart[];
  isError: boolean;
  structuredContent?: unknown;
}

export interface McpServerInfo {
  name: string;
  version?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  instructions?: string;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: number | string = 'MCP_ERROR',
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export interface StdioTransportOptions {
  kind: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpTransportOptions {
  kind: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type TransportOptions = StdioTransportOptions | HttpTransportOptions;

export interface McpClientOptions {
  transport: TransportOptions;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  /** Injected in tests. */
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  onLog?: (line: string) => void;
}

/**
 * A Model Context Protocol client.
 *
 * Speaks JSON-RPC 2.0 over either a local process (newline-delimited JSON on stdio) or an HTTP
 * endpoint. It covers what an agent runtime needs — initialize, list tools, call tools — and
 * surfaces protocol and transport failures as McpError rather than hanging.
 */
export class McpClient extends EventEmitter<{ close: [{ reason: string }]; log: [string] }> {
  private child: ChildProcess | undefined;
  private reader: Interface | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private serverInfo: McpServerInfo | undefined;
  private sessionId: string | undefined;
  private closed = false;

  constructor(private readonly options: McpClientOptions) {
    super();
  }

  get info(): McpServerInfo | undefined {
    return this.serverInfo;
  }

  get connected(): boolean {
    return !this.closed && this.serverInfo !== undefined;
  }

  /** Start the transport and complete the MCP handshake. */
  async connect(): Promise<McpServerInfo> {
    if (this.options.transport.kind === 'stdio') this.startProcess(this.options.transport);

    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: {
        name: this.options.clientName ?? 'openpulse',
        version: this.options.clientVersion ?? '0.1.0',
      },
    })) as {
      serverInfo?: { name?: string; version?: string };
      protocolVersion?: string;
      capabilities?: Record<string, unknown>;
      instructions?: string;
    };

    this.serverInfo = {
      name: result.serverInfo?.name ?? 'unknown',
      ...(result.serverInfo?.version !== undefined && { version: result.serverInfo.version }),
      ...(result.protocolVersion !== undefined && { protocolVersion: result.protocolVersion }),
      ...(result.capabilities !== undefined && { capabilities: result.capabilities }),
      ...(result.instructions !== undefined && { instructions: result.instructions }),
    };

    await this.notify('notifications/initialized');
    return this.serverInfo;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDefinition[] };
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined && { title: tool.title }),
      ...(tool.description !== undefined && { description: tool.description }),
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      ...(tool.annotations !== undefined && { annotations: tool.annotations }),
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<McpToolResult> {
    const result = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as {
      content?: McpContentPart[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    return {
      content: result.content ?? [],
      isError: Boolean(result.isError),
      ...(result.structuredContent !== undefined && {
        structuredContent: result.structuredContent,
      }),
    };
  }

  async close(reason = 'closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new McpError(`connection ${reason}`, 'CLOSED'));
    }
    this.pending.clear();
    this.reader?.close();
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
      // Give the server a moment to exit cleanly before insisting.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
    }
    this.child = undefined;
    this.emit('close', { reason });
  }

  // -----------------------------------------------------------------------------------------------

  private startProcess(transport: StdioTransportOptions): void {
    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(transport.command, transport.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(transport.cwd && { cwd: transport.cwd }),
      env: { ...process.env, ...(transport.env ?? {}) },
    });
    this.child = child;

    if (!child.stdout) throw new McpError('the MCP server produced no stdout', 'TRANSPORT');
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.onLine(line));

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        this.options.onLog?.(line);
        this.emit('log', line);
      }
    });
    child.on('error', (error) => void this.fail(`could not start: ${error.message}`));
    child.on(
      'exit',
      (code, signal) => void this.fail(`server exited (${signal ?? code ?? 'unknown'})`),
    );
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      // Servers sometimes print human-readable noise on stdout; keep it for diagnostics.
      this.options.onLog?.(trimmed);
      return;
    }
    this.onMessage(message);
  }

  private onMessage(message: JsonRpcResponse): void {
    if (message.id === undefined) return; // a notification from the server
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new McpError(message.error.message, message.error.code, message.error.data));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  private async fail(reason: string): Promise<void> {
    if (this.closed) return;
    await this.close(reason);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) throw new McpError('the connection is closed', 'CLOSED');
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0' as const, id, method, params };

    if (this.options.transport.kind === 'http') return this.httpRequest(payload, timeoutMs);

    const stdin = this.child?.stdin;
    if (!stdin) throw new McpError('the MCP server is not running', 'TRANSPORT');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new McpError(`${method} timed out`, 'TIMEOUT'));
        },
        timeoutMs ?? this.options.requestTimeoutMs ?? 30_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpError(`could not write to the server: ${error.message}`, 'TRANSPORT'));
      });
    });
  }

  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const payload = { jsonrpc: '2.0' as const, method, params };
    if (this.options.transport.kind === 'http') {
      await this.httpSend(payload).catch(() => undefined);
      return;
    }
    this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private async httpRequest(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await this.httpSend(payload, timeoutMs);
    const text = await response.text();
    const message = parseHttpBody(text);
    if (!message) throw new McpError('the server returned an empty response', 'TRANSPORT');
    if (message.error)
      throw new McpError(message.error.message, message.error.code, message.error.data);
    return message.result ?? {};
  }

  private async httpSend(payload: Record<string, unknown>, timeoutMs?: number): Promise<Response> {
    const transport = this.options.transport as HttpTransportOptions;
    const fetchFn = this.options.fetchFn ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(transport.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...(transport.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs ?? this.options.requestTimeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new McpError(
        `could not reach ${transport.url}: ${(error as Error).message}`,
        'TRANSPORT',
      );
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!response.ok) {
      throw new McpError(`${transport.url} answered ${response.status}`, response.status);
    }
    return response;
  }
}

/** HTTP transports may answer with plain JSON or a one-event SSE stream. */
function parseHttpBody(text: string): JsonRpcResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data && data !== '[DONE]') return JSON.parse(data) as JsonRpcResponse;
  }
  return undefined;
}

/** Flatten an MCP tool result into the text an agent tool returns. */
export function renderToolResult(result: McpToolResult, maxChars = 20_000): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part.type === 'image') parts.push('[image returned by the tool]');
    else if (part.type === 'resource')
      parts.push(`[resource: ${String((part as { uri?: string }).uri ?? 'unknown')}]`);
    else parts.push(`[${part.type}]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.join('\n').trim();
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… truncated`
    : text || '(the tool returned nothing)';
}
