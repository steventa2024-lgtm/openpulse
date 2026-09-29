import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Card, Empty, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { UnifiedDiff } from '../components/DiffView.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { useProject } from '../project/provider.js';
import { relativeTime } from '../format.js';
import { NoProject } from './NoProject.js';

interface GitFileChange {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
  renamedFrom?: string;
}

interface GitStatusResponse {
  isRepo: boolean;
  status?: {
    branch?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    detached: boolean;
    clean: boolean;
    files: GitFileChange[];
  };
  remotes?: { name: string; url: string }[];
}

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  refs: string;
}

interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
}

export function GitPage(): JSX.Element {
  const { active } = useProject();
  if (!active) return <NoProject title="Git" />;
  return <GitForProject key={active.id} />;
}

function GitForProject(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const { active } = useProject();
  const status = useQuery<GitStatusResponse>('git.status', {}, [active?.id]);
  const branches = useQuery<{ branches: GitBranch[] }>('git.branches', {}, [active?.id]);
  const log = useQuery<{ commits: GitCommit[] }>('git.log', { limit: 30 }, [active?.id]);
  const [selected, setSelected] = useState<GitFileChange>();
  const [diff, setDiff] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [message, setMessage] = useState('');

  const reloadAll = () => {
    status.reload();
    branches.reload();
    log.reload();
  };
  useGatewayEvent(['workspace.changed', 'projects.changed', 'changes.changed'], reloadAll);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    request<{ diff: string }>('git.diff', {
      file: selected.path,
      staged: selected.staged && !selected.worktree.match(/[MD]/),
    })
      .then((r) => !cancelled && setDiff(r.diff))
      .catch(
        (e: unknown) => !cancelled && setDiff(`Could not load the diff: ${(e as Error).message}`),
      );
    return () => {
      cancelled = true;
    };
  }, [selected, request]);

  if (status.data && !status.data.isRepo) {
    return (
      <>
        <PageHead title="Git" subtitle={active?.name} />
        <Card>
          <Empty>
            {active?.name} is not a git repository. Checkpoints still work (by copying files), but
            history, branches and diffs need git — run <span className="mono">git init</span> in the
            folder to enable them.
          </Empty>
        </Card>
      </>
    );
  }

  const s = status.data?.status;
  const files = s?.files ?? [];
  const staged = files.filter((f) => f.staged);

  return (
    <>
      <PageHead
        title="Git"
        subtitle={active?.name}
        actions={
          <>
            <button
              className="btn"
              onClick={() =>
                void act(async () => {
                  await request('git.fetch', {}, 300_000);
                  reloadAll();
                }, 'Fetched from origin')
              }
            >
              Fetch
            </button>
            <button className="btn" onClick={reloadAll}>
              Refresh
            </button>
          </>
        }
      />

      {status.error && <Card title="Git is not available">{status.error}</Card>}

      <div className="grid">
        <Card>
          <div className="stat">
            <span className="label">Branch</span>
            <span className="value">{s?.detached ? 'detached HEAD' : (s?.branch ?? '—')}</span>
            <span className="hint">
              {s?.upstream ? `tracking ${s.upstream} · ↑${s.ahead} ↓${s.behind}` : 'no upstream'}
            </span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="label">Working tree</span>
            <span className="value">
              {s ? (s.clean ? 'clean' : `${files.length} changed`) : '—'}
            </span>
            <span className="hint">
              {staged.length ? `${staged.length} staged` : 'nothing staged'}
            </span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="label">Remote</span>
            <span className="value" style={{ fontSize: '0.95rem' }}>
              {status.data?.remotes?.[0]?.name ?? 'none'}
            </span>
            <span className="hint mono" style={{ wordBreak: 'break-all' }}>
              {status.data?.remotes?.[0]?.url ?? ''}
            </span>
          </div>
        </Card>
      </div>

      <Card title="Changes">
        <Rows
          items={files}
          keyOf={(f) => f.path}
          empty="Nothing has changed since the last commit."
          onRowClick={setSelected}
          columns={[
            {
              header: '',
              width: '6.5rem',
              render: (f) => (
                <Pill tone={f.untracked ? 'warn' : f.staged ? 'ok' : 'idle'}>
                  {f.untracked ? 'new' : f.staged ? 'staged' : statusName(f.worktree)}
                </Pill>
              ),
            },
            {
              header: 'File',
              render: (f) => (
                <span className="mono" style={{ fontSize: 12 }}>
                  {f.renamedFrom ? `${f.renamedFrom} → ` : ''}
                  {f.path}
                </span>
              ),
            },
            {
              header: 'Index',
              width: '4rem',
              render: (f) => <span className="mono faint">{f.index}</span>,
            },
            {
              header: 'Tree',
              width: '4rem',
              render: (f) => <span className="mono faint">{f.worktree}</span>,
            },
          ]}
        />
      </Card>

      {selected && (
        <Card
          title={`Diff · ${selected.path}`}
          actions={
            <button className="btn ghost" onClick={() => setSelected(undefined)}>
              Close
            </button>
          }
        >
          <UnifiedDiff diff={diff} />
        </Card>
      )}

      <Card title="Commit">
        <p className="muted" style={{ marginTop: 0 }}>
          Commits every changed file in this list. Review agent changes under Changes first — this
          commits whatever is on disk.
        </p>
        <Field label="Message">
          <textarea
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Describe the change"
          />
        </Field>
        <button
          className="btn primary"
          disabled={!message.trim() || files.length === 0}
          onClick={() =>
            void act(async () => {
              const result = await request<{ hash: string }>('git.commit', {
                message: message.trim(),
                files: files.map((f) => f.path),
              });
              setMessage('');
              reloadAll();
              return result;
            }, 'Committed')
          }
        >
          Commit {files.length} file{files.length === 1 ? '' : 's'}
        </button>
      </Card>

      <div className="grid">
        <Card title="Branches">
          <Rows
            items={(branches.data?.branches ?? []).filter((b) => !b.remote)}
            keyOf={(b) => b.name}
            empty="No local branches."
            columns={[
              {
                header: '',
                width: '5rem',
                render: (b) => (b.current ? <Pill tone="ok">current</Pill> : null),
              },
              { header: 'Branch', render: (b) => <span className="mono">{b.name}</span> },
              {
                header: '',
                render: (b) =>
                  b.current ? null : (
                    <button
                      className="btn"
                      onClick={() =>
                        void act(async () => {
                          await request('git.checkout', { branch: b.name });
                          reloadAll();
                        }, `Switched to ${b.name}`)
                      }
                    >
                      Switch
                    </button>
                  ),
              },
            ]}
          />
          <form
            style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await request('git.checkout', { branch: newBranch.trim(), create: true });
                setNewBranch('');
                reloadAll();
              }, `Created ${newBranch.trim()}`);
            }}
          >
            <input
              type="text"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="new-branch-name"
            />
            <button className="btn" type="submit" disabled={!newBranch.trim()}>
              Create
            </button>
          </form>
        </Card>

        <Card title="History">
          <Rows
            items={log.data?.commits ?? []}
            keyOf={(c) => c.hash}
            empty="No commits yet."
            columns={[
              {
                header: '',
                width: '5rem',
                render: (c) => <span className="mono faint">{c.shortHash}</span>,
              },
              {
                header: 'Commit',
                render: (c) => (
                  <>
                    <div>{c.subject}</div>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {c.author} · {relativeTime(c.date)}
                      {c.refs ? ` · ${c.refs}` : ''}
                    </span>
                  </>
                ),
              },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

function statusName(code: string): string {
  return code === 'M'
    ? 'modified'
    : code === 'D'
      ? 'deleted'
      : code === 'A'
        ? 'added'
        : code === 'R'
          ? 'renamed'
          : code === 'U'
            ? 'conflict'
            : code;
}
