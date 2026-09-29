/** Wire types shared with the gateway. Kept structural so the SDK has no runtime dependency on it. */

export interface HelloOk {
  protocol: number;
  server: { version: string; connId: string; host: string; startedAtMs: number };
  features: { methods: string[]; events: string[] };
  snapshot: Record<string, unknown>;
  policy: { maxPayload: number; tickIntervalMs: number };
  auth: { role: string; scopes: string[]; deviceToken?: string };
}

export interface GatewayEvent<T = unknown> {
  event: string;
  payload: T;
  seq?: number;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: string; [key: string]: unknown };

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'toolResult';
  content: ContentPart[];
  timestamp: number;
  [key: string]: unknown;
}

export interface ChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: { role: 'assistant'; content: ContentPart[]; timestamp: number };
  errorMessage?: string;
}

export interface AgentEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  stream: 'lifecycle' | 'assistant' | 'thinking' | 'tool';
  ts: number;
  data: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  sessionKey: string;
  text: string;
  aborted: boolean;
  error?: string;
  model: string;
  toolCalls: number;
  usage: { input: number; output: number; total: number };
}

export interface HealthSnapshot {
  ok: boolean;
  ts: number;
  version: string;
  uptimeMs: number;
  configValid: boolean;
  activeRuns: number;
  pendingApprovals: number;
  [key: string]: unknown;
}

export interface SessionRow {
  key: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  chatType: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  running: boolean;
  [key: string]: unknown;
}

export interface ModelInfo {
  ref: string;
  name: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  source: 'builtin' | 'mcp';
  inputSchema: Record<string, unknown>;
}

export interface RunTraceSummary {
  runId: string;
  sessionKey: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'error' | 'aborted';
  model?: string;
  toolCalls: number;
  errors: number;
}

export interface WorkflowStep {
  id: string;
  role: string;
  roleName: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
  output?: string;
  error?: string;
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  request: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  endedAt?: number;
  steps: WorkflowStep[];
  changeSetIds: string[];
  error?: string;
}

/** One item of a streamed agent task. */
export type TaskUpdate =
  | { type: 'text'; delta: string; text: string }
  | { type: 'thinking'; delta: string }
  | {
      type: 'tool';
      phase: 'start' | 'result';
      name: string;
      summary?: string;
      isError?: boolean;
      durationMs?: number;
    }
  | { type: 'approval'; id: string; command: string; reason: string }
  | { type: 'done'; text: string; runId: string }
  | { type: 'aborted'; text: string; runId: string }
  | { type: 'error'; message: string; runId: string };
