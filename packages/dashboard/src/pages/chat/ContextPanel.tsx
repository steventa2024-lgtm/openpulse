import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import {
  Box,
  Clock3,
  FileCode2,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  ListChecks,
  MessagesSquare,
  Package,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  Activity,
} from 'lucide-react';
import { useGateway, useGatewayEvent, useQuery } from '../../gateway/provider.js';
import { useProject } from '../../project/provider.js';
import { duration, relativeTime } from '../../format.js';
import type { HealthSnapshot, PendingApproval } from '../../types.js';

interface TreeEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  collapsed?: boolean;
}

interface ChangeSummary {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  files: { path: string; action: string }[];
}

/** Root files worth pointing at when a project has them. */
const LANDMARKS = [
  'README.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
];

/**
 * The column beside the chat: what the agent is working in, what is waiting for you, and the
 * state of the gateway. Every number here comes from the gateway.
 */
export function ContextPanel({
  model,
  approvals,
  sessionCount,
  onReviewApproval,
}: {
  model?: string;
  approvals: PendingApproval[];
  sessionCount: number;
  onReviewApproval: (id: string) => void;
}): JSX.Element {
  return (
    <aside className="chat-context">
      <ProjectContext />
      <PendingApprovals approvals={approvals} onReviewApproval={onReviewApproval} />
      <SystemCard model={model} sessionCount={sessionCount} />
    </aside>
  );
}

function ProjectContext(): JSX.Element {
  const { active } = useProject();
  const projectId = active?.id ?? '';
  const tree = useQuery<{ entries: TreeEntry[] }>('workspace.tree', { projectId, depth: 4 }, [
    projectId,
  ]);
  const git = useQuery<{ isRepo: boolean; status?: { branch?: string; files: unknown[] } }>(
    'git.status',
    { projectId },
    [projectId],
  );
  useGatewayEvent(['workspace.changed', 'changes.changed'], () => {
    tree.reload();
    git.reload();
  });

  if (!active) {
    return (
      <section className="ctx-card">
        <h3>
          <Folder aria-hidden /> Project Context
        </h3>
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
          No project open. <a href="#/projects">Add one</a> so the agent knows where to work.
        </p>
      </section>
    );
  }

  const entries = tree.data?.entries ?? [];
  const files = entries.filter((e) => e.type === 'file');
  const partial = entries.some((e) => e.collapsed);
  const landmarks = LANDMARKS.filter((name) => entries.some((e) => e.path === name));
  const changed = git.data?.status?.files.length ?? 0;

  return (
    <section className="ctx-card">
      <h3>
        <Folder aria-hidden /> Project Context
      </h3>
      <div className="ctx-project">
        <span className="ctx-row-main">
          <FolderGit2 aria-hidden /> {active.name}
        </span>
        {git.data?.status?.branch && (
          <span className="ctx-chip">
            <GitBranch aria-hidden /> {git.data.status.branch}
          </span>
        )}
      </div>
      <ul className="ctx-list">
        <li>
          <FileCode2 aria-hidden />
          {tree.data ? `${files.length}${partial ? '+' : ''} files` : 'Counting files…'}
        </li>
        {git.data?.isRepo && (
          <li>
            <Activity aria-hidden />
            <a href="#/git">
              {changed} changed file{changed === 1 ? '' : 's'}
            </a>
          </li>
        )}
        {landmarks.map((name) => (
          <li key={name}>
            {name.endsWith('.md') ? <FileText aria-hidden /> : <Package aria-hidden />}
            {name}
          </li>
        ))}
      </ul>
      <a className="ctx-more" href="#/editor">
        View all files →
      </a>
    </section>
  );
}

function PendingApprovals({
  approvals,
  onReviewApproval,
}: {
  approvals: PendingApproval[];
  onReviewApproval: (id: string) => void;
}): JSX.Element {
  const { active } = useProject();
  const projectId = active?.id ?? '';
  const changes = useQuery<{ changes: ChangeSummary[] }>('changes.list', { projectId }, [
    projectId,
  ]);
  useGatewayEvent('changes.changed', () => changes.reload());
  const pendingChanges = (changes.data?.changes ?? []).filter((c) => c.status === 'pending');
  const total = pendingChanges.length + approvals.length;

  return (
    <section className="ctx-card">
      <h3>
        <ListChecks aria-hidden /> Pending Approvals
        {total > 0 && <span className="ctx-count">{total}</span>}
      </h3>
      {total === 0 && (
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
          Nothing waiting for you.
        </p>
      )}
      <ul className="ctx-approvals">
        {pendingChanges.map((change) => (
          <li key={change.id}>
            <span className="ctx-approval-icon">
              <FileCode2 aria-hidden />
            </span>
            <span className="ctx-approval-text">
              <strong>
                {change.files.length === 1
                  ? `${verb(change.files[0]!.action)} ${change.files[0]!.path}`
                  : change.title}
              </strong>
              <small>Proposed {relativeTime(change.createdAt)}</small>
            </span>
            <a className="ctx-review" href="#/changes">
              Review
            </a>
          </li>
        ))}
        {approvals.map((approval) => (
          <li key={approval.id}>
            <span className="ctx-approval-icon warn">
              {approval.request.risk.level === 'high' ? (
                <ShieldAlert aria-hidden />
              ) : (
                <SquareTerminal aria-hidden />
              )}
            </span>
            <span className="ctx-approval-text">
              <strong className="mono">Run {approval.request.command}</strong>
              <small>Requested {relativeTime(approval.createdAtMs)}</small>
            </span>
            <button className="ctx-review" onClick={() => onReviewApproval(approval.id)}>
              Review
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SystemCard({
  model,
  sessionCount,
}: {
  model?: string;
  sessionCount: number;
}): JSX.Element {
  const { request, status } = useGateway();
  const tools = useQuery<{ tools: unknown[] }>('tools.list');
  const [health, setHealth] = useState<HealthSnapshot>();

  useEffect(() => {
    if (status.state !== 'open') return;
    let alive = true;
    const poll = () =>
      request<HealthSnapshot>('health')
        .then((h) => alive && setHealth(h))
        .catch(() => undefined);
    void poll();
    const timer = window.setInterval(poll, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [request, status.state]);

  return (
    <section className="ctx-card">
      <h3>
        <Activity aria-hidden /> System
      </h3>
      <dl className="ctx-kv">
        <dt>
          <Box aria-hidden /> Model
        </dt>
        <dd title={model}>{model ?? '—'}</dd>
        <dt>
          <Wrench aria-hidden /> Tools
        </dt>
        <dd>
          {tools.data ? (
            <>
              <span className="ctx-dot" /> {tools.data.tools.length} available
            </>
          ) : (
            '—'
          )}
        </dd>
        <dt>
          <MessagesSquare aria-hidden /> Sessions
        </dt>
        <dd>{sessionCount}</dd>
        <dt>
          <Clock3 aria-hidden /> Uptime
        </dt>
        <dd>
          {health ? (
            <>
              <span className="ctx-dot" /> {duration(health.uptimeMs)}
            </>
          ) : (
            '—'
          )}
        </dd>
      </dl>
    </section>
  );
}

function verb(action: string): string {
  return action === 'create' ? 'Create' : action === 'delete' ? 'Delete' : 'Write to';
}
