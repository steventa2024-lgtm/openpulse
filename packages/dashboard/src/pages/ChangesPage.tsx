import type { JSX } from 'react';
import { useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import '../editor/monaco.js';
import { languageFor } from '../editor/monaco.js';
import { Card, Empty, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { DiffStats, UnifiedDiff } from '../components/DiffView.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { useProject } from '../project/provider.js';
import { relativeTime } from '../format.js';
import { NoProject } from './NoProject.js';

interface ChangeFileView {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content?: string;
  current?: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  note?: string;
  additions: number;
  deletions: number;
  diff: string;
  stale: boolean;
}

interface ChangeSetView {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  status: 'pending' | 'applied' | 'partial' | 'rejected';
  origin: { kind: string; sessionKey?: string; agentRole?: string };
  files: ChangeFileView[];
  stats: { files: number; additions: number; deletions: number };
}

interface ChangeSetSummary {
  id: string;
  title: string;
  createdAt: number;
  status: ChangeSetView['status'];
  origin: { kind: string };
  files: { path: string; status: string; additions: number; deletions: number }[];
}

export function ChangesPage(): JSX.Element {
  const { active } = useProject();
  if (!active) return <NoProject title="Changes" />;
  return <ChangesForProject key={active.id} />;
}

function ChangesForProject(): JSX.Element {
  const list = useQuery<{ changes: ChangeSetSummary[] }>('changes.list');
  const [selected, setSelected] = useState<string>();
  useGatewayEvent('changes.changed', () => list.reload());

  const changes = list.data?.changes ?? [];
  const pending = changes.filter((c) => c.status === 'pending' || c.status === 'partial');

  // Until the operator picks one, show the newest change set still waiting for a decision.
  const current = selected ?? pending[0]?.id;

  return (
    <>
      <PageHead
        title="Changes"
        subtitle="Edits proposed by agents. Nothing here is on disk until you approve and apply it."
        actions={
          <button className="btn" onClick={() => list.reload()}>
            Refresh
          </button>
        }
      />

      <Card title="Proposed change sets">
        <Rows
          items={changes}
          keyOf={(c) => c.id}
          empty="No proposed changes. Ask an agent for a reviewable change, run a workflow, or use an AI action in the editor."
          onRowClick={(c) => setSelected(c.id)}
          columns={[
            { header: '', width: '6rem', render: (c) => <StatusPill status={c.status} /> },
            {
              header: 'Change',
              render: (c) => (
                <>
                  <div style={{ fontWeight: c.id === current ? 600 : 400 }}>{c.title}</div>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {c.origin.kind} · {c.files.length} file{c.files.length === 1 ? '' : 's'} ·{' '}
                    {relativeTime(c.createdAt)}
                  </span>
                </>
              ),
            },
            {
              header: 'Size',
              render: (c) => (
                <DiffStats
                  additions={c.files.reduce((n, f) => n + f.additions, 0)}
                  deletions={c.files.reduce((n, f) => n + f.deletions, 0)}
                />
              ),
            },
          ]}
        />
      </Card>

      {current && <ChangeReview key={current} id={current} onChanged={() => list.reload()} />}
    </>
  );
}

function ChangeReview({ id, onChanged }: { id: string; onChanged: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const view = useQuery<ChangeSetView>('changes.get', { id }, [id]);
  const [fileIndex, setFileIndex] = useState(0);
  const [mode, setMode] = useState<'side' | 'inline' | 'text'>('side');
  const [checkpoint, setCheckpoint] = useState(true);
  const [busy, setBusy] = useState(false);

  useGatewayEvent(['changes.changed', 'workspace.changed'], () => view.reload());

  const set = view.data;
  if (!set)
    return <Card>{view.error ? <Empty>{view.error}</Empty> : <Empty>Loading…</Empty>}</Card>;
  const file = set.files[Math.min(fileIndex, set.files.length - 1)];
  const outstanding = set.files.filter(
    (f) => f.status === 'pending' || f.status === 'approved' || f.status === 'failed',
  );
  const approved = set.files.filter((f) => f.status === 'approved');
  const staleApproved = approved.filter((f) => f.stale);

  const decide = (decision: 'approved' | 'rejected', paths?: string[]) =>
    act(async () => {
      await request('changes.decide', { id, decision, ...(paths && { paths }) });
      view.reload();
      onChanged();
    });

  const apply = async () => {
    setBusy(true);
    await act(
      async () => {
        if (checkpoint) {
          await request('checkpoints.create', {
            name: `Before applying "${set.title}"`,
            reason: 'pre-apply',
          });
        }
        const result = await request<{
          applied: string[];
          skipped: { path: string; reason: string }[];
        }>('changes.apply', { id });
        view.reload();
        onChanged();
        if (result.skipped.length) {
          throw new Error(
            `Applied ${result.applied.length}; skipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}`,
          );
        }
      },
      `Applied ${approved.length} file${approved.length === 1 ? '' : 's'}`,
    );
    setBusy(false);
  };

  return (
    <>
      <Card
        title={set.title}
        actions={
          <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <DiffStats additions={set.stats.additions} deletions={set.stats.deletions} />
            <StatusPill status={set.status} />
          </span>
        }
      >
        {set.description && (
          <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{set.description}</p>
        )}
        <p className="faint" style={{ marginTop: 0 }}>
          Proposed by {set.origin.kind}
          {set.origin.sessionKey ? ` in ${set.origin.sessionKey}` : ''} ·{' '}
          {relativeTime(set.createdAt)}
        </p>

        {outstanding.length > 0 && (
          <div className="toolbar">
            <button className="btn" onClick={() => void decide('approved')}>
              Approve all
            </button>
            <button className="btn danger" onClick={() => void decide('rejected')}>
              Reject all
            </button>
            <span className="spacer" />
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={checkpoint}
                onChange={(e) => setCheckpoint(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Checkpoint first
            </label>
            <button
              className="btn primary"
              disabled={approved.length === 0 || busy}
              onClick={() => void apply()}
            >
              {busy ? 'Applying…' : `Apply ${approved.length} approved`}
            </button>
          </div>
        )}
        {staleApproved.length > 0 && (
          <p style={{ color: 'var(--warn)', fontSize: 13 }}>
            {staleApproved.length} approved file{staleApproved.length === 1 ? ' has' : 's have'}{' '}
            changed on disk since the proposal. They will be skipped, not overwritten.
          </p>
        )}
      </Card>

      <div className="changes-layout">
        <div className="changes-files">
          {set.files.map((f, index) => (
            <button
              key={f.path}
              className="changes-file"
              aria-current={index === fileIndex}
              onClick={() => setFileIndex(index)}
            >
              <span className="mono" style={{ fontSize: 12 }}>
                {f.path}
              </span>
              <span style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <span className="faint" style={{ fontSize: 11 }}>
                  {f.action}
                </span>
                <DiffStats additions={f.additions} deletions={f.deletions} />
                <StatusPill status={f.stale && f.status !== 'applied' ? 'stale' : f.status} />
              </span>
            </button>
          ))}
        </div>

        {file && (
          <div className="changes-diff">
            <div className="toolbar" style={{ marginBottom: '0.5rem' }}>
              <strong className="mono" style={{ fontSize: 12 }}>
                {file.path}
              </strong>
              <span className="spacer" />
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                style={{ width: 'auto' }}
              >
                <option value="side">Side by side</option>
                <option value="inline">Inline</option>
                <option value="text">Unified text</option>
              </select>
              {(file.status === 'pending' ||
                file.status === 'rejected' ||
                file.status === 'failed') && (
                <button className="btn" onClick={() => void decide('approved', [file.path])}>
                  Approve file
                </button>
              )}
              {(file.status === 'pending' || file.status === 'approved') && (
                <button className="btn danger" onClick={() => void decide('rejected', [file.path])}>
                  Reject file
                </button>
              )}
            </div>
            {file.note && (
              <p style={{ color: 'var(--warn)', fontSize: 13, marginTop: 0 }}>{file.note}</p>
            )}
            {mode === 'text' ? (
              <UnifiedDiff diff={file.diff} />
            ) : (
              <div className="diff-host">
                <DiffEditor
                  original={file.current ?? ''}
                  modified={file.action === 'delete' ? '' : (file.content ?? '')}
                  language={languageFor(file.path)}
                  // The wrapper disposes the models before the diff widget lets go of them, which
                  // throws on unmount. Keep them, and dispose them once the editor itself is gone.
                  keepCurrentOriginalModel
                  keepCurrentModifiedModel
                  onMount={(editor) => {
                    const models = editor.getModel();
                    editor.onDidDispose(() => {
                      models?.original.dispose();
                      models?.modified.dispose();
                    });
                  }}
                  theme={
                    document.documentElement.dataset.theme === 'light' ? 'vs' : 'openpulse-dark'
                  }
                  options={{
                    renderSideBySide: mode === 'side',
                    readOnly: true,
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    minimap: { enabled: false },
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const tone =
    status === 'applied' || status === 'approved'
      ? 'ok'
      : status === 'rejected' || status === 'failed' || status === 'stale'
        ? 'err'
        : status === 'partial'
          ? 'warn'
          : 'idle';
  return <Pill tone={tone}>{status}</Pill>;
}
