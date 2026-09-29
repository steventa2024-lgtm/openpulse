import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Empty, Field, Pill, useAction } from '../components/ui.js';
import { useGateway, useQuery } from '../gateway/provider.js';
import { relativeTime } from '../format.js';

interface SkillInspect {
  skill: {
    name: string;
    description: string;
    source: string;
    baseDir: string;
    filePath: string;
    homepage?: string;
    requires: Record<string, unknown>;
    instructions: string;
  };
  scripts: string[];
  warnings: string[];
  origin?: {
    origin?:
      | { kind: 'git'; url: string; commit?: string }
      | { kind: 'local'; path: string }
      | { kind: 'template' };
    installedAt?: number;
  };
}

interface Validation {
  valid: boolean;
  name?: string;
  errors: string[];
  warnings: string[];
  executables: string[];
  files: number;
}

/** Instructions, requirements, shipped scripts and origin for one skill, with remove/update. */
export function SkillDetail({
  name,
  onChanged,
}: {
  name: string;
  onChanged: () => void;
}): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const detail = useQuery<SkillInspect>('skills.inspect', { name }, [name]);
  const data = detail.data;
  if (!data)
    return (
      <Card>
        <Empty>{detail.error ?? 'Loading…'}</Empty>
      </Card>
    );

  const origin = data.origin?.origin;
  const removable = data.skill.source === 'managed' || data.skill.source === 'workspace';

  return (
    <Card
      title={`${data.skill.name} — instructions`}
      actions={
        <span style={{ display: 'flex', gap: '0.4rem' }}>
          {origin && origin.kind !== 'template' && (
            <button
              className="btn"
              onClick={() =>
                void act(async () => {
                  await request('skills.upgrade', { name }, 300_000);
                  detail.reload();
                  onChanged();
                }, 'Skill updated')
              }
            >
              Update
            </button>
          )}
          {removable && (
            <button
              className="btn danger"
              onClick={() => {
                if (!window.confirm(`Remove the skill "${name}" from disk?`)) return;
                void act(async () => {
                  await request('skills.remove', { name });
                  onChanged();
                }, 'Skill removed');
              }}
            >
              Remove
            </button>
          )}
        </span>
      }
    >
      <dl className="kv">
        <dt>Source</dt>
        <dd>
          <Pill
            tone={
              data.skill.source === 'bundled'
                ? 'idle'
                : data.skill.source === 'workspace'
                  ? 'ok'
                  : 'warn'
            }
          >
            {data.skill.source}
          </Pill>
        </dd>
        <dt>Installed from</dt>
        <dd className="mono" style={{ fontSize: 12 }}>
          {origin?.kind === 'git'
            ? `${origin.url}${origin.commit ? ` @ ${origin.commit.slice(0, 10)}` : ''}`
            : origin?.kind === 'local'
              ? origin.path
              : origin?.kind === 'template'
                ? 'created from the starter template'
                : data.skill.source === 'bundled'
                  ? 'shipped with OpenPulse'
                  : 'unknown'}
          {data.origin?.installedAt ? ` · ${relativeTime(data.origin.installedAt)}` : ''}
        </dd>
        <dt>Requires</dt>
        <dd className="mono" style={{ fontSize: 12 }}>
          {Object.keys(data.skill.requires).length
            ? JSON.stringify(data.skill.requires)
            : 'nothing'}
        </dd>
        <dt>Scripts it ships</dt>
        <dd>
          {data.scripts.length ? (
            <span className="mono" style={{ fontSize: 12 }}>
              {data.scripts.join(', ')}
            </span>
          ) : (
            'none'
          )}
        </dd>
      </dl>
      {data.warnings.map((warning) => (
        <p key={warning} style={{ color: 'var(--warn)', fontSize: 12 }}>
          {warning}
        </p>
      ))}
      <pre
        className="log-view"
        style={{ height: 'auto', maxHeight: '24rem', whiteSpace: 'pre-wrap' }}
      >
        {data.skill.instructions}
      </pre>
    </Card>
  );
}

