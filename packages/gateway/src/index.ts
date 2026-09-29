export { startGateway, type RunningGateway, type StartGatewayOptions } from './start.js';
export { Runtime, type RuntimeOptions, type RuntimeStartOptions } from './runtime.js';
export { GatewayServer, resolveControlUiDir, type ServerOptions } from './gateway/server.js';
export { VERSION } from './version.js';

// Protocol (shared with CLI/UI clients)
export {
  deviceSignaturePayload,
  GatewayError,
  GATEWAY_EVENTS,
  MAX_PAYLOAD,
  PROTOCOL_VERSION,
  TICK_INTERVAL_MS,
  type ConnectParams,
  type ErrorCode,
  type EventFrame,
  type Frame,
  type ReqFrame,
  type ResFrame,
} from './gateway/protocol.js';
export { METHODS } from './gateway/methods.js';
export {
  deviceIdFromPublicKey,
  verifyDeviceSignature,
  type PairedDevice,
} from './gateway/devices.js';

// Config
export {
  ConfigSchema,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_MODEL,
  DM_POLICIES,
  THINKING_LEVELS,
  UI_HINTS,
  parseDurationMs,
  type DmPolicy,
  type OpenPulseConfig,
  type ThinkingLevel,
} from './config/schema.js';
export {
  ConfigError,
  ConfigStore,
  getPath,
  mergePatch,
  patchForPath,
  type ConfigSnapshot,
} from './config/store.js';
export { expandHome, resolvePaths, resolveStateDir, type StatePaths } from './infra/paths.js';
export {
  LOG_LEVELS,
  LogSink,
  silentLogger,
  type LogLevel,
  type LogRecord,
  type Logger,
} from './infra/logger.js';

// Agent
export { AgentService, type DispatchParams } from './agent/agent-service.js';
export { AgentRunner, type AgentEvent, type ChatEvent, type RunResult } from './agent/runner.js';
export {
  createModel,
  formatModelRef,
  parseModelRef,
  KNOWN_MODELS,
  type ModelFactory,
  type ModelRef,
} from './agent/models.js';
export {
  buildSystemPrompt,
  DEFAULT_HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  isSilentReply,
  SILENT_REPLY_TOKEN,
  stripHeartbeatToken,
} from './agent/system-prompt.js';
export { transcriptToMessages } from './agent/context.js';
export { buildTools, TOOL_GROUPS } from './agent/tools/index.js';
export { BrowserSession } from './agent/tools/browser-tool.js';
export type { Tool, ToolContext, ToolResult, ToolServices } from './agent/tools/types.js';

// Sessions, skills, workspace
export {
  canonicalSessionKey,
  cronSessionKey,
  DEFAULT_AGENT_ID,
  mainSessionKey,
  parseSessionKey,
  resolveSessionKey,
  type DmScope,
} from './sessions/keys.js';
export { SessionStore, type SessionEntry } from './sessions/store.js';
export {
  appendTranscript,
  readTranscript,
  textOf,
  type ContentPart,
  type TranscriptEntry,
  type TranscriptMessage,
} from './sessions/transcript.js';
export {
  evaluateSkill,
  formatSkillsForPrompt,
  loadSkills,
  onPath,
  parseSkillFile,
  type SkillDefinition,
  type SkillStatus,
} from './skills/loader.js';
export { BUNDLED_SKILLS_DIR } from './skills/bundled.js';
export {
  BOOTSTRAP_FILES,
  dailyMemoryPath,
  ensureWorkspace,
  isHeartbeatFileEmpty,
  loadBootstrapFiles,
} from './workspace/workspace.js';

// Projects, files, git, security policy
export { ProjectStore, ProjectError, detectGit, type Project } from './workspace/projects.js';
export {
  FileService,
  FileServiceError,
  hashOf,
  type FileContent,
  type TreeEntry,
  type SearchHit,
} from './workspace/file-service.js';
export {
  GitRepo,
  GitError,
  gitAvailable,
  gitClone,
  type GitStatus,
  type GitCommit,
  type GitBranch,
  type GitFileChange,
} from './git/git.js';
export {
  FsPolicy,
  DEFAULT_DENY_PATTERNS,
  globMatch as pathGlobMatch,
  type SecurityMode,
  type FsDecision,
} from './policy/fs-policy.js';

// Model detection and telemetry
export {
  detectLocalProviders,
  detectOllama,
  detectLmStudio,
  inspectOllamaModel,
  type ProviderProbe,
  type DetectedModel,
  type ModelDetails,
} from './models/detect.js';
export {
  TelemetryStore,
  type RunRecord,
  type ToolRecord,
  type TelemetrySummary,
  type ModelSummary,
} from './telemetry/store.js';

// Test runner and debugger
export { detectTestSuites, onPath as commandOnPath, type TestSuite } from './testing/detect.js';
export { TestRunner, parseFailures, type TestRun, type TestFailure } from './testing/runner.js';
export { TraceRecorder, type RunTrace, type TraceEvent } from './debug/trace.js';
export { sanitizeText, sanitizeValue } from './debug/sanitize.js';

// MCP
export {
  McpClient,
  McpError,
  renderToolResult,
  MCP_PROTOCOL_VERSION,
  type McpToolDefinition,
  type McpToolResult,
} from './mcp/client.js';
export {
  McpManager,
  qualifiedToolName,
  type McpServerStatus,
  type McpToolStatus,
} from './mcp/manager.js';

// Changes and checkpoints
export {
  ChangeStore,
  ChangeError,
  type ChangeSet,
  type ChangeFile,
  type ChangeSetView,
  type ApplyResult,
} from './changes/proposals.js';
export { unifiedDiff, diffStat, diffHunks, type DiffHunk } from './changes/diff.js';
export {
  CheckpointService,
  CheckpointError,
  type Checkpoint,
  type RestorePreview,
} from './checkpoints/service.js';

// Channels, cron, heartbeat, approvals
export { ChannelManager } from './channels/manager.js';
export { PairingStore, type PairingRequest } from './channels/pairing-store.js';
export { TelegramChannel } from './channels/telegram.js';
export { chunkText, markdownToTelegramHtml } from './channels/telegram-format.js';
export type { ChannelPlugin, ChannelStatus, InboundMessage } from './channels/types.js';
export { CronService, type CronEvent } from './cron/service.js';
export { CronJobInputSchema, type CronJob, type CronRunRecord } from './cron/types.js';
export { HeartbeatRunner, withinActiveHours, type HeartbeatEvent } from './heartbeat/runner.js';
export {
  ExecApprovals,
  globMatch,
  type ExecApprovalRequest,
  type ExecDecision,
} from './approvals/exec-approvals.js';
export { assessShellCommand } from './policy/risk.js';
export type { RiskAssessment, RiskLevel } from './tools/types.js';

// Client (CLI, tests, embedders)
export {
  GatewayClient,
  GatewayClientError,
  type GatewayClientOptions,
  type HelloOk,
} from './client/gateway-client.js';
export {
  createIdentity,
  loadOrCreateIdentity,
  signChallenge,
  type DeviceIdentity,
} from './client/identity.js';
