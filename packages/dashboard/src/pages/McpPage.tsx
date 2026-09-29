import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { duration, relativeTime } from '../format.js';

interface ServerStatus {
  id: string;
  label: string;
  transport: 'stdio' | 'http';
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

interface ToolStatus {
  qualifiedName: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}

export function McpPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const status = useQuery<{ servers: ServerStatus[]; tools: ToolStatus[] }>('mcp.status');
  const [openTool, setOpenTool] = useState<ToolStatus>();

  useGatewayEvent('mcp.changed', () => status.reload());

  const servers = status.data?.servers ?? [];
  const tools = status.data?.tools ?? [];

  return (
    <>
      <PageHead
        title="MCP servers"
        subtitle="Connect Model Context Protocol servers. Their tools join the agent's toolbox, under the same approval rules as shell commands."
        actions={
          <button className="btn" onClick={() => status.reload()}>
            Refresh
          </button>
        }
      />

      <Card title="Servers">
        <Rows
          items={servers}
          keyOf={(s) => s.id}
          empty="No MCP servers configured. Add one below."
          columns={[
            {
              header: '',
              width: '6.5rem',
              render: (s) => (
                <Pill
                  tone={
                    s.state === 'connected'
                      ? 'ok'
                      : s.state === 'failed'
                        ? 'err'
                        : s.state === 'connecting'
                          ? 'warn'
                          : 'idle'
                  }
                >
                  {s.state}
                </Pill>
              ),
            },
            {
              header: 'Server',
              render: (s) => (
                <>
                  <div>
                    {s.label}{' '}
                    <span className="faint mono" style={{ fontSize: 11 }}>
                      ({s.id})
                    </span>
                  </div>
                  <span className="faint mono" style={{ fontSize: 11 }}>
                    {s.transport} · {s.target}
                  </span>
                  {s.error && <div style={{ color: 'var(--err)', fontSize: 12 }}>{s.error}</div>}
                </>
              ),
            },
            {
              header: 'Reports as',
              render: (s) =>
                s.serverName
                  ? `${s.serverName}${s.serverVersion ? ` ${s.serverVersion}` : ''}`
                  : '—',
            },
            { header: 'Tools', render: (s) => s.toolCount },
            {
              header: 'Approval',
              render: (s) =>
                s.trust === 'allow' ? (
                  <Pill tone="warn">trusted</Pill>
                ) : (
                  <Pill tone="ok">asks</Pill>
                ),
            },
            {
              header: 'Last activity',
              render: (s) => relativeTime(s.lastActivityAt ?? s.connectedAt),
            },
            {
              header: '',
              render: (s) => (
                <span style={{ display: 'flex', gap: '0.4rem' }}>
                  {s.state === 'connected' ? (
                    <button
                      className="btn"
                      onClick={() =>
                        void act(() => request('mcp.disconnect', { id: s.id }), 'Disconnected')
                      }
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      onClick={() => void act(() => request('mcp.connect', { id: s.id }, 60_000))}
                    >
                      Connect
                    </button>
                  )}
                  <button
                    className="btn danger"
                    onClick={() => {
                      if (!window.confirm(`Remove the MCP server "${s.label}"?`)) return;
                      void act(() => request('mcp.remove', { id: s.id }), 'Server removed');
                    }}
                  >
                    Remove
                  </button>
                </span>
              ),
            },
          ]}
        />
        {servers.some((s) => s.logTail.length > 0) && (
          <details style={{ marginTop: '0.75rem' }}>
            <summary className="faint">Server output</summary>
            {servers
              .filter((s) => s.logTail.length)
              .map((s) => (
                <pre key={s.id} className="log-view" style={{ height: 'auto', maxHeight: '12rem' }}>
                  {`[${s.id}]\n${s.logTail.join('\n')}`}
                </pre>
              ))}
          </details>
        )}
      </Card>

      <Card title="Tools">
        <Rows
          items={tools}
          keyOf={(t) => t.qualifiedName}
          empty="Connected servers' tools appear here."
          onRowClick={setOpenTool}
          columns={[
            {
              header: 'On',
              width: '3.5rem',
              render: (t) => (
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={t.enabled}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    void act(() =>
                      request('mcp.tool.set', {
                        id: t.serverId,
                        tool: t.name,
                        enabled: event.target.checked,
                      }),
                    )
                  }
                />
              ),
            },
            {
              header: 'Tool',
              render: (t) => (
                <>
                  <div className="mono">{t.qualifiedName}</div>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {t.description}
                  </span>
                </>
              ),
            },
            { header: 'Server', render: (t) => t.serverId },
          ]}
        />
      </Card>

      {openTool && <TryTool tool={openTool} onClose={() => setOpenTool(undefined)} />}

      <AddServer onAdded={() => status.reload()} />
    </>
  );
}

