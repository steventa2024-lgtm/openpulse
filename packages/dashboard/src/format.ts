import type { LogLine } from './types.js';

export function relativeTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(ms)) return '—';
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const unit =
    abs < 45_000
      ? `${Math.max(1, Math.round(abs / 1000))}s`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function clockTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function logTime(ts: number | string | null | undefined): string {
  if (!ts) return '--:--:--';
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

export function dateTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function duration(ms: number | undefined | null): string {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function compactNumber(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function bytes(n: number | undefined): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** "agent:main:telegram:dm:42" → "Telegram DM 42" */
export function sessionLabel(key: string, fallback?: string): string {
  if (fallback) return fallback;
  const parts = key.split(':');
  if (parts.length <= 3 && parts[2] === 'main') return 'Main session';
  const [, , channel, kind, id, , topic] = parts;
  if (channel === 'cron') return `Cron ${kind ?? ''}`.trim();
  const channelName = channel ? channel.charAt(0).toUpperCase() + channel.slice(1) : 'Session';
  const kindName = kind === 'dm' ? 'DM' : kind === 'group' ? 'group' : (kind ?? '');
  return [channelName, kindName, id, topic ? `topic ${topic}` : ''].filter(Boolean).join(' ');
}

export function scheduleLabel(schedule: {
  kind: string;
  at?: string;
  everyMs?: number;
  expr?: string;
  tz?: string;
}): string {
  if (schedule.kind === 'every') return `every ${duration(schedule.everyMs)}`;
  if (schedule.kind === 'at') return `once at ${dateTime(schedule.at)}`;
  return `cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
}

export function parseLogLine(line: string): LogLine | undefined {
  try {
    const parsed = JSON.parse(line) as LogLine;
    return parsed.time ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Name a conversation after what was asked — the words after a starter's "…:" line, if any. */
export function titleFrom(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.length > 1 && lines[0]!.endsWith(':') ? lines.slice(1).join(' ') : lines[0];
  const clean = (line ?? text).replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}
