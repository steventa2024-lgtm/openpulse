import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeRuntime } from './helpers.js';

const MAIN = 'agent:main:main';

describe('cron scheduler', () => {
  it('validates job shapes', async () => {
    const { rt } = await makeRuntime();
    await expect(
      rt.cron.add({
        name: 'x',
        schedule: { kind: 'at', at: '2026-01-01T00:00:00Z' },
        sessionTarget: 'main',
        payload: { kind: 'agentTurn', message: 'no' },
      }),
    ).rejects.toThrow(/sessionTarget/);
    await expect(
      rt.cron.add({
        name: 'x',
        schedule: { kind: 'cron', expr: '0 7 * * *' },
        sessionTarget: 'main',
        payload: { kind: 'systemEvent', text: 'hi' },
        delivery: { mode: 'announce' },
      }),
    ).rejects.toThrow(/announce delivery is only valid for isolated/);
    await expect(
      rt.cron.add({
        name: 'x',
        schedule: { kind: 'every', everyMs: 5 },
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'hi' },
      }),
    ).rejects.toThrow();
  });

  it('computes next run for at/every/cron schedules', async () => {
    const { rt } = await makeRuntime();
    const at = await rt.cron.add({
      name: 'once',
      schedule: { kind: 'at', at: '2030-01-01T09:00:00Z' },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'ping' },
    });
    expect(at.state.nextRunAtMs).toBe(Date.parse('2030-01-01T09:00:00Z'));
    expect(at.deleteAfterRun).toBe(true); // one-shot jobs default to deleting themselves

    const every = await rt.cron.add({
      name: 'loop',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'ping' },
    });
    expect(every.state.nextRunAtMs! - Date.now()).toBeLessThanOrEqual(3_600_000);

    const cron = await rt.cron.add({
      name: 'daily',
      schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'brief' },
    });
    expect(new Date(cron.state.nextRunAtMs!).toISOString()).toMatch(/T07:00:00/);

    // Relative shorthand from the CLI/tool ("20m").
    const soon = await rt.cron.add({
      name: 'soon',
      schedule: { kind: 'at', at: '20m' },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'later' },
    });
    expect(soon.state.nextRunAtMs! - Date.now()).toBeGreaterThan(19 * 60_000);
  });

  it('runs a main-session job as a system event and wakes the heartbeat', async () => {
    const { rt } = await makeRuntime();
    const wake = vi.spyOn(rt.heartbeat, 'requestNow');
    const job = await rt.cron.add({
      name: 'Reminder',
      schedule: { kind: 'at', at: '2030-01-01T00:00:00Z' },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'Submit the expense report' },
    });

    const record = await rt.cron.run(job.jobId);
    expect(record).toMatchObject({ status: 'ok', summary: 'Submit the expense report' });
    expect(rt.agent.hasSystemEvents(MAIN)).toBe(true);
    expect(wake).toHaveBeenCalledWith(`cron:${job.jobId}`);
    expect(rt.cron.get(job.jobId)).toBeUndefined(); // deleteAfterRun
    expect((await rt.cron.runs(job.jobId))[0]).toMatchObject({ status: 'ok' });
  });

  it('runs an isolated job in its own session and announces the summary', async () => {
    const { rt, script } = await makeRuntime([{ text: 'Inbox is clear.' }]);
    const sent: { channel: string; to: string; text: string }[] = [];
    vi.spyOn(rt.channels, 'send').mockImplementation((channel, to, text) => {
      sent.push({ channel, to, text });
      return Promise.resolve();
    });
    await rt.sessions.ensure(MAIN);
    await rt.sessions.patch(MAIN, { lastChannel: 'telegram', lastTo: '42' });

    const job = await rt.cron.add({
      name: 'Morning brief',
      schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' },
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: 'Summarise overnight updates.' },
      delivery: { mode: 'announce' },
    });
    const record = await rt.cron.run(job.jobId);

    expect(record).toMatchObject({ status: 'ok', summary: 'Inbox is clear.', delivered: true });
    expect(sent).toEqual([{ channel: 'telegram', to: '42', text: 'Inbox is clear.' }]);
    expect(script.transcript(0)[0]).toMatch(
      /^user: \[cron:[0-9a-f]+ Morning brief\] Summarise overnight updates\.$/,
    );
    expect(rt.agent.hasSystemEvents(MAIN)).toBe(true); // brief summary posted into the main session
    expect((await rt.sessions.list()).some((s) => s.key === `agent:main:cron:${job.jobId}`)).toBe(
      true,
    );
    expect(rt.cron.get(job.jobId)?.state.nextRunAtMs).toBeGreaterThan(Date.now()); // recurring job stays
  });

  it('records failures without killing the scheduler', async () => {
    const { rt } = await makeRuntime([{ error: 'model exploded' }]);
    const job = await rt.cron.add({
      name: 'bad',
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: 'go' },
      delivery: { mode: 'none' },
    });
    const record = await rt.cron.run(job.jobId);
    expect(record.status).toBe('error');
    expect(record.error).toMatch(/model exploded/);
    expect(rt.cron.get(job.jobId)?.state.lastStatus).toBe('error');
  });

  it('updates, disables and removes jobs, persisting to cron/jobs.json', async () => {
    const { rt } = await makeRuntime();
    const job = await rt.cron.add({
      name: 'j',
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'x' },
    });
    await rt.cron.update(job.jobId, { enabled: false, name: 'renamed' });
    expect(rt.cron.get(job.jobId)).toMatchObject({ name: 'renamed', enabled: false });
    expect(rt.cron.get(job.jobId)?.state.nextRunAtMs).toBeUndefined();

    const stored = JSON.parse(
      await fs.readFile(path.join(rt.paths.cronDir, 'jobs.json'), 'utf8'),
    ) as { jobs: unknown[] };
    expect(stored.jobs).toHaveLength(1);

    expect(await rt.cron.remove(job.jobId)).toEqual({ removed: true });
    expect(rt.cron.list()).toEqual([]);
  });

  it('fires due jobs on its timer', async () => {
    const { rt } = await makeRuntime();
    await rt.cron.start();
    const run = vi.spyOn(rt.cron, 'run');
    await rt.cron.add({
      name: 'soon',
      schedule: { kind: 'at', at: new Date(Date.now() + 300).toISOString() },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'tick' },
    });
    await vi.waitFor(() => expect(rt.agent.hasSystemEvents(MAIN)).toBe(true), { timeout: 8000 });
    expect(run).not.toHaveBeenCalled(); // fired by the scheduler, not a manual run
    rt.cron.stop();
  });

  it('exposes status', async () => {
    const { rt } = await makeRuntime();
    await rt.cron.add({
      name: 'j',
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'x' },
    });
    expect(rt.cron.status()).toMatchObject({ enabled: true, jobs: 1 });
    expect(rt.cron.status().nextWakeAtMs).toBeGreaterThan(Date.now());
  });
});
