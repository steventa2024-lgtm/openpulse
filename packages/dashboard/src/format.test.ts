import { describe, expect, it } from 'vitest';
import {
  bytes,
  compactNumber,
  duration,
  logTime,
  parseLogLine,
  relativeTime,
  scheduleLabel,
  sessionLabel,
} from './format.js';

describe('relativeTime', () => {
  it('describes the past and the future', () => {
    expect(relativeTime(Date.now() - 5_000)).toBe('5s ago');
    expect(relativeTime(Date.now() - 3 * 60_000)).toBe('3m ago');
    expect(relativeTime(Date.now() + 2 * 3_600_000)).toBe('in 2h');
  });

  it('handles missing and unparseable timestamps', () => {
    expect(relativeTime(undefined)).toBe('—');
    expect(relativeTime(null)).toBe('—');
    expect(relativeTime('not a date')).toBe('—');
  });
});

describe('sessionLabel', () => {
  it('names the main session', () => {
    expect(sessionLabel('agent:main:main')).toBe('Main session');
  });

  it('names channel sessions', () => {
    expect(sessionLabel('agent:main:telegram:dm:42')).toBe('Telegram DM 42');
    expect(sessionLabel('agent:main:telegram:group:-100:topic:7')).toBe(
      'Telegram group -100 topic 7',
    );
  });

  it('prefers an explicit label', () => {
    expect(sessionLabel('agent:main:telegram:dm:42', 'Ana')).toBe('Ana');
  });
});

describe('scheduleLabel', () => {
  it('renders each schedule kind', () => {
    expect(scheduleLabel({ kind: 'every', everyMs: 1_800_000 })).toBe('every 30m 0s');
    expect(scheduleLabel({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe(
      'cron 0 9 * * * (UTC)',
    );
    expect(scheduleLabel({ kind: 'at', at: 'not-a-date' })).toBe('once at —');
  });
});

describe('formatting helpers', () => {
  it('compacts numbers and bytes', () => {
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(2_400_000)).toBe('2.4M');
    expect(bytes(0)).toBe('0 B');
    expect(bytes(2048)).toBe('2.0 KB');
  });

  it('formats durations', () => {
    expect(duration(45_000)).toBe('45s');
    expect(duration(90_000)).toBe('1m 30s');
    expect(duration(3 * 3_600_000)).toBe('3h 0m');
  });
});

describe('logTime', () => {
  it('renders a local wall-clock time with seconds', () => {
    expect(logTime('2026-01-01T09:07:05.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('falls back for junk', () => {
    expect(logTime('nope')).toBe('--:--:--');
    expect(logTime(undefined)).toBe('--:--:--');
  });
});

describe('parseLogLine', () => {
  it('parses a JSONL record', () => {
    const line = JSON.stringify({
      time: '2026-01-01T09:00:00.000Z',
      level: 'info',
      subsystem: 'gateway',
      msg: 'listening',
    });
    expect(parseLogLine(line)).toMatchObject({ level: 'info', msg: 'listening' });
  });

  it('ignores junk', () => {
    expect(parseLogLine('not json')).toBeUndefined();
    expect(parseLogLine('{"level":"info"}')).toBeUndefined();
  });
});
