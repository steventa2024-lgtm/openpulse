import type { JSX } from 'react';
import { Card, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { dateTime, relativeTime } from '../format.js';
import type { DeviceRequest, PairedDevice, PresenceEntry } from '../types.js';

export function NodesPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const nodes = useQuery<{ nodes: PresenceEntry[] }>('node.list');
  const devices = useQuery<{ pending: DeviceRequest[]; paired: PairedDevice[] }>(
    'device.pair.list',
  );

  useGatewayEvent(['presence', 'device.pair.requested', 'device.pair.resolved'], () => {
    nodes.reload();
    devices.reload();
  });

  return (
    <>
      <PageHead
        title="Nodes"
        subtitle="Remote workers and the devices allowed to control this gateway"
        actions={
          <button
            className="btn"
            onClick={() => {
              nodes.reload();
              devices.reload();
            }}
          >
            Refresh
          </button>
        }
      />

      <Card title="Worker nodes">
        <Rows
          items={nodes.data?.nodes ?? []}
          keyOf={(node) => node.id}
          empty="No worker nodes are connected. Nodes are optional — the gateway runs tools on this host by itself."
          columns={[
            { header: 'Node', render: (node) => node.host || node.clientId },
            { header: 'Platform', render: (node) => node.platform ?? '—' },
            { header: 'Version', render: (node) => node.version ?? '—' },
            { header: 'Connected', render: (node) => relativeTime(node.connectedAtMs) },
          ]}
        />
      </Card>

      <Card title="Pending device approvals">
        <Rows
          items={devices.data?.pending ?? []}
          keyOf={(device) => device.requestId}
          empty="Nothing waiting. Devices on this machine are approved automatically; anything else asks here first."
          columns={[
            {
              header: 'Device',
              render: (device) => <span className="mono">{device.deviceId.slice(0, 12)}…</span>,
            },
            { header: 'Client', render: (device) => device.displayName ?? device.clientId },
            {
              header: 'From',
              render: (device) => <span className="mono faint">{device.remoteIp ?? '—'}</span>,
            },
            { header: 'Asked', render: (device) => relativeTime(device.ts) },
            {
              header: '',
              render: (device) => (
                <span style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    className="btn primary"
                    onClick={() =>
                      void act(async () => {
                        await request('device.pair.approve', { requestId: device.requestId });
                        devices.reload();
                      }, 'Device approved')
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="btn danger"
                    onClick={() =>
                      void act(async () => {
                        await request('device.pair.reject', { requestId: device.requestId });
                        devices.reload();
                      }, 'Device rejected')
                    }
                  >
                    Reject
                  </button>
                </span>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Paired devices">
        <Rows
          items={devices.data?.paired ?? []}
          keyOf={(device) => device.deviceId}
          empty="No paired devices."
          columns={[
            { header: '', width: '5rem', render: (device) => <Pill tone="ok">{device.role}</Pill> },
            {
              header: 'Device',
              render: (device) => <span className="mono">{device.deviceId.slice(0, 12)}…</span>,
            },
            { header: 'Client', render: (device) => device.displayName ?? device.clientId },
            { header: 'Platform', render: (device) => device.platform ?? '—' },
            { header: 'Paired', render: (device) => dateTime(device.approvedAtMs) },
            { header: 'Last seen', render: (device) => relativeTime(device.lastSeenAtMs) },
            {
              header: '',
              render: (device) => (
                <button
                  className="btn danger"
                  onClick={() =>
                    void act(async () => {
                      await request('device.pair.remove', { deviceId: device.deviceId });
                      devices.reload();
                    }, 'Device removed')
                  }
                >
                  Remove
                </button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
