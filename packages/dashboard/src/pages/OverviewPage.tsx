import type { JSX } from 'react';
import { useState } from 'react';
import { Card, PageHead, Pill, Rows, Stat, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { compactNumber, dateTime, duration, relativeTime } from '../format.js';
import type { SessionRow, StatusSnapshot } from '../types.js';

export function OverviewPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const status = useQuery<StatusSnapshot>('status');
  const sessions = useQuery<{ sessions: SessionRow[] }>('sessions.list', { limit: 8 });
  const [busy, setBusy] = useState(false);

  useGatewayEvent(['heartbeat', 'cron', 'sessions.changed', 'presence', 'config.changed'], () => {
    status.reload();
    sessions.reload();
  });

  const data = status.data;
  const heartbeat = data?.heartbeat;
  const last = heartbeat?.last;

  const runHeartbeat = async () => {
    setBusy(true);
    await act(async () => {
      await request('heartbeat.run', {}, 600_000);
      status.reload();
    }, 'Heartbeat finished');
    setBusy(false);
  };

  return (
    <>
      <PageHead
        title="Overview"
        subtitle={data ? `${data.model} · up ${duration(data.uptimeMs)}` : 'connecting…'}
        actions={
          <button className="btn" onClick={() => status.reload()}>
            Refresh
          </button>
        }
      />

      <div className="grid">
        <Card>
          <Stat
            label="Gateway"
            value={data ? `v${data.version}` : '—'}
            hint={
              data ? `${data.connections} client${data.connections === 1 ? '' : 's'} connected` : ''
            }
          />
        </Card>
        <Card>
          <Stat
            label="Active runs"
            value={data?.activeRuns ?? 0}
            hint={
              data?.pendingApprovals
                ? `${data.pendingApprovals} approval(s) waiting`
                : 'no approvals pending'
            }
          />
        </Card>
        <Card>
          <Stat label="Sessions" value={data?.sessions ?? 0} hint={data?.mainSessionKey ?? ''} />
        </Card>
        <Card>
          <Stat
            label="Cron"
            value={data ? `${data.cron.jobs} job${data.cron.jobs === 1 ? '' : 's'}` : '—'}
            hint={
              data?.cron.enabled
                ? `next ${relativeTime(data.cron.nextWakeAtMs)}`
                : 'scheduler disabled'
            }
          />
        </Card>
      </div>

      <Card
        title="Heartbeat"
        actions={
          <>
            <button className="btn" disabled={busy} onClick={() => void runHeartbeat()}>
              Run now
            </button>
            <button
              className="btn"
              onClick={() =>
                void act(async () => {
                  await request('set-heartbeats', { enabled: !heartbeat?.enabled });
                  status.reload();
                })
              }
            >
              {heartbeat?.enabled ? 'Disable' : 'Enable'}
            </button>
          </>
        }
      >
        <dl className="kv">
          <dt>State</dt>
          <dd>
            {heartbeat?.enabled && !isZeroInterval(heartbeat.every) ? (
              <Pill tone="ok">every {heartbeat.every}</Pill>
            ) : (
              <Pill tone="idle">
                {heartbeat?.enabled ? `off (every ${heartbeat.every})` : 'disabled'}
              </Pill>
            )}
          </dd>
          <dt>Next run</dt>
          <dd>
            {heartbeat?.nextRunAt
              ? `${dateTime(heartbeat.nextRunAt)} (${relativeTime(heartbeat.nextRunAt)})`
              : '—'}
          </dd>
          <dt>Last run</dt>
          <dd>
            {last ? (
              <>
                <Pill
                  tone={
                    last.status === 'failed'
                      ? 'err'
                      : last.status === 'skipped'
                        ? 'idle'
                        : last.status === 'sent'
                          ? 'warn'
                          : 'ok'
                  }
                >
                  {last.status}
                </Pill>{' '}
                {relativeTime(last.ts)} · {last.trigger}
                {last.reason ? ` — ${last.reason}` : last.preview ? ` — ${last.preview}` : ''}
              </>
            ) : (
              '—'
            )}
          </dd>
        </dl>
      </Card>

      <Card title="Channels">
        <Rows
          items={data?.channels ?? []}
          keyOf={(channel) => channel.id}
          empty="No channels configured yet — add one under Channels."
          columns={[
            {
              header: '',
              width: '2rem',
              render: (channel) => (
                <Pill
                  tone={
                    !channel.configured
                      ? 'idle'
                      : channel.connected
                        ? 'ok'
                        : channel.lastError
                          ? 'err'
                          : 'warn'
                  }
                >
                  {!channel.configured
                    ? 'off'
                    : channel.connected
                      ? 'live'
                      : channel.lastError
                        ? 'error'
                        : 'starting'}
                </Pill>
              ),
            },
            { header: 'Channel', render: (channel) => channel.label },
            { header: 'Account', render: (channel) => channel.accountName ?? '—' },
            { header: 'Last inbound', render: (channel) => relativeTime(channel.lastInboundAt) },
            {
              header: 'Note',
              render: (channel) => (
                <span className="faint">{channel.lastError ?? channel.mode ?? ''}</span>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Recent sessions">
        <Rows
          items={sessions.data?.sessions ?? []}
          keyOf={(session) => session.key}
          empty="No sessions yet."
          onRowClick={() => {
            window.location.hash = '#/sessions';
          }}
          columns={[
            { header: 'Session', render: (session) => <span className="mono">{session.key}</span> },
            { header: 'Type', render: (session) => session.chatType },
            { header: 'Tokens', render: (session) => compactNumber(session.totalTokens) },
            { header: 'Updated', render: (session) => relativeTime(session.updatedAt) },
          ]}
        />
      </Card>

      {data && (
        <Card title="Host">
          <dl className="kv">
            <dt>Workspace</dt>
            <dd className="mono">{data.workspace}</dd>
            <dt>State dir</dt>
            <dd className="mono">{data.stateDir}</dd>
            <dt>Config</dt>
            <dd className="mono">
              {data.configPath}{' '}
              {data.configValid ? <Pill tone="ok">valid</Pill> : <Pill tone="err">invalid</Pill>}
            </dd>
            <dt>Runtime</dt>
            <dd>
              node {data.node} · {data.platform}
            </dd>
          </dl>
        </Card>
      )}
    </>
  );
}

/** An interval of "0m" (or "0") means the heartbeat never fires on its own. */
function isZeroInterval(every: string): boolean {
  return Number.parseFloat(every) === 0;
}
