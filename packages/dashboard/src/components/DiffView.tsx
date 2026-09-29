import type { JSX } from 'react';

interface DiffRow {
  kind: 'hunk' | 'meta' | 'add' | 'del' | 'context';
  oldLine?: number;
  newLine?: number;
  text: string;
}

/** Turn a unified diff into rows with old/new line numbers. Pure, so rendering stays pure. */
export function diffRows(diff: string, maxLines = 2000): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n').slice(0, maxLines)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (/^(diff |index |--- |\+\+\+ )/.test(line)) {
      rows.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', newLine: newLine++, text: line });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldLine: oldLine++, text: line });
    } else if (line) {
      rows.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text: line });
    } else {
      rows.push({ kind: 'context', text: line });
    }
  }
  return rows;
}

/**
 * Renders a unified diff with line numbers and colouring. Used where a full side-by-side editor
 * would be too heavy — git status, commit previews, workflow summaries.
 */
export function UnifiedDiff({
  diff,
  maxLines = 2000,
}: {
  diff: string;
  maxLines?: number;
}): JSX.Element {
  if (!diff.trim()) return <div className="empty">No changes.</div>;
  const rows = diffRows(diff, maxLines);
  const truncated = diff.split('\n').length > maxLines;

  return (
    <div className="diff-view mono">
      {rows.map((row, index) => (
        <div key={index} className={`diff-line ${row.kind === 'context' ? '' : row.kind}`}>
          <span className="ln">{row.oldLine ?? ''}</span>
          <span className="ln">{row.newLine ?? ''}</span>
          <span className="code">{row.text}</span>
        </div>
      ))}
      {truncated && <div className="faint">… diff truncated</div>}
    </div>
  );
}

export function DiffStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}): JSX.Element {
  return (
    <span className="mono" style={{ fontSize: 12 }}>
      <span style={{ color: 'var(--ok)' }}>+{additions}</span>{' '}
      <span style={{ color: 'var(--err)' }}>−{deletions}</span>
    </span>
  );
}
