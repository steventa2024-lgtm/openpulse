import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Card, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { bytes, relativeTime } from '../format.js';
import type { PendingApproval, WorkspaceFile } from '../types.js';

interface AllowEntry {
  id: string;
  pattern: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
}

interface ApprovalsFile {
  path: string;
  file: {
    version: number;
    defaults: {
      security: 'deny' | 'allowlist' | 'full';
      ask: 'off' | 'on-miss' | 'always';
      askFallback: 'deny' | 'allowlist' | 'full';
      autoAllowSafe: boolean;
      timeoutSeconds: number;
    };
    agents: Record<string, { allowlist: AllowEntry[] }>;
  };
}

export function DebugPage(): JSX.Element {
  return (
    <>
      <PageHead title="Debug" subtitle="Workspace files, shell approvals and a raw RPC console" />
      <WorkspaceFiles />
      <Approvals />
      <RpcConsole />
    </>
  );
}

function WorkspaceFiles(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const files = useQuery<{ workspace: string; files: WorkspaceFile[] }>('agents.files.list');
  const [name, setName] = useState('AGENTS.md');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const apply = (text: string) => {
      if (cancelled) return;
      setContent(text);
      setDirty(false);
    };
    request<{ content: string }>('agents.files.get', { name })
      .then((r) => apply(r.content))
      .catch(() => apply(''));
    return () => {
      cancelled = true;
    };
  }, [name, request]);

  return (
    <Card
      title="Workspace files"
      actions={
        <button
          className="btn primary"
          disabled={!dirty}
          onClick={() =>
            void act(async () => {
              await request('agents.files.set', { name, content });
              setDirty(false);
              files.reload();
            }, `${name} saved`)
          }
        >
          Save
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        These files are injected into every prompt as Project Context.{' '}
        <span className="mono">{files.data?.workspace}</span>
      </p>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        {(files.data?.files ?? []).map((file) => (
          <button
            key={file.name}
            className={`btn ${file.name === name ? 'primary' : ''}`}
            onClick={() => setName(file.name)}
          >
            {file.name}
            <span className="faint" style={{ marginLeft: '0.3rem' }}>
              {file.exists ? bytes(file.size) : 'new'}
            </span>
          </button>
        ))}
      </div>
      <textarea
        className="editor"
        spellCheck={false}
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          setDirty(true);
        }}
      />
    </Card>
  );
}

