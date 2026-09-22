import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHead } from '../components/ui.js';
import { useGateway } from '../gateway/provider.js';
import { logTime, parseLogLine } from '../format.js';
import type { LogLine, LogTail } from '../types.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

export function LogsPage(): JSX.Element {
  const { request, status } = useGateway();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('info');
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [file, setFile] = useState('');
  const cursor = useRef<number | undefined>(undefined);
  const view = useRef<HTMLDivElement>(null);

  const pull = useCallback(
    async (replace = false) => {
      const tail = await request<LogTail>('logs.tail', {
        ...(cursor.current !== undefined && { cursor: cursor.current }),
        limit: 500,
      });
      cursor.current = tail.cursor;
      setFile(tail.file);
      const parsed = tail.lines.map(parseLogLine).filter((l): l is LogLine => Boolean(l));
      if (parsed.length === 0 && !replace) return;
      setLines((current) => [...(tail.reset || replace ? [] : current), ...parsed].slice(-3000));
    },
    [request],
  );

  useEffect(() => {
    if (status.state !== 'open') return;
    cursor.current = undefined;
    void pull(true).catch(() => undefined);
  }, [status.state, pull]);

  useEffect(() => {
    if (!follow || status.state !== 'open') return;
    const timer = window.setInterval(() => void pull().catch(() => undefined), 1500);
    return () => window.clearInterval(timer);
  }, [follow, pull, status.state]);

  useEffect(() => {
    if (follow) view.current?.scrollTo({ top: view.current.scrollHeight });
  }, [lines, follow]);

  const minLevel = LEVELS.indexOf(level);
  const needle = filter.trim().toLowerCase();
  const visible = lines.filter(
    (line) =>
      LEVELS.indexOf(line.level) >= minLevel &&
      (!needle ||
        line.msg.toLowerCase().includes(needle) ||
        line.subsystem.toLowerCase().includes(needle)),
  );

  return (
    <>
      <PageHead title="Logs" subtitle={file} />
      <div className="toolbar">
        <select
          value={level}
          onChange={(event) => setLevel(event.target.value as (typeof LEVELS)[number])}
          style={{ width: 'auto' }}
        >
          {LEVELS.map((name) => (
            <option key={name} value={name}>
              {name}+
            </option>
          ))}
        </select>
        <input
          type="text"
          value={filter}
          placeholder="filter…"
          onChange={(event) => setFilter(event.target.value)}
          style={{ width: '14rem' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
            style={{ width: 'auto' }}
          />{' '}
          Follow
        </label>
        <div className="spacer" />
        <span className="faint">{visible.length} lines</span>
        <button className="btn" onClick={() => setLines([])}>
          Clear
        </button>
      </div>

      <div className="log-view" ref={view}>
        {visible.length === 0 ? (
          <span className="faint">No log lines yet.</span>
        ) : (
          visible.map((line, index) => (
            <div className="log-line" key={`${line.time}-${index}`}>
              <span className="time">{logTime(line.time)}</span>
              <span className={`lvl ${line.level}`}>{line.level.toUpperCase()}</span>
              <span className="sub">{line.subsystem}</span>
              <span>{line.msg}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
