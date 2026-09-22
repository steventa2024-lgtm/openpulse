import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { dateTime, duration, relativeTime, scheduleLabel } from '../format.js';
import type { CronJob, CronRun } from '../types.js';

export function CronPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const jobs = useQuery<{ jobs: CronJob[] }>('cron.list');
  const [selected, setSelected] = useState<string>();
  const runs = useQuery<{ runs: CronRun[] }>('cron.runs', { jobId: selected ?? '', limit: 25 }, [
    selected,
  ]);

  useGatewayEvent('cron', () => {
    jobs.reload();
    if (selected) runs.reload();
  });

  return (
    <>
      <PageHead
        title="Cron Jobs"
        subtitle="Scheduled wake-ups: a note dropped into the main session, or an isolated run with its own transcript"
        actions={
          <button className="btn" onClick={() => jobs.reload()}>
            Refresh
          </button>
        }
      />

      <Card>
        <Rows
          items={jobs.data?.jobs ?? []}
          keyOf={(job) => job.jobId}
          empty="No scheduled jobs. Add one below — or just ask the agent in chat to remind you about something."
          onRowClick={(job) => setSelected(job.jobId === selected ? undefined : job.jobId)}
          columns={[
            {
              header: '',
              width: '5rem',
              render: (job) =>
                !job.enabled ? (
                  <Pill tone="idle">off</Pill>
                ) : job.state.lastStatus === 'error' ? (
                  <Pill tone="err">error</Pill>
                ) : (
                  <Pill tone="ok">on</Pill>
                ),
            },
            {
              header: 'Job',
              render: (job) => (
                <>
                  <div>{job.name}</div>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {job.payload.kind === 'agentTurn' ? job.payload.message : job.payload.text}
                  </span>
                </>
              ),
            },
            { header: 'Schedule', render: (job) => scheduleLabel(job.schedule) },
            {
              header: 'Target',
              render: (job) =>
                `${job.sessionTarget}${job.delivery?.mode === 'announce' ? ' → announce' : ''}`,
            },
            {
              header: 'Next run',
              render: (job) => (job.enabled ? relativeTime(job.state.nextRunAtMs) : '—'),
            },
            {
              header: 'Last run',
              render: (job) => (
                <span title={job.state.lastError ?? ''}>
                  {job.state.lastRunAtMs
                    ? `${relativeTime(job.state.lastRunAtMs)} (${job.state.lastStatus})`
                    : '—'}
                </span>
              ),
            },
            {
              header: '',
              render: (job) => (
                <span
                  style={{ display: 'flex', gap: '0.4rem' }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    className="btn"
                    onClick={() =>
                      void act(async () => {
                        await request('cron.run', { jobId: job.jobId }, 600_000);
                        jobs.reload();
                      }, `Ran ${job.name}`)
                    }
                  >
                    Run
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      void act(async () => {
                        await request('cron.update', {
                          jobId: job.jobId,
                          patch: { enabled: !job.enabled },
                        });
                        jobs.reload();
                      })
                    }
                  >
                    {job.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn danger"
                    onClick={() =>
                      void act(async () => {
                        await request('cron.remove', { jobId: job.jobId });
                        jobs.reload();
                      }, 'Job removed')
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

      {selected && (
        <Card
          title={`Runs · ${jobs.data?.jobs.find((j) => j.jobId === selected)?.name ?? selected}`}
        >
          <Rows
            items={runs.data?.runs ?? []}
            keyOf={(run) => `${run.ts}`}
            empty="This job has not run yet."
            columns={[
              {
                header: '',
                width: '5rem',
                render: (run) => (
                  <Pill
                    tone={run.status === 'ok' ? 'ok' : run.status === 'skipped' ? 'idle' : 'err'}
                  >
                    {run.status}
                  </Pill>
                ),
              },
              { header: 'When', render: (run) => dateTime(run.ts) },
              { header: 'Took', render: (run) => duration(run.durationMs) },
              {
                header: 'Detail',
                render: (run) => <span className="faint">{run.error ?? run.summary ?? ''}</span>,
              },
            ]}
          />
        </Card>
      )}

      <AddJob onAdded={() => jobs.reload()} />
    </>
  );
}

function AddJob({ onAdded }: { onAdded: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'every' | 'cron' | 'at'>('every');
  const [every, setEvery] = useState('60');
  const [expr, setExpr] = useState('0 9 * * *');
  const [at, setAt] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    const schedule =
      kind === 'every'
        ? { kind: 'every', everyMs: Math.max(10, Number(every) || 60) * 60_000 }
        : kind === 'cron'
          ? { kind: 'cron', expr }
          : { kind: 'at', at: new Date(at).toISOString() };
    await act(async () => {
      await request('cron.add', {
        job: {
          name: name.trim() || 'Untitled job',
          enabled: true,
          schedule,
          sessionTarget: isolated ? 'isolated' : 'main',
          payload: isolated
            ? {
                kind: 'agentTurn',
                message: message.trim() || 'Check in and report anything that needs attention.',
              }
            : { kind: 'systemEvent', text: message.trim() || 'Scheduled check-in.' },
        },
      });
      setName('');
      setMessage('');
      onAdded();
    }, 'Job scheduled');
    setSaving(false);
  };

  return (
    <Card title="Add a job">
      <div className="grid">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Morning briefing"
          />
        </Field>
        <Field label="Schedule">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as 'every' | 'cron' | 'at')}
          >
            <option value="every">Every N minutes</option>
            <option value="cron">Cron expression</option>
            <option value="at">Once, at a time</option>
          </select>
        </Field>
        <Field label={kind === 'every' ? 'Minutes' : kind === 'cron' ? 'Expression' : 'When'}>
          {kind === 'every' ? (
            <input
              type="number"
              min={1}
              value={every}
              onChange={(event) => setEvery(event.target.value)}
            />
          ) : kind === 'cron' ? (
            <input
              type="text"
              value={expr}
              onChange={(event) => setExpr(event.target.value)}
              placeholder="0 9 * * *"
            />
          ) : (
            <input
              type="text"
              value={at}
              onChange={(event) => setAt(event.target.value)}
              placeholder="2026-01-01 09:00"
            />
          )}
        </Field>
        <Field label="Runs in">
          <select
            value={isolated ? 'isolated' : 'main'}
            onChange={(event) => setIsolated(event.target.value === 'isolated')}
          >
            <option value="main">Main session (a note the agent sees)</option>
            <option value="isolated">Its own session (a full agent turn)</option>
          </select>
        </Field>
      </div>
      <Field label={isolated ? 'Prompt' : 'Note'}>
        <textarea
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="What should happen?"
        />
      </Field>
      <button className="btn primary" disabled={saving} onClick={() => void submit()}>
        Schedule
      </button>
    </Card>
  );
}
