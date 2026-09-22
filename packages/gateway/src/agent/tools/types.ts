import { z } from 'zod';
import type { ExecApprovals } from '../../approvals/exec-approvals.js';
import type { OpenPulseConfig } from '../../config/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { ProcessRegistry } from '../process-registry.js';
import type { BrowserSession } from './browser-tool.js';

export interface JsonObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolResult {
  /** Text returned to the model. */
  content: string;
  isError?: boolean;
}

/** Everything a tool may need, supplied per agent run. */
export interface ToolContext {
  agentId: string;
  sessionKey: string;
  runId: string;
  /** Agent workspace; the working directory for relative paths and exec. */
  workspace: string;
  config: OpenPulseConfig;
  log: Logger;
  signal?: AbortSignal;
  /** Env vars contributed by skills (skills.entries.*.env / apiKey). */
  extraEnv: Record<string, string>;
  isMainSession: boolean;
  services: ToolServices;
}

/** Gateway services tools call into (kept as an interface to avoid import cycles). */
export interface ToolServices {
  approvals: ExecApprovals;
  processes: ProcessRegistry;
  browser: BrowserSession;
  cron: CronToolApi;
  sessions: SessionToolApi;
  messaging: MessagingApi;
}

export interface CronToolApi {
  status(): Promise<unknown>;
  list(includeDisabled?: boolean): Promise<unknown>;
  add(job: unknown): Promise<unknown>;
  update(jobId: string, patch: unknown): Promise<unknown>;
  remove(jobId: string): Promise<unknown>;
  run(jobId: string): Promise<unknown>;
  runs(jobId: string, limit?: number): Promise<unknown>;
  wake(text: string, mode: 'now' | 'next-heartbeat'): Promise<unknown>;
}

export interface SessionToolApi {
  list(opts: { limit?: number; activeMinutes?: number }): Promise<unknown>;
  history(sessionKey: string, limit?: number): Promise<unknown>;
  send(sessionKey: string, message: string, fromSessionKey: string): Promise<string>;
  status(sessionKey: string): Promise<unknown>;
}

export interface MessagingApi {
  channels(): string[];
  send(channel: string, to: string, text: string): Promise<void>;
  lastRoute(sessionKey: string): Promise<{ channel: string; to: string } | undefined>;
}

export interface Tool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  parseInput(raw: unknown): Input;
  /** One-line summary for tool cards / logs, e.g. `$ git status`. */
  summarize(input: Input): string;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

export class ToolInputError extends Error {
  constructor(
    readonly toolName: string,
    readonly issues: string[],
  ) {
    super(`Invalid input for ${toolName}: ${issues.join('; ')}`);
    this.name = 'ToolInputError';
  }
}

export function defineTool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  input: S;
  summarize: (input: z.output<S>) => string;
  execute: (input: z.output<S>, ctx: ToolContext) => Promise<ToolResult>;
}): Tool<z.output<S>> {
  const json = z.toJSONSchema(spec.input, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      ...json,
      type: 'object',
      properties: (json.properties ?? {}) as Record<string, unknown>,
    },
    parseInput: (raw) => {
      const r = spec.input.safeParse(raw ?? {});
      if (r.success) return r.data;
      throw new ToolInputError(
        spec.name,
        r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`),
      );
    },
    summarize: spec.summarize,
    execute: spec.execute,
  };
}

export const ok = (content: string): ToolResult => ({ content });
export const fail = (content: string): ToolResult => ({ content, isError: true });

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - head - tail} characters omitted …]\n\n${text.slice(-tail)}`;
}
