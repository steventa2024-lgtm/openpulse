import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Empty, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { useProject } from '../project/provider.js';
import { bytes, dateTime, relativeTime } from '../format.js';
import { NoProject } from './NoProject.js';

interface Checkpoint {
  id: string;
  name: string;
  createdAt: number;
  kind: 'git' | 'copy';
  ref: string;
  branch?: string;
  head?: string;
  reason: string;
  fileCount: number;
  bytes: number;
}

interface RestorePreview {
  checkpoint: Checkpoint;
  entries: { path: string; action: 'restore' | 'delete' | 'unchanged'; reason?: string }[];
  removals: number;
  changes: number;
}

export function CheckpointsPage(): JSX.Element {
  const { active } = useProject();
  if (!active) return <NoProject title="Checkpoints" />;
  return <CheckpointsForProject key={active.id} name={active.name} />;
}

function CheckpointsForProject({ name }: { name: string }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const list = useQuery<{ checkpoints: Checkpoint[] }>('checkpoints.list');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RestorePreview>();
  const [confirmText, setConfirmText] = useState('');

  useGatewayEvent('checkpoints.changed', () => list.reload());

  const create = async () => {
    setBusy(true);
    await act(async () => {
      await request(
        'checkpoints.create',
        { name: label.trim() || `Manual checkpoint ${new Date().toLocaleString()}` },
        300_000,
      );
      setLabel('');
      list.reload();
    }, 'Checkpoint saved');
    setBusy(false);
  };

  const showPreview = (checkpoint: Checkpoint) =>
    act(async () => {
      setConfirmText('');
      setPreview(
        await request<RestorePreview>('checkpoints.preview', { id: checkpoint.id }, 120_000),
      );
    });

  const restore = async () => {
    if (!preview) return;
    setBusy(true);
    await act(async () => {
      await request('checkpoints.restore', { id: preview.checkpoint.id, confirm: true }, 300_000);
      setPreview(undefined);
      list.reload();
    }, `Restored "${preview.checkpoint.name}". The previous state was saved as a checkpoint first.`);
    setBusy(false);
  };

  return (
    <>
      <PageHead
        title="Checkpoints"
        subtitle={`Snapshots of ${name}, including uncommitted and untracked work`}
        actions={
          <button className="btn" onClick={() => list.reload()}>
            Refresh
          </button>
        }
      />

      <Card title="Save a checkpoint">
        <p className="muted" style={{ marginTop: 0 }}>
          In a git repository this writes the whole working tree into git's object store without
          touching your branch, index or stash. Other folders are copied. Applying a change set can
          take one automatically.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Field label="Name">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Before the auth refactor"
            />
          </Field>
          <button
            className="btn primary"
            style={{ alignSelf: 'flex-end', marginBottom: '0.75rem' }}
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Saving…' : 'Save checkpoint'}
          </button>
        </div>
      </Card>

      <Card title="History">
        <Rows
          items={list.data?.checkpoints ?? []}
          keyOf={(c) => c.id}
          empty="No checkpoints yet."
          columns={[
            {
              header: '',
              width: '5rem',
              render: (c) => <Pill tone={c.kind === 'git' ? 'ok' : 'idle'}>{c.kind}</Pill>,
            },
            {
              header: 'Checkpoint',
              render: (c) => (
                <>
                  <div>{c.name}</div>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {c.reason}
                    {c.branch ? ` · ${c.branch}` : ''}
                    {c.head ? ` @ ${c.head.slice(0, 8)}` : ''}
                  </span>
                </>
              ),
            },
            {
              header: 'Contents',
              render: (c) =>
                `${c.fileCount} files${c.kind === 'copy' ? ` · ${bytes(c.bytes)}` : ''}`,
            },
            {
              header: 'Saved',
              render: (c) => <span title={dateTime(c.createdAt)}>{relativeTime(c.createdAt)}</span>,
            },
            {
              header: '',
              render: (c) => (
                <span style={{ display: 'flex', gap: '0.4rem' }}>
                  <button className="btn" onClick={() => void showPreview(c)}>
                    Restore…
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      if (!window.confirm(`Delete the checkpoint "${c.name}"?`)) return;
                      void act(async () => {
                        await request('checkpoints.remove', { id: c.id });
                        list.reload();
                      }, 'Checkpoint deleted');
                    }}
                  >
                    Delete
                  </button>
                </span>
              ),
            },
          ]}
        />
      </Card>

      {preview && (
        <Card
          title={`Restore "${preview.checkpoint.name}"?`}
          actions={
            <button className="btn ghost" onClick={() => setPreview(undefined)}>
              Cancel
            </button>
          }
        >
          {preview.entries.length === 0 ? (
            <Empty>The project already matches this checkpoint. There is nothing to restore.</Empty>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                Restoring changes <strong>{preview.changes}</strong> file
                {preview.changes === 1 ? '' : 's'} back to how they were and removes{' '}
                <strong>{preview.removals}</strong> file{preview.removals === 1 ? '' : 's'} created
                since. The current state is saved as a new checkpoint first, so this can be undone.
              </p>
              <Rows
                items={preview.entries}
                keyOf={(e) => e.path}
                empty=""
                columns={[
                  {
                    header: '',
                    width: '6rem',
                    render: (e) => (
                      <Pill tone={e.action === 'delete' ? 'err' : 'warn'}>
                        {e.action === 'delete' ? 'remove' : 'restore'}
                      </Pill>
                    ),
                  },
                  {
                    header: 'File',
                    render: (e) => (
                      <span className="mono" style={{ fontSize: 12 }}>
                        {e.path}
                      </span>
                    ),
                  },
                  { header: 'Why', render: (e) => <span className="faint">{e.reason}</span> },
                ]}
              />
              <div className="toolbar" style={{ marginTop: '0.75rem' }}>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder='Type "restore" to confirm'
                  style={{ maxWidth: '16rem' }}
                />
                <button
                  className="btn danger"
                  disabled={confirmText.trim().toLowerCase() !== 'restore' || busy}
                  onClick={() => void restore()}
                >
                  {busy ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}
