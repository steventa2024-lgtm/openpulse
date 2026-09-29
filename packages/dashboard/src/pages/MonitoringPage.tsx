import type { JSX } from 'react';
import { useState } from 'react';
import { Card, PageHead, Pill, Rows, Stat } from '../components/ui.js';
import { useGatewayEvent, useQuery } from '../gateway/provider.js';
import { compactNumber, duration, relativeTime } from '../format.js';

interface ModelSummary {
  model: string;
  provider: string;
  runs: number;
  errors: number;
  aborted: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  averageDurationMs: number;
  p95DurationMs: number;
  lastUsedAt: number;
}

interface Summary {
  runs: number;
  errors: number;
  aborted: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  models: ModelSummary[];
  topTools: { tool: string; calls: number; errors: number; averageDurationMs: number }[];
  activity: { hour: number; runs: number; errors: number }[];
}

interface RunRecord {
  ts: number;
  runId: string;
  sessionKey: string;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  status: 'ok' | 'error' | 'aborted';
  error?: string;
  source?: string;
}

const WINDOWS = [
  { hours: 1, label: 'Last hour' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
];

export function MonitoringPage(): JSX.Element {
  const [hours, setHours] = useState(24);
  const [model, setModel] = useState('');
  const summary = useQuery<Summary>('telemetry.summary', { hours }, [hours]);
  const runs = useQuery<{ runs: RunRecord[] }>(
    'telemetry.runs',
    { hours, limit: 100, ...(model && { model }) },
    [hours, model],
  );

  useGatewayEvent('agent', (payload) => {
    const event = payload as { stream: string; data: { phase?: string } };
    if (
      event.stream === 'lifecycle' &&
      (event.data.phase === 'end' || event.data.phase === 'error')
    ) {
      summary.reload();
      runs.reload();
    }
  });

  const data = summary.data;
  const errorRate = data && data.runs ? Math.round((data.errors / data.runs) * 100) : 0;

  return (
    <>
      <PageHead
        title="Monitoring"
        subtitle="What the agent loop measured. Token counts are the ones providers report; many local models report none."
        actions={
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            style={{ width: 'auto' }}
          >
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </select>
        }
      />

      <div className="grid">
        <Card>
          <Stat
            label="Runs"
            value={data?.runs ?? 0}
            hint={data?.aborted ? `${data.aborted} stopped` : undefined}
          />
        </Card>
        <Card>
          <Stat
            label="Errors"
            value={data?.errors ?? 0}
            hint={data?.runs ? `${errorRate}% of runs` : undefined}
          />
        </Card>
        <Card>
          <Stat
            label="Tokens"
            value={compactNumber((data?.inputTokens ?? 0) + (data?.outputTokens ?? 0))}
            hint={
              data
                ? `${compactNumber(data.inputTokens)} in · ${compactNumber(data.outputTokens)} out`
                : undefined
            }
          />
        </Card>
        <Card>
          <Stat label="Tool calls" value={data?.toolCalls ?? 0} />
        </Card>
      </div>

      <Card title="Activity">
        <ActivityChart activity={data?.activity ?? []} />
      </Card>

      <Card title="By model">
        <Rows
          items={data?.models ?? []}
          keyOf={(m) => m.model}
          empty="No runs in this window."
          onRowClick={(m) => setModel(m.model === model ? '' : m.model)}
          columns={[
            {
              header: 'Model',
              render: (m) => (
                <span className="mono" style={{ fontWeight: m.model === model ? 700 : 400 }}>
                  {m.model}
                </span>
              ),
            },
            { header: 'Runs', render: (m) => m.runs },
            {
              header: 'Errors',
              render: (m) =>
                m.errors ? <span style={{ color: 'var(--err)' }}>{m.errors}</span> : 0,
            },
            { header: 'Avg time', render: (m) => duration(m.averageDurationMs) },
            { header: 'p95', render: (m) => duration(m.p95DurationMs) },
            {
              header: 'Tokens in / out',
              render: (m) =>
                m.inputTokens || m.outputTokens ? (
                  `${compactNumber(m.inputTokens)} / ${compactNumber(m.outputTokens)}`
                ) : (
                  <span className="faint">not reported</span>
                ),
            },
            { header: 'Last used', render: (m) => relativeTime(m.lastUsedAt) },
          ]}
        />
      </Card>

      <div className="grid">
        <Card title="Most used tools">
          <Rows
            items={data?.topTools ?? []}
            keyOf={(t) => t.tool}
            empty="No tool calls yet."
            columns={[
              { header: 'Tool', render: (t) => <span className="mono">{t.tool}</span> },
              { header: 'Calls', render: (t) => t.calls },
              {
                header: 'Failed',
                render: (t) =>
                  t.errors ? <span style={{ color: 'var(--err)' }}>{t.errors}</span> : 0,
              },
              { header: 'Avg', render: (t) => duration(t.averageDurationMs) },
            ]}
          />
        </Card>

        <Card
          title={model ? `Recent runs · ${model}` : 'Recent runs'}
          actions={
            model ? (
              <button className="btn ghost" onClick={() => setModel('')}>
                All models
              </button>
            ) : null
          }
        >
          <Rows
            items={runs.data?.runs ?? []}
            keyOf={(r) => r.runId}
            empty="No runs."
            columns={[
              {
                header: '',
                width: '4.5rem',
                render: (r) => (
                  <Pill tone={r.status === 'ok' ? 'ok' : r.status === 'aborted' ? 'idle' : 'err'}>
                    {r.status}
                  </Pill>
                ),
              },
              {
                header: 'Run',
                render: (r) => (
                  <>
                    <div className="mono" style={{ fontSize: 11 }}>
                      {r.sessionKey}
                    </div>
                    <span className="faint" style={{ fontSize: 11 }} title={r.error}>
                      {r.source ?? ''} · {relativeTime(r.ts)}
                      {r.error ? ` · ${r.error.slice(0, 60)}` : ''}
                    </span>
                  </>
                ),
              },
              { header: 'Time', render: (r) => duration(r.durationMs) },
              { header: 'Tools', render: (r) => r.toolCalls },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

/** Runs per hour as bars, errors stacked in red. Plain SVG: no chart library needed for this. */
function ActivityChart({ activity }: { activity: Summary['activity'] }): JSX.Element {
  const max = Math.max(1, ...activity.map((a) => a.runs));
  const width = 720;
  const height = 120;
  const barWidth = activity.length ? width / activity.length : width;

  if (activity.every((a) => a.runs === 0)) {
    return <div className="empty">No runs in the last 24 hours.</div>;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height + 18}`}
      role="img"
      aria-label="Runs per hour over the last 24 hours"
      style={{ width: '100%', height: 'auto' }}
    >
      {activity.map((a, index) => {
        const h = (a.runs / max) * height;
        const e = (a.errors / max) * height;
        const x = index * barWidth + 2;
        return (
          <g key={a.hour}>
            <title>{`${new Date(a.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${a.runs} runs, ${a.errors} errors`}</title>
            <rect
              x={x}
              y={height - h}
              width={barWidth - 4}
              height={h}
              rx={2}
              fill="var(--accent)"
              opacity={0.75}
            />
            {e > 0 && (
              <rect x={x} y={height - e} width={barWidth - 4} height={e} rx={2} fill="var(--err)" />
            )}
          </g>
        );
      })}
      {activity
        .filter((_, index) => index % 6 === 0)
        .map((a, index) => (
          <text
            key={a.hour}
            x={index * 6 * barWidth + 2}
            y={height + 14}
            fontSize="10"
            fill="var(--text-faint)"
          >
            {new Date(a.hour).toLocaleTimeString([], { hour: '2-digit' })}
          </text>
        ))}
    </svg>
  );
}
