export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffStat {
  additions: number;
  deletions: number;
}

/**
 * Unified diff between two texts.
 *
 * Computed here rather than shelling out to git, so it works for files that are untracked, for
 * projects with no repository at all, and for content that only exists as a proposal.
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: { path?: string; oldPath?: string; context?: number } = {},
): string {
  const context = options.context ?? 3;
  const path = options.path ?? 'file';
  const oldPath = options.oldPath ?? path;
  const hunks = diffHunks(before, after, context);
  if (hunks.length === 0) return '';

  const head = [`--- a/${oldPath}`, `+++ b/${path}`];
  const body = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ]);
  return [...head, ...body, ''].join('\n');
}

export function diffStat(before: string, after: string): DiffStat {
  let additions = 0;
  let deletions = 0;
  for (const op of diffOps(splitLines(before), splitLines(after))) {
    if (op.type === 'add') additions += 1;
    else if (op.type === 'remove') deletions += 1;
  }
  return { additions, deletions };
}

export function diffHunks(before: string, after: string, context = 3): DiffHunk[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const ops = diffOps(oldLines, newLines);

  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.type === 'equal') {
      index += 1;
      continue;
    }
    // Walk back over the context lines before the change.
    let start = index;
    let leading = 0;
    while (start > 0 && ops[start - 1]!.type === 'equal' && leading < context) {
      start -= 1;
      leading += 1;
    }
    // Walk forward to the end of the change, absorbing short equal runs.
    let end = index;
    let trailing = 0;
    while (end < ops.length) {
      if (ops[end]!.type !== 'equal') {
        trailing = 0;
        end += 1;
        continue;
      }
      if (trailing < context * 2) {
        trailing += 1;
        end += 1;
        continue;
      }
      break;
    }
    const cut = Math.max(index + 1, end - Math.max(0, trailing - context));
    const slice = ops.slice(start, cut);

    const hunk: DiffHunk = {
      oldStart: slice[0]!.oldLine,
      oldLines: slice.filter((op) => op.type !== 'add').length,
      newStart: slice[0]!.newLine,
      newLines: slice.filter((op) => op.type !== 'remove').length,
      lines: slice.map(
        (op) => `${op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' '}${op.text}`,
      ),
    };
    if (hunk.oldLines === 0) hunk.oldStart = Math.max(0, hunk.oldStart - 1);
    if (hunk.newLines === 0) hunk.newStart = Math.max(0, hunk.newStart - 1);
    hunks.push(hunk);
    index = cut;
  }
  return hunks;
}

interface DiffOp {
  type: 'equal' | 'add' | 'remove';
  text: string;
  /** 1-based line numbers in each side. */
  oldLine: number;
  newLine: number;
}

/**
 * Line operations via the classic longest-common-subsequence table, with a fast path for the
 * common case of a shared prefix and suffix so large files stay cheap.
 */
export function diffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const ops: DiffOp[] = [];

  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ type: 'equal', text: oldLines[i]!, oldLine: oldLine++, newLine: newLine++ });
  }

  for (const op of lcsOps(oldMiddle, newMiddle)) {
    if (op.type === 'equal') {
      ops.push({ type: 'equal', text: op.text, oldLine: oldLine++, newLine: newLine++ });
    } else if (op.type === 'remove') {
      ops.push({ type: 'remove', text: op.text, oldLine: oldLine++, newLine });
    } else {
      ops.push({ type: 'add', text: op.text, oldLine, newLine: newLine++ });
    }
  }

  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
    ops.push({ type: 'equal', text: oldLines[i]!, oldLine: oldLine++, newLine: newLine++ });
  }
  return ops;
}

function lcsOps(a: string[], b: string[]): { type: 'equal' | 'add' | 'remove'; text: string }[] {
  // Guard against pathological inputs: fall back to "replace everything".
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text) => ({ type: 'remove' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + (j + 1)]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + (j + 1)]!);
    }
  }

  const ops: { type: 'equal' | 'add' | 'remove'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + (j + 1)]!) {
      ops.push({ type: 'remove', text: a[i]! });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: 'remove', text: a[i++]! });
  while (j < b.length) ops.push({ type: 'add', text: b[j++]! });
  return ops;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline produces an empty last element that is not a real line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
