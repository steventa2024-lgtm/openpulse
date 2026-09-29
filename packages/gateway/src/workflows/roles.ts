import { z } from 'zod';

export const RoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  /** Standing instructions for this role, added to the system prompt of each of its runs. */
  instructions: z.string().min(1).max(8000),
  /** Model override; omitted means the gateway's default model. */
  model: z.string().optional(),
  /**
   * What the role may do. "read" can only look; "propose" can also record reviewable changes;
   * "execute" can additionally run commands (tests, builds) under the usual approval rules.
   */
  permission: z.enum(['read', 'propose', 'execute']).default('read'),
  /** Extra tools to withhold beyond what the permission level already removes. */
  denyTools: z.array(z.string()).default([]),
  builtin: z.boolean().default(false),
});

export type Role = z.output<typeof RoleSchema>;

/** Tools that change files or run things; which of them a role keeps depends on its permission. */
const WRITE_TOOLS = ['write', 'edit'];
const EXEC_TOOLS = ['exec', 'process', 'browser'];
const MESSAGING_TOOLS = ['message', 'sessions_send', 'cron'];

/** The tools a role must not have, derived from its permission level. */
export function excludedTools(role: Role): string[] {
  // Workflow steps never write files directly: edits go through propose_change so a human reviews
  // them, and concurrent steps cannot overwrite each other.
  const excluded = new Set<string>([...WRITE_TOOLS, ...MESSAGING_TOOLS, ...role.denyTools]);
  if (role.permission === 'read') excluded.add('propose_change');
  if (role.permission !== 'execute') for (const tool of EXEC_TOOLS) excluded.add(tool);
  return [...excluded];
}

export const BUILTIN_ROLES: Role[] = [
  {
    id: 'planner',
    name: 'Planner',
    description: 'Reads the project and turns the request into a concrete plan.',
    permission: 'read',
    denyTools: [],
    builtin: true,
    instructions: [
      'You are the planner in a team of agents working on one request.',
      'Read enough of the project to understand where the change belongs. Do not change anything.',
      'Produce a numbered plan: the files involved, what changes in each, and how to verify it.',
      'Name risks and open questions. Keep it short enough that the next agent can follow it.',
    ].join('\n'),
  },
  {
    id: 'researcher',
    name: 'Research Agent',
    description: 'Looks things up — in the code and on the web — and reports findings.',
    permission: 'read',
    denyTools: [],
    builtin: true,
    instructions: [
      'You are the researcher in a team of agents.',
      'Find the facts the others need: how existing code works, library behaviour, documentation.',
      'Cite file paths and URLs. Say plainly when you could not confirm something.',
    ].join('\n'),
  },
  {
    id: 'coder',
    name: 'Coding Agent',
    description: 'Implements the plan as reviewable changes.',
    permission: 'propose',
    denyTools: [],
    builtin: true,
    instructions: [
      'You are the coding agent in a team of agents.',
      'Implement the plan you are given. Read each file before changing it.',
      'Record every edit with the propose_change tool, giving the full new contents of each file.',
      'You cannot write files directly; a human reviews and applies your proposal.',
      'Finish with a short summary of what you changed and why.',
    ].join('\n'),
  },
  {
    id: 'tester',
    name: 'Testing Agent',
    description: 'Runs the project’s tests and reports what actually happened.',
    permission: 'execute',
    denyTools: ['propose_change'],
    builtin: true,
    instructions: [
      'You are the testing agent in a team of agents.',
      'Run the project’s own test command and report the real result: what passed, what failed, the error output.',
      'Never claim tests pass unless you saw them pass. If you cannot run them, say why.',
      'Note that proposed changes are not applied yet unless the context says so.',
    ].join('\n'),
  },
  {
    id: 'reviewer',
    name: 'Review Agent',
    description: 'Reviews the proposed changes and the test results.',
    permission: 'read',
    denyTools: [],
    builtin: true,
    instructions: [
      'You are the reviewer in a team of agents.',
      'Review the plan, the proposed changes and the test results you are given.',
      'Look for bugs, missing cases and anything that does not match the request.',
      'End with a clear verdict: ready to apply, or what must change first.',
    ].join('\n'),
  },
];
