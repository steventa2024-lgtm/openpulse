import type { JSX } from 'react';
import { Card, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { compactNumber, dateTime, relativeTime, sessionLabel } from '../format.js';
import type { SessionRow } from '../types.js';

export function SessionsPage(): JSX.Element {
  const { request, status } = useGateway();
  const act = useAction();
  const sessions = useQuery<{ sessions: SessionRow[]; defaults: { mainSessionKey: string } }>(
    'sessions.list',
    { limit: 200 },
  );
  const mainKey = status.hello?.snapshot.sessionDefaults.mainSessionKey;

  useGatewayEvent(['sessions.changed', 'chat'], () => sessions.reload());

  return (
    <>
      <PageHead
        title="Sessions"
        subtitle="One transcript per conversation — the main session, each DM, each group and each isolated cron job"
        actions={
          <button className="btn" onClick={() => sessions.reload()}>
            Refresh
          </button>
        }
      />

      <Card>
        <Rows
          items={sessions.data?.sessions ?? []}
          keyOf={(session) => session.key}
          empty="No sessions yet."
          columns={[
            {
              header: '',
              width: '5rem',
              render: (session) =>
                session.running ? <Pill tone="warn">running</Pill> : <Pill tone="idle">idle</Pill>,
            },
            {
              header: 'Session',
              render: (session) => (
                <>
                  <div>{sessionLabel(session.key, session.label)}</div>
                  <span className="faint mono" style={{ fontSize: 11 }}>
                    {session.key}
                  </span>
                </>
              ),
            },
            {
              header: 'Model',
              render: (session) => (
                <span className="faint">{session.modelOverride ?? session.model ?? '—'}</span>
              ),
            },
            {
              header: 'Tokens',
              render: (session) => (
                <span title={`${session.inputTokens} in / ${session.outputTokens} out`}>
                  {compactNumber(session.totalTokens)}
                  {session.contextTokens ? (
                    <span className="faint"> · ctx {compactNumber(session.contextTokens)}</span>
                  ) : null}
                </span>
              ),
            },
            {
              header: 'Created',
              render: (session) => <span className="faint">{dateTime(session.createdAt)}</span>,
            },
            { header: 'Updated', render: (session) => relativeTime(session.updatedAt) },
            {
              header: '',
              render: (session) => (
                <span
                  style={{ display: 'flex', gap: '0.4rem' }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    className="btn"
                    onClick={() => {
                      window.location.hash = '#/chat';
                    }}
                  >
                    Open
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      void act(async () => {
                        await request('sessions.reset', { key: session.key });
                        sessions.reload();
                      }, 'Session reset')
                    }
                  >
                    Reset
                  </button>
                  <button
                    className="btn danger"
                    disabled={session.key === mainKey}
                    title={
                      session.key === mainKey
                        ? 'The main session can only be reset'
                        : 'Delete this session'
                    }
                    onClick={() =>
                      void act(async () => {
                        await request('sessions.delete', {
                          key: session.key,
                          deleteTranscript: true,
                        });
                        sessions.reload();
                      }, 'Session deleted')
                    }
                  >
                    Delete
                  </button>
                </span>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
