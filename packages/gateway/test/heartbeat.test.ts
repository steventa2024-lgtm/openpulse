import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_TOKEN } from '../src/agent/system-prompt.js';
import { withinActiveHours } from '../src/heartbeat/runner.js';
import { isHeartbeatFileEmpty } from '../src/workspace/workspace.js';
import { makeRuntime } from './helpers.js';

const MAIN = 'agent:main:main';

async function setup(steps: Parameters<typeof makeRuntime>[0], heartbeatText?: string) {
  const t = await makeRuntime(steps);
  if (heartbeatText !== undefined)
    await fs.writeFile(path.join(t.rt.workspaceDir, 'HEARTBEAT.md'), heartbeatText);
  const sent: { channel: string; to: string; text: string }[] = [];
  vi.spyOn(t.rt.channels, 'send').mockImplementation((channel, to, text) => {
    sent.push({ channel, to, text });
    return Promise.resolve();
  });
  return { ...t, sent };
}

describe('heartbeat', () => {
  it('skips (without calling the model) when HEARTBEAT.md has no tasks', async () => {
    const { rt, script } = await setup([{ text: 'should not run' }]);
    const event = await rt.heartbeat.runOnce('manual');
    expect(event).toMatchObject({ status: 'skipped', reason: 'empty-heartbeat-file' });
    expect(script.count).toBe(0);
  });

  it('runs when a system event is queued even with an empty file', async () => {
    const { rt, script } = await setup([{ text: HEARTBEAT_TOKEN }]);
    rt.agent.enqueueSystemEvent(MAIN, 'Cron: check the oven');
    const event = await rt.heartbeat.runOnce('cron');
    expect(event.status).toBe('ok-empty');
    expect(script.transcript(0)[0]).toContain('System: Cron: check the oven');
  });

  it('swallows HEARTBEAT_OK replies', async () => {
    const { rt, sent } = await setup([{ text: HEARTBEAT_TOKEN }], '- check disk space');
    expect(await rt.heartbeat.runOnce()).toMatchObject({ status: 'ok-empty' });
    expect(sent).toEqual([]);
  });

  it('delivers alerts to the last route', async () => {
    const { rt, sent } = await setup([{ text: 'Disk is 95% full on C:' }], '- check disk space');
    await rt.sessions.ensure(MAIN);
    await rt.sessions.patch(MAIN, { lastChannel: 'telegram', lastTo: '42' });

    const event = await rt.heartbeat.runOnce();
    expect(event).toMatchObject({ status: 'sent', channel: 'telegram', to: '42' });
    expect(sent).toEqual([{ channel: 'telegram', to: '42', text: 'Disk is 95% full on C:' }]);
  });

  it('skips delivery when there is no route or target is none', async () => {
    const noRoute = await setup([{ text: 'Something happened' }], '- watch');
    expect(await noRoute.rt.heartbeat.runOnce()).toMatchObject({
      status: 'skipped',
      reason: 'no-target',
    });

    const off = await setup([{ text: 'Something happened' }], '- watch');
    await off.rt.config.patch({ agents: { defaults: { heartbeat: { target: 'none' } } } });
    expect(await off.rt.heartbeat.runOnce()).toMatchObject({
      status: 'skipped',
      reason: 'target-none',
    });
    expect(off.sent).toEqual([]);
  });

  it('honours enable/disable and reports failures', async () => {
    const { rt } = await setup([{ error: 'provider down' }], '- watch');
    rt.heartbeat.setEnabled(false);
    expect(await rt.heartbeat.runOnce()).toMatchObject({ status: 'skipped', reason: 'disabled' });
    rt.heartbeat.setEnabled(true);
    expect(await rt.heartbeat.runOnce()).toMatchObject({ status: 'failed' });
    expect(rt.heartbeat.lastEvent()?.status).toBe('failed');
  });

  it('schedules the next run from the configured interval', async () => {
    const { rt } = await setup([], '- watch');
    await rt.config.patch({ agents: { defaults: { heartbeat: { every: '30m' } } } });
    rt.heartbeat.start();
    const next = rt.heartbeat.nextRunAt()!;
    expect(next - Date.now()).toBeGreaterThan(29 * 60_000);

    await rt.config.patch({ agents: { defaults: { heartbeat: { every: '0m' } } } });
    rt.heartbeat.reconfigure();
    expect(rt.heartbeat.nextRunAt()).toBeUndefined();
    rt.heartbeat.stop();
  });
});

describe('heartbeat helpers', () => {
  it('detects an effectively empty HEARTBEAT.md', () => {
    expect(isHeartbeatFileEmpty('')).toBe(true);
    expect(isHeartbeatFileEmpty('# HEARTBEAT.md\n\n# only comments\n')).toBe(true);
    expect(isHeartbeatFileEmpty('<!-- note -->\n- [ ]\n')).toBe(true);
    expect(isHeartbeatFileEmpty('# tasks\n- check disk space\n')).toBe(false);
    expect(isHeartbeatFileEmpty('- [ ] water the plants\n')).toBe(false);
  });

  it('computes active hours windows, including overnight', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h, 30));
    expect(withinActiveHours({ start: '08:00', end: '22:00', timezone: 'UTC' }, at(12))).toBe(true);
    expect(withinActiveHours({ start: '08:00', end: '22:00', timezone: 'UTC' }, at(23))).toBe(
      false,
    );
    expect(withinActiveHours({ start: '22:00', end: '06:00', timezone: 'UTC' }, at(23))).toBe(true);
    expect(withinActiveHours({ start: '22:00', end: '06:00', timezone: 'UTC' }, at(12))).toBe(
      false,
    );
  });
});
