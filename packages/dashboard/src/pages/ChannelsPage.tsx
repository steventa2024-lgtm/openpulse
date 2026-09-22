import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { relativeTime } from '../format.js';
import type { ChannelStatus, PairingRequest } from '../types.js';

export function ChannelsPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const channels = useQuery<{ channels: ChannelStatus[] }>('channels.status');
  const pairing = useQuery<{ channel: string; requests: PairingRequest[]; allowFrom: string[] }>(
    'channels.pairing.list',
    { channel: 'telegram' },
  );

  useGatewayEvent('config.changed', () => {
    channels.reload();
    pairing.reload();
  });

  return (
    <>
      <PageHead
        title="Channels"
        subtitle="Where the agent talks to you"
        actions={
          <button
            className="btn"
            onClick={() => {
              channels.reload();
              pairing.reload();
            }}
          >
            Refresh
          </button>
        }
      />

      <Card title="Status">
        <Rows
          items={channels.data?.channels ?? []}
          keyOf={(channel) => channel.id}
          empty="No channel plugins are configured."
          columns={[
            {
              header: 'State',
              width: '7rem',
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
                    ? 'not set up'
                    : channel.connected
                      ? 'connected'
                      : channel.lastError
                        ? 'error'
                        : 'starting'}
                </Pill>
              ),
            },
            { header: 'Channel', render: (channel) => channel.label },
            { header: 'Mode', render: (channel) => channel.mode ?? '—' },
            { header: 'Account', render: (channel) => channel.accountName ?? '—' },
            { header: 'Started', render: (channel) => relativeTime(channel.lastStartAt) },
            { header: 'Last inbound', render: (channel) => relativeTime(channel.lastInboundAt) },
            {
              header: 'Error',
              render: (channel) => (
                <span style={{ color: 'var(--err)' }}>{channel.lastError ?? ''}</span>
              ),
            },
          ]}
        />
      </Card>

      <TelegramSetup onSaved={() => channels.reload()} />

      <Card title="Pairing requests" actions={<span className="faint">Telegram</span>}>
        <Rows
          items={pairing.data?.requests ?? []}
          keyOf={(row) => row.code}
          empty="Nobody is waiting to be paired. When a new person messages the bot it replies with a code that shows up here."
          columns={[
            { header: 'Code', render: (row) => <strong className="mono">{row.code}</strong> },
            { header: 'User', render: (row) => <span className="mono">{row.userId}</span> },
            { header: 'Name', render: (row) => row.name ?? '—' },
            { header: 'Asked', render: (row) => relativeTime(row.createdAt) },
            { header: 'Last message', render: (row) => relativeTime(row.lastSeenAt) },
            {
              header: '',
              render: (row) => (
                <span style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    className="btn primary"
                    onClick={() =>
                      void act(
                        async () => {
                          await request('channels.pairing.approve', {
                            channel: 'telegram',
                            code: row.code,
                          });
                          pairing.reload();
                        },
                        `Paired ${row.name ?? row.userId}`,
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="btn danger"
                    onClick={() =>
                      void act(async () => {
                        await request('channels.pairing.reject', {
                          channel: 'telegram',
                          code: row.code,
                        });
                        pairing.reload();
                      }, 'Rejected')
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

      <Card title="Paired users">
        <Rows
          items={(pairing.data?.allowFrom ?? []).map((userId) => ({ userId }))}
          keyOf={(row) => row.userId}
          empty="No one is paired yet."
          columns={[
            { header: 'User', render: (row) => <span className="mono">{row.userId}</span> },
            {
              header: '',
              render: (row) => (
                <button
                  className="btn danger"
                  onClick={() =>
                    void act(async () => {
                      await request('channels.allow.remove', {
                        channel: 'telegram',
                        userId: row.userId,
                      });
                      pairing.reload();
                    }, 'Removed')
                  }
                >
                  Revoke
                </button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

function TelegramSetup({ onSaved }: { onSaved: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [token, setToken] = useState('');
  const [dmPolicy, setDmPolicy] = useState('pairing');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await act(async () => {
      await request('config.patch', {
        patch: {
          channels: {
            telegram: {
              enabled: true,
              dmPolicy,
              ...(token.trim() ? { botToken: token.trim() } : {}),
            },
          },
        },
      });
      setToken('');
      onSaved();
    }, 'Telegram updated — the gateway reloads it automatically');
    setSaving(false);
  };

  return (
    <Card title="Connect Telegram">
      <p className="muted" style={{ marginTop: 0 }}>
        Create a bot with{' '}
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
          @BotFather
        </a>{' '}
        and paste its token. Leave the token empty to change only the DM policy.
      </p>
      <Field label="Bot token">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="123456:ABC-DEF…"
        />
      </Field>
      <Field label="Who may DM the bot">
        <select value={dmPolicy} onChange={(event) => setDmPolicy(event.target.value)}>
          <option value="pairing">Pairing code required (recommended)</option>
          <option value="allowlist">Allowlist only</option>
          <option value="open">Anyone</option>
        </select>
      </Field>
      <button className="btn primary" disabled={saving} onClick={() => void save()}>
        Save
      </button>
    </Card>
  );
}
