/** Terminal colours. Honours NO_COLOR, --no-color and non-TTY output. */
let enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function setColor(on: boolean): void {
  enabled = on;
}

const wrap = (open: string) => (s: string | number) => (enabled ? `[${open}m${s}[0m` : String(s));

export const c = {
  accent: wrap('38;5;209'), // lobster coral
  accentBright: wrap('38;5;215'),
  info: wrap('38;5;216'),
  success: wrap('32'),
  warn: wrap('33'),
  error: wrap('31'),
  muted: wrap('90'),
  bold: wrap('1'),
  underline: wrap('4'),
};

export function statusDot(ok: boolean | undefined): string {
  return ok === undefined ? c.muted('○') : ok ? c.success('●') : c.error('●');
}

export function table(rows: (string | number | undefined)[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all)
    row.forEach(
      (cell, i) => (widths[i] = Math.max(widths[i] ?? 0, stripAnsi(String(cell ?? '')).length)),
    );
  const line = (row: (string | number | undefined)[]) =>
    row
      .map((cell, i) => pad(String(cell ?? ''), widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const out = headers ? [c.muted(line(headers)), ...rows.map(line)] : rows.map(line);
  return out.join('\n');
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - stripAnsi(s).length));
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

export function relativeTime(ts: number | string | undefined | null): string {
  if (!ts) return '—';
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts;
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}
