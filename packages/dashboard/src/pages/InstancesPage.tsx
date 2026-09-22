import type { JSX } from 'react';
import { Card, PageHead, Pill, Rows } from '../components/ui.js';
import { useGatewayEvent, useQuery, useGateway } from '../gateway/provider.js';
import { dateTime, relativeTime } from '../format.js';
import type { PresenceEntry, StatusSnapshot } from '../types.js';

export function InstancesPage(): JSX.Element {
  const { status } = useGateway();
  const presence = useQuery<{ presence: PresenceEntry[] }>('system-presence');
  const snapshot = useQuery<StatusSnapshot>('status');

  useGatewayEvent('presence', () => presence.reload());

  return (
    <>
      <PageHead
        title="Instances"
        subtitle="This gateway and everything currently connected to it"
        actions={
          <button className="btn" onClick={() => presence.reload()}>
            Refresh
          </button>
        }
      />

      <Card title="Gateway">
        <dl className="kv">
          <dt>Host</dt>
          <dd>{status.hello?.server.host ?? '—'}</dd>
          <dt>Version</dt>
          <dd>{status.hello?.server.version ?? '—'}</dd>
          <dt>Started</dt>
          <dd>
            {status.hello
              ? `${dateTime(status.hello.server.startedAtMs)} · ${relativeTime(status.hello.server.startedAtMs)}`
              : '—'}
          </dd>
          <dt>Protocol</dt>
          <dd>v{status.hello?.protocol ?? '—'}</dd>
          <dt>Model</dt>
          <dd>{snapshot.data?.model ?? '—'}</dd>
          <dt>State dir</dt>
          <dd className="mono">{snapshot.data?.stateDir ?? '—'}</dd>
        </dl>
      </Card>

      <Card title="Connected clients">
        <Rows
          items={presence.data?.presence ?? []}
          keyOf={(entry) => entry.id}
          empty="No clients connected."
          columns={[
            {
              header: '',
              width: '5rem',
              render: (entry) => (
                <Pill tone={entry.id === 'gateway' ? 'ok' : 'idle'}>{entry.role}</Pill>
              ),
            },
            { header: 'Client', render: (entry) => entry.host || entry.clientId || entry.id },
            { header: 'Mode', render: (entry) => entry.mode },
            { header: 'Platform', render: (entry) => entry.platform ?? '—' },
            { header: 'Version', render: (entry) => entry.version ?? '—' },
            {
              header: 'Address',
              render: (entry) => <span className="mono faint">{entry.ip ?? '—'}</span>,
            },
            { header: 'Connected', render: (entry) => relativeTime(entry.connectedAtMs) },
            { header: 'Last seen', render: (entry) => relativeTime(entry.lastSeenAtMs) },
          ]}
        />
      </Card>
    </>
  );
}
