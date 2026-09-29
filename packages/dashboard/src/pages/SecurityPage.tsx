import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Empty, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useQuery } from '../gateway/provider.js';

type Mode = 'read-only' | 'balanced' | 'custom';

interface SecurityState {
  mode: Mode;
  policy: { mode: Mode; readRoots: string[]; writeRoots: string[]; denyPatterns: string[] };
  config: {
    mode: Mode;
    readRoots: string[];
    writeRoots: string[];
    denyPatterns: string[];
    tools: Record<string, boolean>;
  };
  exec: {
    security: string;
    ask: string;
    askFallback: string;
    autoAllowSafe: boolean;
    timeoutSeconds: number;
  };
}

interface ToolInfo {
  name: string;
  description: string;
  source: 'builtin' | 'mcp';
}

const MODES: { id: Mode; title: string; body: string }[] = [
  {
    id: 'read-only',
    title: 'Read only',
    body: 'The agent can read the workspace and your projects. It has no write, edit, shell, process or browser tools at all, and can only propose changes for you to review.',
  },
  {
    id: 'balanced',
    title: 'Balanced',
    body: 'The agent can change files inside your projects and its workspace. Shell commands follow the approval policy below, and anything outside the allowed folders is refused.',
  },
  {
    id: 'custom',
    title: 'Custom',
    body: 'Balanced, plus switch individual tools off. Useful for, say, a chat-only setup with no shell.',
  },
];

