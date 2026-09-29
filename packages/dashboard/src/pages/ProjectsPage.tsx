import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Empty, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway } from '../gateway/provider.js';
import { useProject, type Project } from '../project/provider.js';
import { relativeTime } from '../format.js';

export function ProjectsPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const { projects, active, select, refresh, loading, error } = useProject();

  return (
    <>
      <PageHead
        title="Projects"
        subtitle="Folders on this machine the agent may work in. Registering one is what lets the agent read and change it."
        actions={
          <button className="btn" onClick={refresh}>
            Refresh
          </button>
        }
      />

      {error && <Card title="Could not load projects">{error}</Card>}

      <Card title="Your projects">
        {loading ? (
          <Empty>Loading…</Empty>
        ) : (
          <Rows
            items={projects}
            keyOf={(p) => p.id}
            empty="No projects yet. Open an existing folder or clone a repository below."
            columns={[
              {
                header: '',
                width: '6rem',
                render: (p: Project) =>
                  p.id === active?.id ? <Pill tone="ok">active</Pill> : <Pill tone="idle">—</Pill>,
              },
              {
                header: 'Project',
                render: (p) => (
                  <>
                    <div>{p.name}</div>
                    <span className="mono faint" style={{ fontSize: 11 }}>
                      {p.path}
                    </span>
                  </>
                ),
              },
              {
                header: 'Git',
                render: (p) =>
                  p.vcs === 'git' ? (
                    <span className="faint" title={p.remote}>
                      {p.remote ? shortRemote(p.remote) : 'local repository'}
                    </span>
                  ) : (
                    <span className="faint">not a repository</span>
                  ),
              },
              { header: 'Opened', render: (p) => relativeTime(p.lastOpenedAt ?? p.createdAt) },
              {
                header: '',
                render: (p) => (
                  <span style={{ display: 'flex', gap: '0.4rem' }}>
                    {p.id !== active?.id && (
                      <button
                        className="btn primary"
                        onClick={() => void act(() => select(p.id), `${p.name} is now active`)}
                      >
                        Make active
                      </button>
                    )}
                    <button
                      className="btn danger"
                      onClick={() => {
                        if (!window.confirm(`Stop tracking ${p.name}? Its files are not touched.`))
                          return;
                        void act(async () => {
                          await request('projects.remove', { id: p.id });
                          refresh();
                        }, 'Project removed from OpenPulse');
                      }}
                    >
                      Remove
                    </button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <OpenFolder onAdded={refresh} />
      <CloneRepository onAdded={refresh} />
    </>
  );
}

function OpenFolder({ onAdded }: { onAdded: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Card title="Open an existing folder">
      <p className="muted" style={{ marginTop: 0 }}>
        Paste the folder path. Git is detected automatically.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void act(async () => {
            await request('projects.add', {
              path: path.trim(),
              ...(name.trim() && { name: name.trim() }),
            });
            setPath('');
            setName('');
            onAdded();
          }, 'Project added').finally(() => setBusy(false));
        }}
      >
        <div className="grid">
          <Field label="Folder">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\code\my-app"
              required
            />
          </Field>
          <Field label="Name (optional)">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app"
            />
          </Field>
        </div>
        <button className="btn primary" type="submit" disabled={busy || !path.trim()}>
          {busy ? 'Adding…' : 'Add project'}
        </button>
      </form>
    </Card>
  );
}

function CloneRepository({ onAdded }: { onAdded: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [url, setUrl] = useState('');
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false);

  const suggested = url
    ? (url
        .replace(/\.git$/, '')
        .split(/[/:]/)
        .pop() ?? '')
    : '';

  return (
    <Card title="Clone a repository">
      <p className="muted" style={{ marginTop: 0 }}>
        Public repositories need no sign-in. The destination must be inside a folder the agent is
        already allowed to write to — for example, next to an existing project.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void act(async () => {
            await request('git.clone', { url: url.trim(), directory: directory.trim() }, 900_000);
            setUrl('');
            setDirectory('');
            onAdded();
          }, 'Repository cloned and added').finally(() => setBusy(false));
        }}
      >
        <div className="grid">
          <Field label="Repository URL">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              required
            />
          </Field>
          <Field label="Clone into">
            <input
              type="text"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder={suggested ? `…\\${suggested}` : 'C:\\code\\repo'}
              required
            />
          </Field>
        </div>
        <button
          className="btn primary"
          type="submit"
          disabled={busy || !url.trim() || !directory.trim()}
        >
          {busy ? 'Cloning… this can take a while' : 'Clone'}
        </button>
      </form>
    </Card>
  );
}

function shortRemote(remote: string): string {
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote);
  return match?.[1] ?? remote;
}
