import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { AgentService } from '../agent/agent-service.js';
import {
  DEFAULT_HEARTBEAT_PROMPT,
  isSilentReply,
  stripHeartbeatToken,
} from '../agent/system-prompt.js';
import { parseDurationMs, type OpenPulseConfig } from '../config/schema.js';
import type { Logger } from '../infra/logger.js';
import type { SessionStore } from '../sessions/store.js';
import { readTextOr } from '../util/fs.js';
import { isHeartbeatFileEmpty } from '../workspace/workspace.js';

export interface HeartbeatEvent {
  ts: number;
  status: 'sent' | 'ok-token' | 'ok-empty' | 'skipped' | 'failed';
  reason?: string;
  trigger: string;
  preview?: string;
  durationMs?: number;
  channel?: string;
  to?: string;
}

export interface HeartbeatDeps {
  config: () => OpenPulseConfig;
  workspace: () => string;
  agent: AgentService;
  sessions: SessionStore;
  deliver: (channel: string, to: string, text: string) => Promise<void>;
  log: Logger;
}

/**
 * Periodic main-session turns. Reads HEARTBEAT.md via the heartbeat prompt; "HEARTBEAT_OK"
 * replies are swallowed, anything else is delivered to the target (default: last chat route).
 */
export class HeartbeatRunner extends EventEmitter<{ heartbeat: [HeartbeatEvent] }> {
  private timer: NodeJS.Timeout | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private enabled = true;
  private running = false;
  private last: HeartbeatEvent | undefined;
  private nextAt: number | undefined;
  private intervalSig = '';

  constructor(private readonly deps: HeartbeatDeps) {
    super();
  }

  start(): void {
    this.schedule(true);
  }

  stop(): void {
    clearTimeout(this.timer);
    clearTimeout(this.wakeTimer);
    this.timer = undefined;
    this.nextAt = undefined;
  }

  /** Re-arm when config changes the interval. */
  reconfigure(): void {
    const sig = this.deps.config().agents.defaults.heartbeat.every;
    if (sig !== this.intervalSig) this.schedule(true);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.schedule(true);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  lastEvent(): HeartbeatEvent | undefined {
    return this.last;
  }

  nextRunAt(): number | undefined {
    return this.nextAt;
  }

  /** Run soon (coalesces bursts, e.g. several cron wakes). */
  requestNow(reason: string): void {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => void this.runOnce(reason), 250);
  }

  private schedule(reset: boolean): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.nextAt = undefined;
    const every = this.deps.config().agents.defaults.heartbeat.every;
    this.intervalSig = every;
    let ms: number;
    try {
      ms = parseDurationMs(every);
    } catch {
      ms = 0;
    }
    if (!this.enabled || ms <= 0) return;
    void reset;
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      void this.runOnce('interval').finally(() => this.schedule(false));
    }, ms);
    this.timer.unref?.();
  }

  async runOnce(trigger = 'manual'): Promise<HeartbeatEvent> {
    const started = Date.now();
    const cfg = this.deps.config().agents.defaults.heartbeat;
    const mainKey = this.deps.agent.mainKey;
    const done = (e: Omit<HeartbeatEvent, 'ts' | 'trigger'>): HeartbeatEvent => {
      const ev: HeartbeatEvent = {
        ts: Date.now(),
        trigger,
        durationMs: Date.now() - started,
        ...e,
      };
      this.last = ev;
      this.emit('heartbeat', ev);
      return ev;
    };

    if (!this.enabled) return done({ status: 'skipped', reason: 'disabled' });
    if (this.running) return done({ status: 'skipped', reason: 'already-running' });
    if (cfg.activeHours && !withinActiveHours(cfg.activeHours, new Date()))
      return done({ status: 'skipped', reason: 'quiet-hours' });
    if (this.deps.agent.isBusy(mainKey))
      return done({ status: 'skipped', reason: 'requests-in-flight' });

    const hbText = await readTextOr(path.join(this.deps.workspace(), 'HEARTBEAT.md'), '');
    if (isHeartbeatFileEmpty(hbText) && !this.deps.agent.hasSystemEvents(mainKey)) {
      return done({ status: 'skipped', reason: 'empty-heartbeat-file' });
    }

    this.running = true;
    try {
      const result = await this.deps.agent.runAndWait({
        sessionKey: mainKey,
        message: cfg.prompt ?? DEFAULT_HEARTBEAT_PROMPT,
        source: { kind: 'heartbeat', channel: 'heartbeat' },
      });
      if (result.error) return done({ status: 'failed', reason: result.error });
      if (result.aborted) return done({ status: 'skipped', reason: 'aborted' });

      const stripped = stripHeartbeatToken(result.text, cfg.ackMaxChars);
      if (stripped.ok || isSilentReply(result.text)) {
        this.deps.log.debug('heartbeat ok');
        return done({ status: stripped.text ? 'ok-token' : 'ok-empty' });
      }

      const target = await this.resolveTarget(cfg.target, cfg.to);
      if (!target)
        return done({
          status: 'skipped',
          reason: cfg.target === 'none' ? 'target-none' : 'no-target',
          preview: stripped.text.slice(0, 200),
        });
      await this.deps.deliver(target.channel, target.to, stripped.text);
      this.deps.log.info(`heartbeat alert sent to ${target.channel}:${target.to}`);
      return done({
        status: 'sent',
        preview: stripped.text.slice(0, 200),
        channel: target.channel,
        to: target.to,
      });
    } catch (error) {
      return done({ status: 'failed', reason: (error as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async resolveTarget(
    target: string,
    to?: string,
  ): Promise<{ channel: string; to: string } | undefined> {
    if (target === 'none') return undefined;
    const main = await this.deps.sessions.get(this.deps.agent.mainKey);
    if (target === 'last') {
      return main?.lastChannel && main.lastTo
        ? { channel: main.lastChannel, to: main.lastTo }
        : undefined;
    }
    const recipient = to ?? (main?.lastChannel === target ? main.lastTo : undefined);
    return recipient ? { channel: target, to: recipient } : undefined;
  }
}

export function withinActiveHours(
  hours: { start: string; end: string; timezone?: string },
  now: Date,
): boolean {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(hours.timezone && { timeZone: hours.timezone }),
  });
  const [h, m] = fmt.format(now).split(':').map(Number);
  const cur = h! * 60 + m!;
  const toMin = (s: string) => {
    const [a, b] = s.split(':').map(Number);
    return a! * 60 + b!;
  };
  const start = toMin(hours.start);
  const end = toMin(hours.end);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