export function SecurityPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const state = useQuery<SecurityState>('security.get');
  const tools = useQuery<{ tools: ToolInfo[] }>('tools.list', {}, [state.data?.mode]);
  const [root, setRoot] = useState('');
  const [deny, setDeny] = useState('');

  const data = state.data;
  const setSecurity = (patch: Partial<SecurityState['config']>) =>
    act(async () => {
      await request('security.set', patch);
      state.reload();
      tools.reload();
    }, 'Security settings saved');

  if (!data)
    return (
      <>
        <PageHead title="Permissions" />
        <Card>
          <Empty>{state.error ?? 'Loading…'}</Empty>
        </Card>
      </>
    );

  return (
    <>
      <PageHead
        title="Permissions"
        subtitle="What the agent may touch on this machine. These limits are enforced by the gateway's tools, not just suggested to the model."
      />

      <Card title="Mode">
        <div className="mode-grid">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              className="mode-card"
              aria-pressed={data.mode === mode.id}
              onClick={() => void setSecurity({ mode: mode.id })}
            >
              <strong>{mode.title}</strong>
              <span>{mode.body}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="grid">
        <Card title="Readable folders">
          <Rows
            items={data.policy.readRoots.map((path) => ({ path }))}
            keyOf={(r) => r.path}
            empty="None."
            columns={[
              {
                header: 'Folder',
                render: (r) => (
                  <span className="mono" style={{ fontSize: 12 }}>
                    {r.path}
                  </span>
                ),
              },
              {
                header: '',
                render: (r) =>
                  data.config.readRoots.includes(r.path) ? (
                    <button
                      className="btn ghost"
                      onClick={() =>
                        void setSecurity({
                          readRoots: data.config.readRoots.filter((p) => p !== r.path),
                        })
                      }
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="faint">project or workspace</span>
                  ),
              },
            ]}
          />
        </Card>
        <Card title="Writable folders">
          {data.policy.writeRoots.length === 0 ? (
            <Empty>{data.mode === 'read-only' ? 'None — read-only mode.' : 'None.'}</Empty>
          ) : (
            <Rows
              items={data.policy.writeRoots.map((path) => ({ path }))}
              keyOf={(r) => r.path}
              empty=""
              columns={[
                {
                  header: 'Folder',
                  render: (r) => (
                    <span className="mono" style={{ fontSize: 12 }}>
                      {r.path}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </div>

      <Card title="Allow an extra folder">
        <p className="muted" style={{ marginTop: 0 }}>
          Registered projects are allowed automatically. Add a folder here only when the agent needs
          it outside a project.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="C:\data\shared"
          />
          <button
            className="btn"
            disabled={!root.trim()}
            onClick={() =>
              void setSecurity({ readRoots: [...data.config.readRoots, root.trim()] }).then(() =>
                setRoot(''),
              )
            }
          >
            Allow reading
          </button>
          <button
            className="btn"
            disabled={!root.trim()}
            onClick={() =>
              void setSecurity({
                readRoots: [...data.config.readRoots, root.trim()],
                writeRoots: [...data.config.writeRoots, root.trim()],
              }).then(() => setRoot(''))
            }
          >
            Allow reading and writing
          </button>
        </div>
      </Card>

      <Card title="Always refused">
        <p className="muted" style={{ marginTop: 0 }}>
          Secrets are refused everywhere, even inside an allowed folder.
        </p>
        <div className="chip-list">
          {data.policy.denyPatterns.map((pattern) => (
            <span key={pattern} className="chip mono">
              {pattern}
              {data.config.denyPatterns.includes(pattern) && (
                <button
                  onClick={() =>
                    void setSecurity({
                      denyPatterns: data.config.denyPatterns.filter((p) => p !== pattern),
                    })
                  }
                  aria-label={`Remove ${pattern}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <input
            type="text"
            value={deny}
            onChange={(e) => setDeny(e.target.value)}
            placeholder="**/secrets/**"
          />
          <button
            className="btn"
            disabled={!deny.trim()}
            onClick={() =>
              void setSecurity({ denyPatterns: [...data.config.denyPatterns, deny.trim()] }).then(
                () => setDeny(''),
              )
            }
          >
            Refuse
          </button>
        </div>
      </Card>

      <Card title={data.mode === 'custom' ? 'Tools' : 'Tools available to the agent now'}>
        {data.mode !== 'custom' && (
          <p className="muted" style={{ marginTop: 0 }}>
            Switch to Custom to turn individual tools off.
          </p>
        )}
        <Rows
          items={mergeTools(tools.data?.tools ?? [], data.config.tools)}
          keyOf={(t) => t.name}
          empty="Loading…"
          columns={[
            {
              header: 'On',
              width: '3.5rem',
              render: (t) => (
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  disabled={data.mode !== 'custom'}
                  checked={t.enabled}
                  onChange={(e) =>
                    void setSecurity({
                      tools: { ...data.config.tools, [t.name]: e.target.checked },
                    })
                  }
                />
              ),
            },
            { header: 'Tool', render: (t) => <span className="mono">{t.name}</span> },
            {
              header: 'What it does',
              render: (t) => (
                <span className="faint" style={{ fontSize: 12 }}>
                  {t.description.slice(0, 140)}
                </span>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Shell command approvals">
        <dl className="kv">
          <dt>Policy</dt>
          <dd>{data.exec.security}</dd>
          <dt>Ask</dt>
          <dd>{data.exec.ask}</dd>
          <dt>If nobody answers</dt>
          <dd>{data.exec.askFallback}</dd>
          <dt>Read-only commands</dt>
          <dd>
            {data.exec.autoAllowSafe ? (
              <Pill tone="ok">run without asking</Pill>
            ) : (
              'ask like any other'
            )}
          </dd>
          <dt>Answer within</dt>
          <dd>{data.exec.timeoutSeconds}s</dd>
        </dl>
        <p className="faint" style={{ marginBottom: 0 }}>
          Edit the policy and its allowlist under Diagnostics → Shell approvals.
        </p>
      </Card>
    </>
  );
}

/** Tools the agent has now, plus ones switched off in custom mode (which the gateway omits). */
function mergeTools(
  active: ToolInfo[],
  switches: Record<string, boolean>,
): (ToolInfo & { enabled: boolean })[] {
  const byName = new Map(active.map((tool) => [tool.name, { ...tool, enabled: true }]));
  for (const [name, on] of Object.entries(switches)) {
    if (!on && !byName.has(name))
      byName.set(name, { name, description: 'switched off', source: 'builtin', enabled: false });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
