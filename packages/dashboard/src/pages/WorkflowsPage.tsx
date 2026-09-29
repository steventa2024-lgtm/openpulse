import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Empty, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import { duration, relativeTime } from '../format.js';

interface Role {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model?: string;
  permission: 'read' | 'propose' | 'execute';
  denyTools: string[];
  builtin: boolean;
}

interface WorkflowStep {
  id: string;
  role: string;
  task: string;
  dependsOn: string[];
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  maxParallel: number;
  builtin: boolean;
}

interface StepExecution {
  id: string;
  role: string;
  roleName: string;
  task: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
  sessionKey: string;
  model?: string;
  output?: string;
  error?: string;
  toolCalls?: number;
  startedAt?: number;
  endedAt?: number;
}

interface Execution {
  id: string;
  workflowId: string;
  workflowName: string;
  request: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  endedAt?: number;
  steps: StepExecution[];
  changeSetIds: string[];
  error?: string;
}

const PERMISSION_LABELS: Record<Role['permission'], string> = {
  read: 'Read only',
  propose: 'Read + propose changes',
  execute: 'Read + run commands',
};

export function WorkflowsPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const definitions = useQuery<{ roles: Role[]; workflows: Workflow[] }>('workflows.list');
  const executions = useQuery<{ executions: Execution[] }>('workflows.executions', { limit: 20 });
  const [workflowId, setWorkflowId] = useState('plan-code-test-review');
  const [task, setTask] = useState('');
  const [open, setOpen] = useState<string>();

  useGatewayEvent('workflows.changed', () => executions.reload());

  const roles = definitions.data?.roles ?? [];
  const workflows = definitions.data?.workflows ?? [];
  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const runs = executions.data?.executions ?? [];
  const current = runs.find((r) => r.id === open) ?? runs[0];

  return (
    <>
      <PageHead
        title="Workflows"
        subtitle="Several agents on one request: each step is a real agent turn with its own role, model and tools."
      />

      <Card title="Start a workflow">
        <div className="grid">
          <Field label="Workflow">
            <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {selectedWorkflow && (
          <p className="muted" style={{ marginTop: 0 }}>
            {selectedWorkflow.description}{' '}
            <span className="faint">
              Steps:{' '}
              {selectedWorkflow.steps
                .map(
                  (s) =>
                    `${roleName(roles, s.role)}${s.dependsOn.length ? ` (after ${s.dependsOn.join(', ')})` : ''}`,
                )
                .join(' → ')}
            </span>
          </p>
        )}
        <Field label="Request">
          <textarea
            rows={3}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Find the authentication code, improve its error handling, and add tests."
          />
        </Field>
        <p className="faint" style={{ fontSize: 12 }}>
          Coding steps propose changes instead of writing files; review them under Changes when the
          run finishes.
        </p>
        <button
          className="btn primary"
          disabled={!task.trim()}
          onClick={() =>
            void act(async () => {
              const { execution } = await request<{ execution: Execution }>('workflows.start', {
                workflowId,
                request: task.trim(),
              });
              setOpen(execution.id);
              setTask('');
              executions.reload();
            }, 'Workflow started')
          }
        >
          Start
        </button>
      </Card>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(16rem, 22rem) 1fr' }}>
        <Card title="Runs">
          <Rows
            items={runs}
            keyOf={(r) => r.id}
            empty="No workflow runs yet."
            onRowClick={(r) => setOpen(r.id)}
            columns={[
              { header: '', width: '5rem', render: (r) => <RunPill status={r.status} /> },
              {
                header: 'Run',
                render: (r) => (
                  <>
                    <div style={{ fontWeight: r.id === current?.id ? 600 : 400 }}>
                      {r.workflowName}
                    </div>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {r.request.slice(0, 60)} · {relativeTime(r.createdAt)}
                    </span>
                  </>
                ),
              },
            ]}
          />
        </Card>

        {current ? (
          <Card
            title={current.workflowName}
            actions={
              <span style={{ display: 'flex', gap: '0.4rem' }}>
                <RunPill status={current.status} />
                {current.status === 'running' && (
                  <button
                    className="btn danger"
                    onClick={() =>
                      void act(async () => {
                        await request('workflows.cancel', { id: current.id });
                        executions.reload();
                      }, 'Workflow stopped')
                    }
                  >
                    Stop
                  </button>
                )}
              </span>
            }
          >
            <p style={{ marginTop: 0 }}>{current.request}</p>
            {current.error && <p style={{ color: 'var(--err)' }}>{current.error}</p>}
            {current.changeSetIds.length > 0 && (
              <p>
                <Pill tone="warn">
                  {current.changeSetIds.length} change set
                  {current.changeSetIds.length === 1 ? '' : 's'} to review
                </Pill>{' '}
                <button
                  className="link"
                  onClick={() => {
                    window.location.hash = '#/changes';
                  }}
                >
                  Open Changes
                </button>
              </p>
            )}
            <div className="steps">
              {current.steps.map((step) => (
                <details
                  key={step.id}
                  className="step"
                  open={step.status === 'running' || step.status === 'failed'}
                >
                  <summary>
                    <StepPill status={step.status} />
                    <strong>{step.roleName}</strong>
                    <span className="faint mono" style={{ fontSize: 11 }}>
                      {step.id}
                    </span>
                    <span className="spacer" />
                    <span className="faint" style={{ fontSize: 11 }}>
                      {step.model ?? ''}
                      {step.toolCalls !== undefined ? ` · ${step.toolCalls} tool calls` : ''}
                      {step.startedAt && step.endedAt
                        ? ` · ${duration(step.endedAt - step.startedAt)}`
                        : ''}
                    </span>
                  </summary>
                  <div className="step-body">
                    <div className="faint" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                      {step.task}
                    </div>
                    {step.error && <p style={{ color: 'var(--err)' }}>{step.error}</p>}
                    {step.output ? (
                      <div
                        className="bubble"
                        style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}
                      >
                        {step.output}
                      </div>
                    ) : step.status === 'running' ? (
                      <div className="thinking">working…</div>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          </Card>
        ) : (
          <Card>
            <Empty>Start a workflow to see its steps here.</Empty>
          </Card>
        )}
      </div>

      <Card title="Roles">
        <Rows
          items={roles}
          keyOf={(r) => r.id}
          empty=""
          columns={[
            {
              header: 'Role',
              render: (r) => (
                <>
                  <div>{r.name}</div>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {r.description}
                  </span>
                </>
              ),
            },
            { header: 'Can', render: (r) => PERMISSION_LABELS[r.permission] },
            {
              header: 'Model',
              render: (r) => <span className="mono faint">{r.model ?? 'default'}</span>,
            },
            {
              header: '',
              render: (r) =>
                r.builtin ? (
                  <span className="faint">built in</span>
                ) : (
                  <button
                    className="btn danger"
                    onClick={() =>
                      void act(async () => {
                        await request('workflows.role.remove', { id: r.id });
                        definitions.reload();
                      }, 'Role removed')
                    }
                  >
                    Remove
                  </button>
                ),
            },
          ]}
        />
      </Card>

      <NewRole onSaved={() => definitions.reload()} />
      <NewWorkflow roles={roles} onSaved={() => definitions.reload()} />
    </>
  );
}

function NewRole({ onSaved }: { onSaved: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [form, setForm] = useState({
    id: '',
    name: '',
    instructions: '',
    model: '',
    permission: 'read' as Role['permission'],
  });

  return (
    <Card title="Create a role">
      <div className="grid">
        <Field label="Id">
          <input
            type="text"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
            placeholder="security-reviewer"
          />
        </Field>
        <Field label="Name">
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Security reviewer"
          />
        </Field>
        <Field label="Can">
          <select
            value={form.permission}
            onChange={(e) => setForm({ ...form, permission: e.target.value as Role['permission'] })}
          >
            {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model (optional)">
          <input
            type="text"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder="ollama/qwen3:8b"
          />
        </Field>
      </div>
      <Field label="Instructions">
        <textarea
          rows={3}
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          placeholder="Review the change for injection, secrets and unsafe defaults. End with a verdict."
        />
      </Field>
      <button
        className="btn primary"
        disabled={!form.id || !form.name || !form.instructions}
        onClick={() =>
          void act(async () => {
            await request('workflows.role.save', {
              id: form.id.trim(),
              name: form.name.trim(),
              instructions: form.instructions.trim(),
              permission: form.permission,
              ...(form.model.trim() && { model: form.model.trim() }),
            });
            setForm({ id: '', name: '', instructions: '', model: '', permission: 'read' });
            onSaved();
          }, 'Role saved')
        }
      >
        Save role
      </button>
    </Card>
  );
}

function NewWorkflow({ roles, onSaved }: { roles: Role[]; onSaved: () => void }): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<WorkflowStep[]>([
    { id: 'plan', role: 'planner', task: 'Plan: {{request}}', dependsOn: [] },
  ]);

  const update = (index: number, patch: Partial<WorkflowStep>) =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));

  return (
    <Card title="Create a workflow">
      <div className="grid">
        <Field label="Id">
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="plan-and-review"
          />
        </Field>
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Plan and review"
          />
        </Field>
      </div>
      {steps.map((step, index) => (
        <div key={index} className="grid" style={{ alignItems: 'end' }}>
          <Field label={`Step ${index + 1} id`}>
            <input
              type="text"
              value={step.id}
              onChange={(e) => update(index, { id: e.target.value })}
            />
          </Field>
          <Field label="Role">
            <select value={step.role} onChange={(e) => update(index, { role: e.target.value })}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="After (step ids, comma separated)">
            <input
              type="text"
              value={step.dependsOn.join(', ')}
              onChange={(e) =>
                update(index, {
                  dependsOn: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="Task ({{request}} is the user's request)">
            <input
              type="text"
              value={step.task}
              onChange={(e) => update(index, { task: e.target.value })}
            />
          </Field>
        </div>
      ))}
      <div className="toolbar">
        <button
          className="btn"
          onClick={() =>
            setSteps((s) => [
              ...s,
              {
                id: `step-${s.length + 1}`,
                role: 'reviewer',
                task: '{{request}}',
                dependsOn: [s[s.length - 1]?.id ?? ''].filter(Boolean),
              },
            ])
          }
        >
          Add step
        </button>
        {steps.length > 1 && (
          <button className="btn ghost" onClick={() => setSteps((s) => s.slice(0, -1))}>
            Remove last step
          </button>
        )}
        <span className="spacer" />
        <button
          className="btn primary"
          disabled={!id.trim() || !name.trim()}
          onClick={() =>
            void act(async () => {
              await request('workflows.save', { id: id.trim(), name: name.trim(), steps });
              setId('');
              setName('');
              onSaved();
            }, 'Workflow saved')
          }
        >
          Save workflow
        </button>
      </div>
    </Card>
  );
}

function roleName(roles: Role[], id: string): string {
  return roles.find((r) => r.id === id)?.name ?? id;
}

function RunPill({ status }: { status: Execution['status'] }): JSX.Element {
  return (
    <Pill
      tone={
        status === 'done'
          ? 'ok'
          : status === 'running'
            ? 'warn'
            : status === 'failed'
              ? 'err'
              : 'idle'
      }
    >
      {status}
    </Pill>
  );
}

function StepPill({ status }: { status: StepExecution['status'] }): JSX.Element {
  return (
    <Pill
      tone={
        status === 'done'
          ? 'ok'
          : status === 'running'
            ? 'warn'
            : status === 'failed'
              ? 'err'
              : 'idle'
      }
    >
      {status}
    </Pill>
  );
}
