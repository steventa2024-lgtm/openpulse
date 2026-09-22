import type { JSX } from 'react';
import { Card, PageHead } from '../components/ui.js';
import { useGateway, useQuery } from '../gateway/provider.js';
import type { StatusSnapshot } from '../types.js';

export function DocsPage(): JSX.Element {
  const { status } = useGateway();
  const snapshot = useQuery<StatusSnapshot>('status');

  return (
    <>
      <PageHead title="Docs" subtitle="How the pieces fit together" />

      <Card title="The shape of OpenPulse">
        <p style={{ marginTop: 0 }}>
          One gateway daemon owns everything: the agent loop, your messaging channels, the cron
          scheduler, the heartbeat and this Control UI. Clients — this browser, the CLI, a remote
          node — speak the same WebSocket protocol, so anything the dashboard can do the CLI can do
          too.
        </p>
        <dl className="kv">
          <dt>Gateway</dt>
          <dd className="mono">
            {status.hello
              ? `${status.hello.server.host} · v${status.hello.server.version} · protocol v${status.hello.protocol}`
              : '—'}
          </dd>
          <dt>Workspace</dt>
          <dd className="mono">{snapshot.data?.workspace ?? '—'}</dd>
          <dt>State</dt>
          <dd className="mono">{snapshot.data?.stateDir ?? '—'}</dd>
        </dl>
      </Card>

      <Card title="Workspace files">
        <p style={{ marginTop: 0 }} className="muted">
          Everything in the workspace is plain Markdown you can edit by hand (or from Debug):
        </p>
        <dl className="kv">
          <dt>AGENTS.md</dt>
          <dd>House rules for the agent — how to behave, what to avoid.</dd>
          <dt>SOUL.md</dt>
          <dd>Personality and voice.</dd>
          <dt>IDENTITY.md</dt>
          <dd>Who the agent is: name, role, pronouns.</dd>
          <dt>USER.md</dt>
          <dd>Who you are, and how you like to be addressed.</dd>
          <dt>TOOLS.md</dt>
          <dd>Local notes about tools and hosts the agent should know about.</dd>
          <dt>HEARTBEAT.md</dt>
          <dd>
            The standing checklist read on every heartbeat. Empty means the heartbeat stays quiet.
          </dd>
          <dt>MEMORY.md</dt>
          <dd>
            Long-term notes, plus one file per day under <span className="mono">memory/</span>.
          </dd>
        </dl>
      </Card>

      <Card title="Command line">
        <pre className="log-view" style={{ height: 'auto' }}>
          {`openpulse onboard              # first-run wizard
openpulse gateway              # run the daemon in the foreground
openpulse tui                  # interactive chat in the terminal
openpulse status               # what the gateway is doing
openpulse logs --follow        # stream the log
openpulse pairing list         # people waiting to be paired
openpulse cron add "Briefing" --cron "0 9 * * *" --isolated
openpulse config set agents.defaults.heartbeat.every '"30m"'
openpulse doctor               # check config, credentials, skills`}
        </pre>
      </Card>

      <Card title="Safety">
        <p style={{ marginTop: 0 }} className="muted">
          The agent runs real commands on this machine. Risky ones stop and wait for your approval —
          in chat here, in your messaging app, or with{' '}
          <span className="mono">openpulse approvals</span>. Catastrophic commands are refused
          outright. Pair only people you trust: a paired user can ask the agent to do anything you
          could.
        </p>
      </Card>
    </>
  );
}
