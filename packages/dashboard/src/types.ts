/** Wire shapes returned by the gateway methods the Control UI calls. */

export interface ChannelStatus {
  id: string;
  label: string;
  configured: boolean;
  running: boolean;
  connected: boolean;
  mode?: string;
  accountName?: string;
  lastStartAt?: number;
  lastError?: string;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  details?: Record<string, unknown>;
}

export interface HeartbeatEvent {
  ts: number;
  status: 'sent' | 'ok-token' | 'ok-empty' | 'skipped' | 'failed';
  reason?: string;
  trigger: string;
  preview?: string;
  durationMs?: number;
  channel?: string;
  to?: string;
}

export interface HealthSnapshot {
  ok: boolean;
  ts: number;
  version: string;
  uptimeMs: number;
  configValid: boolean;
  channels: ChannelStatus[];
  heartbeat: {
    enabled: boolean;
    every: string;
    nextRunAt: number | null;
    last: HeartbeatEvent | null;
  };
  cron: { enabled: boolean; jobs: number; nextWakeAtMs: number | null; storePath: string };
  activeRuns: number;
  pendingApprovals: number;
}

export interface StatusSnapshot extends HealthSnapshot {
  stateDir: string;
  configPath: string;
  workspace: string;
  model: string;
  mainSessionKey: string;
  sessions: number;
  connections: number;
  node: string;
  platform: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: 'image'; mimeType: string; data: string };

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'toolResult';
  content: ContentPart[];
  timestamp: number;
  source?: string;
  senderName?: string;
  model?: string;
  usage?: { input: number; output: number; total: number };
  stopReason?: string;
  injected?: boolean;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: ChatMessage;
  errorMessage?: string;
}

export interface AgentEventPayload {
  runId: string;
  sessionKey: string;
  stream: 'lifecycle' | 'assistant' | 'thinking' | 'tool';
  data: Record<string, unknown>;
}

export interface SessionRow {
  key: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  label?: string;
  displayName?: string;
  chatType: 'direct' | 'group' | 'main' | 'cron' | 'other';
  lastChannel?: string;
  lastTo?: string;
  model?: string;
  modelOverride?: string;
  thinkingLevel?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens?: number;
  running: boolean;
}

export interface CronJob {
  jobId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule:
    | { kind: 'at'; at: string }
    | { kind: 'every'; everyMs: number; anchorMs?: number }
    | { kind: 'cron'; expr: string; tz?: string };
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'now' | 'next-heartbeat';
  payload:
    | { kind: 'systemEvent'; text: string }
    | { kind: 'agentTurn'; message: string; model?: string; thinking?: string };
  delivery?: { mode: 'announce' | 'none' | 'webhook'; channel?: string; to?: string };
  createdAtMs: number;
  updatedAtMs: number;
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: 'ok' | 'error' | 'skipped';
    lastError?: string;
    lastDurationMs?: number;
  };
}

export interface CronRun {
  ts: number;
  jobId: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
  runAtMs: number;
  durationMs?: number;
}

export interface SkillStatus {
  name: string;
  description: string;
  source: 'bundled' | 'managed' | 'workspace' | 'extra';
  baseDir: string;
  filePath: string;
  emoji?: string;
  homepage?: string;
  primaryEnv?: string;
  disabled: boolean;
  eligible: boolean;
  missing: { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
  userInvocable: boolean;
  hasApiKey: boolean;
  error?: string;
}

export interface PresenceEntry {
  /** "gateway" for the daemon itself, otherwise the connection id. */
  id: string;
  host: string;
  clientId?: string;
  mode: string;
  role: string;
  platform?: string;
  version?: string;
  deviceId?: string;
  ip?: string;
  connectedAtMs: number;
  lastSeenAtMs: number;
  caps?: string[];
}

export interface PendingApproval {
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  request: {
    command: string;
    cwd: string;
    host: 'gateway';
    agentId: string;
    sessionKey: string;
    risk: { level: 'low' | 'medium' | 'high' | 'blocked'; reason: string };
  };
}

export interface PairingRequest {
  code: string;
  userId: string;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface DeviceRequest {
  requestId: string;
  deviceId: string;
  clientId?: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  role: 'operator' | 'node';
  ts: number;
}

export interface PairedDevice {
  deviceId: string;
  clientId?: string;
  displayName?: string;
  platform?: string;
  role: 'operator' | 'node';
  createdAtMs: number;
  approvedAtMs: number;
  lastSeenAtMs?: number;
  label?: string;
}

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  raw: string;
  hash: string;
  valid: boolean;
  issues?: string[];
  config: Record<string, unknown>;
}

export interface LogTail {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
}

export interface LogLine {
  time: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  subsystem: string;
  msg: string;
  [key: string]: unknown;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  exists: boolean;
  size: number;
  updatedAtMs: number | null;
}