/** Install from a folder or a git repository — validated first, and nothing is executed. */
export function SkillInstall({ onInstalled }: { onInstalled: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [from, setFrom] = useState<'git' | 'local'>('git');
  const [source, setSource] = useState('');
  const [subdir, setSubdir] = useState('');
  const [validation, setValidation] = useState<Validation>();
  const [busy, setBusy] = useState(false);

  const install = async () => {
    setBusy(true);
    await act(async () => {
      const result = await request<{ installed: { name: string }; validation: Validation }>(
        'skills.install',
        from === 'git'
          ? { from, url: source.trim(), ...(subdir.trim() && { subdir: subdir.trim() }) }
          : { from, path: source.trim() },
        300_000,
      );
      setValidation(result.validation);
      setSource('');
      setSubdir('');
      onInstalled();
    }, 'Skill installed');
    setBusy(false);
  };

  const validate = () =>
    act(async () => {
      setValidation(await request<Validation>('skills.validate', { path: source.trim() }));
    });

  return (
    <Card title="Install a skill">
      <p className="muted" style={{ marginTop: 0 }}>
        Installing copies the skill's folder into <span className="mono">~/.openpulse/skills</span>.
        Scripts inside it are listed, never run — the agent only uses a skill when it reads the
        instructions, under the usual approval rules.
      </p>
      <div className="grid">
        <Field label="From">
          <select value={from} onChange={(e) => setFrom(e.target.value as 'git' | 'local')}>
            <option value="git">A git repository</option>
            <option value="local">A folder on this machine</option>
          </select>
        </Field>
        <Field label={from === 'git' ? 'Repository URL' : 'Folder'}>
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={
              from === 'git' ? 'https://github.com/owner/skill-repo.git' : 'C:\\skills\\my-skill'
            }
          />
        </Field>
        {from === 'git' && (
          <Field label="Subfolder (if the repository holds several)">
            <input
              type="text"
              value={subdir}
              onChange={(e) => setSubdir(e.target.value)}
              placeholder="skills/pr-summary"
            />
          </Field>
        )}
      </div>
      <div className="toolbar">
        {from === 'local' && (
          <button className="btn" disabled={!source.trim()} onClick={() => void validate()}>
            Check it first
          </button>
        )}
        <button
          className="btn primary"
          disabled={!source.trim() || busy}
          onClick={() => void install()}
        >
          {busy ? 'Installing…' : 'Install'}
        </button>
      </div>
      {validation && (
        <div style={{ fontSize: 13 }}>
          <Pill tone={validation.valid ? 'ok' : 'err'}>
            {validation.valid ? `valid · ${validation.name}` : 'not valid'}
          </Pill>
          {validation.errors.map((error) => (
            <p key={error} style={{ color: 'var(--err)' }}>
              {error}
            </p>
          ))}
          {validation.warnings.map((warning) => (
            <p key={warning} style={{ color: 'var(--warn)' }}>
              {warning}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Scaffold a new skill from the starter template. */
export function SkillCreate({ onCreated }: { onCreated: (name: string) => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [where, setWhere] = useState<'workspace' | 'managed'>('workspace');

  return (
    <Card title="Create a skill">
      <p className="muted" style={{ marginTop: 0 }}>
        Makes a folder with a SKILL.md you can edit — in the workspace (versioned with your agent's
        files) or in the managed skills folder.
      </p>
      <div className="grid">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="release-notes"
          />
        </Field>
        <Field label="Where">
          <select
            value={where}
            onChange={(e) => setWhere(e.target.value as 'workspace' | 'managed')}
          >
            <option value="workspace">Workspace skills</option>
            <option value="managed">Managed skills</option>
          </select>
        </Field>
      </div>
      <Field label="When should the agent use it?">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Draft release notes from the commits since the last tag."
        />
      </Field>
      <button
        className="btn primary"
        disabled={!name.trim() || !description.trim()}
        onClick={() =>
          void act(async () => {
            await request('skills.create', {
              name: name.trim(),
              description: description.trim(),
              where,
            });
            onCreated(name.trim());
            setName('');
            setDescription('');
          }, 'Skill created')
        }
      >
        Create
      </button>
    </Card>
  );
}