function Approvals(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const policy = useQuery<ApprovalsFile>('exec.approvals.get');
  const pending = useQuery<{ pending: PendingApproval[] }>('exec.approval.list');
  const [pattern, setPattern] = useState('');

  useGatewayEvent(['exec.approval.requested', 'exec.approval.resolved'], () => pending.reload());

  const file = policy.data?.file;

  const update = (patch: Partial<ApprovalsFile['file']['defaults']>) => {
    if (!file) return;
    void act(async () => {
      await request('exec.approvals.set', {
        file: { ...file, defaults: { ...file.defaults, ...patch } },
      });
      policy.reload();
    }, 'Policy updated');
  };

  const writeAllowlist = (allowlist: AllowEntry[], message: string) => {
    if (!file) return;
    void act(async () => {
      await request('exec.approvals.set', {
        file: { ...file, agents: { ...file.agents, main: { ...file.agents.main, allowlist } } },
      });
      setPattern('');
      policy.reload();
    }, message);
  };

  const allow = file?.agents.main?.allowlist ?? [];

  return (
    <Card title="Shell approvals">
      <Rows
        items={pending.data?.pending ?? []}
        keyOf={(approval) => approval.id}
        empty="Nothing waiting for approval."
        columns={[
          {
            header: 'Risk',
            width: '7rem',
            render: (approval) => (
              <Pill tone={approval.request.risk.level === 'low' ? 'ok' : 'warn'}>
                {approval.request.risk.level}
              </Pill>
            ),
          },
          {
            header: 'Command',
            render: (approval) => <span className="mono">{approval.request.command}</span>,
          },
          { header: 'Asked', render: (approval) => relativeTime(approval.createdAtMs) },
          {
            header: '',
            render: (approval) => (
              <span style={{ display: 'flex', gap: '0.4rem' }}>
                {(['allow-once', 'allow-always', 'deny'] as const).map((decision) => (
                  <button
                    key={decision}
                    className={`btn ${decision === 'deny' ? 'danger' : decision === 'allow-once' ? 'primary' : ''}`}
                    onClick={() =>
                      void act(async () => {
                        await request('exec.approval.resolve', { id: approval.id, decision });
                        pending.reload();
                      })
                    }
                  >
                    {decision === 'allow-once'
                      ? 'Once'
                      : decision === 'allow-always'
                        ? 'Always'
                        : 'Deny'}
                  </button>
                ))}
              </span>
            ),
          },
        ]}
      />

      <div className="grid" style={{ marginTop: '1rem' }}>
        <Field label="Security">
          <select
            value={file?.defaults.security ?? 'allowlist'}
            onChange={(event) =>
              update({ security: event.target.value as 'deny' | 'allowlist' | 'full' })
            }
          >
            <option value="deny">deny — no shell at all</option>
            <option value="allowlist">allowlist — only matching commands</option>
            <option value="full">full — anything (still risk-checked)</option>
          </select>
        </Field>
        <Field label="Ask">
          <select
            value={file?.defaults.ask ?? 'on-miss'}
            onChange={(event) =>
              update({ ask: event.target.value as 'off' | 'on-miss' | 'always' })
            }
          >
            <option value="off">off — never ask</option>
            <option value="on-miss">on-miss — ask when not allowlisted</option>
            <option value="always">always — ask every time</option>
          </select>
        </Field>
        <Field label="Read-only commands">
          <select
            value={file?.defaults.autoAllowSafe ? 'auto' : 'ask'}
            onChange={(event) => update({ autoAllowSafe: event.target.value === 'auto' })}
          >
            <option value="auto">run without asking (ls, cat, git status…)</option>
            <option value="ask">treat like anything else</option>
          </select>
        </Field>
        <Field label="If nobody answers">
          <select
            value={file?.defaults.askFallback ?? 'deny'}
            onChange={(event) =>
              update({ askFallback: event.target.value as 'deny' | 'allowlist' | 'full' })
            }
          >
            <option value="deny">deny the command</option>
            <option value="allowlist">fall back to the allowlist</option>
            <option value="full">allow it</option>
          </select>
        </Field>
      </div>

      <Field label="Allowlist (glob patterns for the main agent)">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            value={pattern}
            placeholder="git status*"
            onChange={(event) => setPattern(event.target.value)}
          />
          <button
            className="btn"
            disabled={!pattern.trim()}
            onClick={() =>
              allow.some((entry) => entry.pattern === pattern.trim())
                ? undefined
                : writeAllowlist(
                    [...allow, { id: crypto.randomUUID().slice(0, 8), pattern: pattern.trim() }],
                    'Pattern added',
                  )
            }
          >
            Add
          </button>
        </div>
      </Field>
      <Rows
        items={allow}
        keyOf={(row) => row.id}
        empty="No patterns — every command goes through the ask policy."
        columns={[
          { header: 'Pattern', render: (row) => <span className="mono">{row.pattern}</span> },
          {
            header: '',
            render: (row) => (
              <button
                className="btn danger"
                onClick={() =>
                  writeAllowlist(
                    allow.filter((entry) => entry.id !== row.id),
                    'Pattern removed',
                  )
                }
              >
                Remove
              </button>
            ),
          },
        ]}
      />
      <p className="faint" style={{ marginBottom: 0 }}>
        <span className="mono">{policy.data?.path}</span>
      </p>
    </Card>
  );
}

function RpcConsole(): JSX.Element {
  const { request, status } = useGateway();
  const [method, setMethod] = useState('status');
  const [params, setParams] = useState('{}');
  const [result, setResult] = useState('');
  const methods = status.hello?.features.methods ?? [];

  const call = async () => {
    try {
      const parsed = params.trim() ? (JSON.parse(params) as Record<string, unknown>) : {};
      const response = await request(method, parsed);
      setResult(JSON.stringify(response, null, 2));
    } catch (error) {
      setResult(`${(error as Error).name}: ${(error as Error).message}`);
    }
  };

  return (
    <Card title="RPC console">
      <div
        style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.5rem' }}
      >
        <Field label="Method">
          <select value={method} onChange={(event) => setMethod(event.target.value)}>
            {methods.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Params (JSON)">
          <input type="text" value={params} onChange={(event) => setParams(event.target.value)} />
        </Field>
        <button
          className="btn primary"
          style={{ marginBottom: '0.75rem' }}
          onClick={() => void call()}
        >
          Call
        </button>
      </div>
      <pre className="log-view" style={{ height: '16rem' }}>
        {result || 'No call yet.'}
      </pre>
    </Card>
  );
}
