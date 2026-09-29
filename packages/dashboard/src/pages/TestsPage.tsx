import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Card, Empty, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { useProject } from '../project/provider.js';
import { duration, relativeTime } from '../format.js';
import { NoProject } from './NoProject.js';

interface TestSuite {
  id: string;
  label: string;
  ecosystem: string;
  command: string;
  args: string[];
  available: boolean;
  reason?: string;
  source: string;
}

interface TestRunSummary {
  id: string;
  projectId: string;
  suiteId: string;
  label: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
  exitCode?: number | null;
  failures: { name: string; detail: string }[];
  error?: string;
}

interface TestRun extends TestRunSummary {
  output: string;
}

export function TestsPage(): JSX.Element {
  const { active } = useProject();
  if (!active) return <NoProject title="Tests" />;
  return <TestsForProject key={active.id} projectId={active.id} />;
}

function TestsForProject({ projectId }: { projectId: string }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const suites = useQuery<{ suites: TestSuite[] }>('tests.detect');
  const history = useQuery<{ runs: TestRunSummary[] }>('tests.history', { limit: 20 });
  const [openRun, setOpenRun] = useState<TestRun>();
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const outputRef = useRef<HTMLPreElement>(null);

  useGatewayEvent('tests.output', (payload) => {
    const event = payload as { runId: string; chunk: string };
    setLiveOutput((current) => ({
      ...current,
      [event.runId]: `${current[event.runId] ?? ''}${event.chunk}`.slice(-200_000),
    }));
  });

  useGatewayEvent(['tests.started', 'tests.finished'], (payload) => {
    const { run } = payload as { run: TestRunSummary };
    if (run.projectId !== projectId) return;
    history.reload();
    if (openRun?.id === run.id || !openRun) {
      void request<{ run: TestRun }>('tests.get', { runId: run.id })
        .then((r) => setOpenRun(r.run))
        .catch(() => undefined);
    }
  });

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [liveOutput, openRun?.id]);

  const run = (suite: TestSuite) =>
    act(async () => {
      const result = await request<{ run: TestRunSummary }>('tests.run', { suiteId: suite.id });
      if (result.run) setOpenRun({ ...result.run, output: '' });
      history.reload();
    });

  const output = openRun
    ? openRun.status === 'running'
      ? (liveOutput[openRun.id] ?? '')
      : openRun.output || liveOutput[openRun.id] || ''
    : '';

  return (
    <>
      <PageHead
        title="Tests"
        subtitle="Runs the project's own test command. Pass or fail comes from the command's exit code."
        actions={
          <button className="btn" onClick={() => suites.reload()}>
            Detect again
          </button>
        }
      />

      <Card title="Test suites in this project">
        <Rows
          items={suites.data?.suites ?? []}
          keyOf={(s) => s.id}
          empty="No test setup found — no test script in package.json, and no pytest, cargo, go, maven, gradle or dotnet project."
          columns={[
            {
              header: '',
              width: '6rem',
              render: (s) =>
                s.available ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">missing tool</Pill>,
            },
            {
              header: 'Suite',
              render: (s) => (
                <>
                  <div className="mono">{[s.command, ...s.args].join(' ')}</div>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {s.source}
                    {s.reason ? ` · ${s.reason}` : ''}
                  </span>
                </>
              ),
            },
            {
              header: '',
              render: (s) => (
                <button className="btn primary" disabled={!s.available} onClick={() => void run(s)}>
                  Run
                </button>
              ),
            },
          ]}
        />
      </Card>

      {openRun && (
        <Card
          title={openRun.label}
          actions={
            <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <RunStatus status={openRun.status} />
              {openRun.durationMs !== undefined && (
                <span className="faint">{duration(openRun.durationMs)}</span>
              )}
              {openRun.status === 'running' && (
                <button
                  className="btn danger"
                  onClick={() =>
                    void act(() => request('tests.cancel', { runId: openRun.id }), 'Cancelled')
                  }
                >
                  Cancel
                </button>
              )}
              {openRun.status === 'failed' && (
                <button
                  className="btn primary"
                  onClick={() =>
                    void act(async () => {
                      await request('tests.fix', { runId: openRun.id });
                    }, 'Sent to the agent. Its fix will appear under Changes for review.')
                  }
                >
                  Ask the agent for a fix
                </button>
              )}
            </span>
          }
        >
          {openRun.error && <p style={{ color: 'var(--err)', marginTop: 0 }}>{openRun.error}</p>}
          {openRun.failures.length > 0 && (
            <>
              <p className="faint" style={{ marginTop: 0, fontSize: 12 }}>
                Failures read from the output (the tool's own report is below):
              </p>
              {openRun.failures.map((failure) => (
                <details key={failure.name} className="step">
                  <summary>
                    <Pill tone="err">failed</Pill>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {failure.name}
                    </span>
                  </summary>
                  <pre className="log-view" style={{ height: 'auto', maxHeight: '14rem' }}>
                    {failure.detail}
                  </pre>
                </details>
              ))}
            </>
          )}
          <pre className="log-view" ref={outputRef} style={{ height: '22rem' }}>
            {output || (openRun.status === 'running' ? 'waiting for output…' : '(no output)')}
          </pre>
        </Card>
      )}

      <Card title="History">
        {(history.data?.runs ?? []).length === 0 ? (
          <Empty>No test runs yet.</Empty>
        ) : (
          <Rows
            items={history.data?.runs ?? []}
            keyOf={(r) => r.id}
            empty=""
            onRowClick={(r) =>
              void request<{ run: TestRun }>('tests.get', { runId: r.id }).then((res) =>
                setOpenRun(res.run),
              )
            }
            columns={[
              { header: '', width: '6rem', render: (r) => <RunStatus status={r.status} /> },
              { header: 'Command', render: (r) => <span className="mono">{r.command}</span> },
              { header: 'Failures', render: (r) => (r.failures.length ? r.failures.length : '') },
              { header: 'Took', render: (r) => duration(r.durationMs) },
              { header: 'When', render: (r) => relativeTime(r.startedAt) },
            ]}
          />
        )}
      </Card>
    </>
  );
}

function RunStatus({ status }: { status: TestRunSummary['status'] }): JSX.Element {
  return (
    <Pill
      tone={
        status === 'passed'
          ? 'ok'
          : status === 'running'
            ? 'warn'
            : status === 'cancelled'
              ? 'idle'
              : 'err'
      }
    >
      {status}
    </Pill>
  );
}