function TryTool({ tool, onClose }: { tool: ToolStatus; onClose: () => void }): JSX.Element {
  const { request } = useGateway();
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<
    { text: string; isError: boolean; durationMs: number } | { error: string }
  >();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(args || '{}') as Record<string, unknown>;
      setResult(
        await request<{ text: string; isError: boolean; durationMs: number }>(
          'mcp.call',
          { id: tool.serverId, tool: tool.name, args: parsed },
          120_000,
        ),
      );
    } catch (e) {
      setResult({ error: (e as Error).message });
    }
    setBusy(false);
  };

  return (
    <Card
      title={`Try ${tool.qualifiedName}`}
      actions={
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Calls the tool directly, as you. Agents calling it still go through the approval rules.
      </p>
      <details>
        <summary className="faint">Input schema</summary>
        <pre className="log-view" style={{ height: 'auto', maxHeight: '14rem' }}>
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      </details>
      <Field label="Arguments (JSON)">
        <textarea
          rows={4}
          className="mono"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </Field>
      <button className="btn primary" disabled={busy || !tool.enabled} onClick={() => void run()}>
        {busy ? 'Calling…' : 'Call tool'}
      </button>
      {result &&
        ('error' in result ? (
          <p style={{ color: 'var(--err)' }}>{result.error}</p>
        ) : (
          <>
            <p className="faint" style={{ fontSize: 12 }}>
              {result.isError ? 'The tool reported an error' : 'Returned'} in{' '}
              {duration(result.durationMs)}
            </p>
            <pre className="log-view" style={{ height: 'auto', maxHeight: '18rem' }}>
              {result.text}
            </pre>
          </>
        ))}
    </Card>
  );
}

function AddServer({ onAdded }: { onAdded: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [form, setForm] = useState({
    id: '',
    label: '',
    transport: 'stdio' as 'stdio' | 'http',
    command: '',
    args: '',
    url: '',
    env: '',
    trust: 'ask' as 'ask' | 'allow',
  });

  const submit = () =>
    act(async () => {
      const env = Object.fromEntries(
        form.env
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes('='))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      await request(
        'mcp.add',
        {
          id: form.id.trim(),
          ...(form.label.trim() && { label: form.label.trim() }),
          transport: form.transport,
          trust: form.trust,
          ...(form.transport === 'stdio'
            ? {
                command: form.command.trim(),
                args: form.args.trim() ? splitArgs(form.args.trim()) : [],
                ...(Object.keys(env).length > 0 && { env }),
              }
            : { url: form.url.trim() }),
        },
        60_000,
      );
      setForm({ ...form, id: '', label: '', command: '', args: '', url: '', env: '' });
      onAdded();
    }, 'Server added');

  return (
    <Card title="Add a server">
      <div className="grid">
        <Field label="Id">
          <input
            type="text"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
            placeholder="filesystem"
          />
        </Field>
        <Field label="Label">
          <input
            type="text"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="Filesystem"
          />
        </Field>
        <Field label="Transport">
          <select
            value={form.transport}
            onChange={(e) => setForm({ ...form, transport: e.target.value as 'stdio' | 'http' })}
          >
            <option value="stdio">Local process (stdio)</option>
            <option value="http">Remote (HTTP)</option>
          </select>
        </Field>
        <Field label="Approval">
          <select
            value={form.trust}
            onChange={(e) => setForm({ ...form, trust: e.target.value as 'ask' | 'allow' })}
          >
            <option value="ask">Ask before every tool call (recommended)</option>
            <option value="allow">Trusted — run without asking</option>
          </select>
        </Field>
      </div>
      {form.transport === 'stdio' ? (
        <div className="grid">
          <Field label="Command">
            <input
              type="text"
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              placeholder="npx"
            />
          </Field>
          <Field label="Arguments">
            <input
              type="text"
              value={form.args}
              onChange={(e) => setForm({ ...form, args: e.target.value })}
              placeholder="-y @modelcontextprotocol/server-filesystem C:\projects"
            />
          </Field>
          <Field label="Environment (KEY=value per line)">
            <textarea
              rows={2}
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value })}
            />
          </Field>
        </div>
      ) : (
        <Field label="URL">
          <input
            type="text"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://mcp.example.com/mcp"
          />
        </Field>
      )}
      <button
        className="btn primary"
        disabled={
          !form.id.trim() || (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())
        }
        onClick={() => void submit()}
      >
        Add and connect
      </button>
      {form.trust === 'allow' && (
        <p style={{ color: 'var(--warn)', fontSize: 12 }}>
          A trusted server's tools run without asking. Only trust servers whose code you have read.
        </p>
      )}
    </Card>
  );
}

/** Split an argument string on spaces, keeping "quoted parts" together. */
function splitArgs(input: string): string[] {
  return (input.match(/"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^"|"$/g, ''));
}
