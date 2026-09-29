import type { JSX } from 'react';
import { useState } from 'react';
import { Card, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useQuery } from '../gateway/provider.js';
import type { SkillStatus } from '../types.js';
import { SkillCreate, SkillDetail, SkillInstall } from './SkillsRegistry.js';

export function SkillsPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const skills = useQuery<{ skills: SkillStatus[]; workspaceDir: string; managedDir: string }>(
    'skills.status',
  );
  const [open, setOpen] = useState<string>();

  const rows = skills.data?.skills ?? [];
  const selected = rows.find((s) => s.name === open);

  return (
    <>
      <PageHead
        title="Skills"
        subtitle="Folders of instructions the agent can load on demand. Drop a SKILL.md in the workspace to add one."
        actions={
          <button className="btn" onClick={() => skills.reload()}>
            Refresh
          </button>
        }
      />

      <Card>
        <Rows
          items={rows}
          keyOf={(skill) => skill.name}
          empty="No skills found."
          onRowClick={(skill) => setOpen(skill.name === open ? undefined : skill.name)}
          columns={[
            {
              header: '',
              width: '7rem',
              render: (skill) =>
                skill.disabled ? (
                  <Pill tone="idle">disabled</Pill>
                ) : skill.error ? (
                  <Pill tone="err">broken</Pill>
                ) : skill.eligible ? (
                  <Pill tone="ok">ready</Pill>
                ) : (
                  <Pill tone="warn">needs setup</Pill>
                ),
            },
            {
              header: 'Skill',
              render: (skill) => (
                <>
                  <div>
                    {skill.emoji ? `${skill.emoji} ` : ''}
                    {skill.name}
                  </div>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {skill.description}
                  </span>
                </>
              ),
            },
            { header: 'Source', render: (skill) => skill.source },
            {
              header: 'Requirements',
              render: (skill) => <span className="faint">{missingSummary(skill)}</span>,
            },
            {
              header: '',
              render: (skill) => (
                <span onClick={(event) => event.stopPropagation()}>
                  <button
                    className="btn"
                    onClick={() =>
                      void act(async () => {
                        await request('skills.update', {
                          name: skill.name,
                          enabled: skill.disabled,
                        });
                        skills.reload();
                      })
                    }
                  >
                    {skill.disabled ? 'Enable' : 'Disable'}
                  </button>
                </span>
              ),
            },
          ]}
        />
      </Card>

      {selected && (
        <Card title={selected.name}>
          <dl className="kv">
            <dt>Description</dt>
            <dd>{selected.description}</dd>
            <dt>File</dt>
            <dd className="mono">{selected.filePath}</dd>
            <dt>Source</dt>
            <dd>{selected.source}</dd>
            <dt>User invocable</dt>
            <dd>{selected.userInvocable ? 'yes' : 'no'}</dd>
            <dt>API key</dt>
            <dd>
              {selected.primaryEnv
                ? selected.hasApiKey
                  ? 'configured'
                  : `missing (${selected.primaryEnv})`
                : '—'}
            </dd>
            {selected.homepage && (
              <>
                <dt>Homepage</dt>
                <dd>
                  <a href={selected.homepage} target="_blank" rel="noreferrer">
                    {selected.homepage}
                  </a>
                </dd>
              </>
            )}
            {selected.error && (
              <>
                <dt>Error</dt>
                <dd style={{ color: 'var(--err)' }}>{selected.error}</dd>
              </>
            )}
          </dl>
          {selected.primaryEnv && !selected.hasApiKey && (
            <ApiKeyForm
              name={selected.name}
              env={selected.primaryEnv}
              onSaved={() => skills.reload()}
            />
          )}
        </Card>
      )}

      {selected && <SkillDetail name={selected.name} onChanged={() => skills.reload()} />}

      <SkillInstall onInstalled={() => skills.reload()} />
      <SkillCreate
        onCreated={(name) => {
          skills.reload();
          setOpen(name);
        }}
      />

      {skills.data && (
        <Card title="Where skills come from">
          <dl className="kv">
            <dt>Workspace</dt>
            <dd className="mono">{skills.data.workspaceDir}</dd>
            <dt>Managed</dt>
            <dd className="mono">{skills.data.managedDir}</dd>
          </dl>
          <p className="faint" style={{ marginBottom: 0 }}>
            A workspace skill wins over a managed one, which wins over a bundled one of the same
            name.
          </p>
        </Card>
      )}
    </>
  );
}

function ApiKeyForm({
  name,
  env,
  onSaved,
}: {
  name: string;
  env: string;
  onSaved: () => void;
}): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [value, setValue] = useState('');
  return (
    <form
      style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          await request('skills.update', { name, apiKey: value.trim() });
          setValue('');
          onSaved();
        }, 'Key saved');
      }}
    >
      <input
        type="password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={`${env} for this skill`}
      />
      <button className="btn primary" type="submit">
        Save
      </button>
    </form>
  );
}

function missingSummary(skill: SkillStatus): string {
  const parts: string[] = [];
  if (skill.missing.bins.length) parts.push(`needs ${skill.missing.bins.join(', ')}`);
  if (skill.missing.anyBins.length) parts.push(`needs one of ${skill.missing.anyBins.join('/')}`);
  if (skill.missing.env.length) parts.push(`set ${skill.missing.env.join(', ')}`);
  if (skill.missing.config.length) parts.push(`configure ${skill.missing.config.join(', ')}`);
  if (skill.missing.os.length) parts.push(`${skill.missing.os.join('/')} only`);
  return parts.join('; ') || 'all met';
}
