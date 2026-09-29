import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { Card, Empty, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { duration, logTime, relativeTime } from '../format.js';

interface RunSummary {
  runId: string;
  sessionKey: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'error' | 'aborted';
  model?: string;
  toolCalls: number;
  errors: number;
  error?: string;
  eventCount?: number;
}

interface TraceEvent {
  ts: number;
  kind:
    | 'run.start'
    | 'run.end'
    | 'run.error'
    | 'thinking'
    | 'assistant'
    | 'tool.start'
    | 'tool.result'
    | 'approval';
  label: string;
  tool?: string;
  toolCallId?: string;
  durationMs?: number;
  isError?: boolean;
  data?: Record<string, unknown>;
}

interface RunTrace extends RunSummary {
  usage?: { input: number; output: number };
  events: TraceEvent[];
}

const KIND_LABELS: Record<TraceEvent['kind'], string> = {
  'run.start': 'start',
  'run.end': 'end',
  'run.error': 'error',
  thinking: 'reasoning',
  assistant: 'output',
  'tool.start': 'tool call',
  'tool.result': 'tool result',
  approval: 'approval',
};

export function DebuggerPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [status, setStatus] = useState('');
  const [session, setSession] = useState('');
  const runs = useQuery<{ runs: RunSummary[] }>(
    'debug.runs',
    {
      limit: 100,
      ...(status && { status }),
      ...(session.trim() && { sessionKey: session.trim() }),
    },
    [status, session],
  );
  const [selected, setSelected] = useState<string>();
  const trace = useQuery<{ trace: RunTrace }>('debug.trace', { runId: selected ?? '' }, [selected]);
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  useGatewayEvent('agent', (payload) => {
    const event = payload as { runId: string; stream: string; data: { phase?: string } };
    if (event.stream === 'lifecycle') runs.reload();
    if (event.runId === selected) trace.reload();
  });

  const events = useMemo(() => {
    const all = trace.data?.trace.events ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter(
      (e) =>
        (kinds.size === 0 || kinds.has(e.kind)) &&
        (!needle ||
          e.label.toLowerCase().includes(needle) ||
          JSON.stringify(e.data ?? {})
            .toLowerCase()
            .includes(needle)),
    );
  }, [trace.data, kinds, search]);

  const download = async (
    filename: string,
    params: Record<string, unknown>,
    method = 'debug.export',
  ) => {
    const data = await request<unknown>(method, params);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const current = trace.data?.trace;

  return (
    <>
      <PageHead
        title="Debugger"
        subtitle="Every agent run as it actually happened: model, reasoning, tool calls with inputs, outputs and timing. Secrets are redacted."
        actions={
          <button
            className="btn"
            onClick={() =>
              void act(
                () => download(`openpulse-diagnostics-${Date.now()}.json`, {}, 'debug.diagnostics'),
                'Diagnostics saved',
              )
            }
          >
            Export diagnostics
          </button>
        }
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(18rem, 26rem) 1fr' }}>
        <Card title="Runs">
          <div className="toolbar">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              style={{ width: 'auto' }}
            >
              <option value="">All</option>
              <option value="running">Running</option>
              <option value="ok">Finished</option>
              <option value="error">Failed</option>
              <option value="aborted">Stopped</option>
            </select>
            <input
              type="text"
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder="Session key"
            />
          </div>
          <Rows
            items={runs.data?.runs ?? []}
            keyOf={(r) => r.runId}
            empty="No runs recorded since the gateway started."
            onRowClick={(r) => setSelected(r.runId)}
            columns={[
              { header: '', width: '5rem', render: (r) => <StatusPill status={r.status} /> },
              {
                header: 'Run',
                render: (r) => (
                  <>
                    <div
                      className="mono"
                      style={{ fontSize: 11, fontWeight: r.runId === selected ? 700 : 400 }}
                    >
                      {r.sessionKey}
                    </div>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {r.model ?? ''} · {r.toolCalls} tools{r.errors ? ` · ${r.errors} errors` : ''}{' '}
                      · {relativeTime(r.startedAt)}
                    </span>
                  </>
                ),
              },
            ]}
          />
        </Card>

        {current ? (
          <Card
            title="Timeline"
            actions={
              <span style={{ display: 'flex', gap: '0.4rem' }}>
                {current.status === 'running' && (
                  <button
                    className="btn danger"
                    onClick={() =>
                      void act(
                        () => request('chat.abort', { sessionKey: current.sessionKey }),
                        'Stop requested',
                      )
                    }
                  >
                    Cancel run
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() =>
                    void act(
                      () =>
                        download(`openpulse-run-${current.runId.slice(0, 8)}.json`, {
                          runId: current.runId,
                        }),
                      'Trace saved',
                    )
                  }
                >
                  Export run
                </button>
              </span>
            }
          >
            <dl className="kv">
              <dt>Run</dt>
              <dd className="mono">{current.runId}</dd>
              <dt>Session</dt>
              <dd className="mono">{current.sessionKey}</dd>
              <dt>Model</dt>
              <dd>{current.model ?? '—'}</dd>
              <dt>Status</dt>
              <dd>
                <StatusPill status={current.status} />{' '}
                {current.error && <span style={{ color: 'var(--err)' }}>{current.error}</span>}
              </dd>
              <dt>Duration</dt>
              <dd>{current.endedAt ? duration(current.endedAt - current.startedAt) : 'running'}</dd>
              <dt>Tokens</dt>
              <dd>
                {current.usage
                  ? `${current.usage.input} in · ${current.usage.output} out`
                  : 'not reported'}
              </dd>
            </dl>

            <div className="toolbar" style={{ marginTop: '0.75rem' }}>
              {(Object.keys(KIND_LABELS) as TraceEvent['kind'][]).map((kind) => (
                <label
                  key={kind}
                  style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', fontSize: 12 }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={kinds.has(kind)}
                    onChange={(e) =>
                      setKinds((current) => {
                        const next = new Set(current);
                        if (e.target.checked) next.add(kind);
                        else next.delete(kind);
                        return next;
                      })
                    }
                  />
                  {KIND_LABELS[kind]}
                </label>
              ))}
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the trace…"
                style={{ maxWidth: '14rem' }}
              />
            </div>

            <div className="timeline">
              {events.length === 0 && <Empty>No events match.</Empty>}
              {events.map((event, index) => (
                <details
                  key={index}
                  className={`timeline-event ${event.isError || event.kind === 'run.error' ? 'error' : ''}`}
                >
                  <summary>
                    <span className="mono faint" style={{ fontSize: 11 }}>
                      {logTime(event.ts)}
                    </span>
                    <span className={`timeline-kind kind-${event.kind.replace('.', '-')}`}>
                      {KIND_LABELS[event.kind]}
                    </span>
                    <span className="timeline-label">{event.label}</span>
                    {event.durationMs !== undefined && (
                      <span className="faint" style={{ fontSize: 11 }}>
                        {duration(event.durationMs)}
                      </span>
                    )}
                  </summary>
                  {event.data && (
                    <pre className="log-view" style={{ height: 'auto', maxHeight: '18rem' }}>
                      {typeof event.data.text === 'string'
                        ? event.data.text
                        : typeof event.data.output === 'string'
                          ? event.data.output
                          : JSON.stringify(event.data, null, 2)}
                    </pre>
                  )}
                </details>
              ))}
            </div>
          </Card>
        ) : (
          <Card>
            <Empty>Pick a run to see its timeline.</Empty>
          </Card>
        )}
      </div>
    </>
  );
}

function StatusPill({ status }: { status: RunSummary['status'] }): JSX.Element {
  return (
    <Pill
      tone={
        status === 'ok' ? 'ok' : status === 'running' ? 'warn' : status === 'error' ? 'err' : 'idle'
      }
    >
      {status}
    </Pill>
  );
}
