import { z } from 'zod';

// zod 4: `.default(x)` returns x unparsed, so nested objects use `.prefault({})` to get inner defaults.

export const DEFAULT_GATEWAY_PORT = 18789;
export const DEFAULT_MODEL = 'anthropic/claude-opus-5';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DM_POLICIES = ['pairing', 'allowlist', 'open', 'disabled'] as const;
export type DmPolicy = (typeof DM_POLICIES)[number];

const duration = z
  .string()
  .regex(/^\d+(\.\d+)?\s*(ms|s|m|h|d)$/, 'expected a duration like "30m", "2h" or "0m"');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'expected HH:MM');

const ProviderSchema = z
  .object({
    /** Wire protocol. Built-in ids (anthropic, openai, ollama, lmstudio, openrouter) infer it. */
    api: z.enum(['anthropic', 'openai', 'openai-compatible']).optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
  })
  .strict();

const HeartbeatSchema = z
  .object({
    /** Interval between heartbeats; "0m" disables. */
    every: duration.default('30m'),
    /** Where alerts go: the last chat the agent replied in, nowhere, or a channel id. */
    target: z.string().default('last'),
    /** Explicit recipient for the target channel (overrides the last route). */
    to: z.string().optional(),
    prompt: z.string().optional(),
    /** Max characters allowed next to HEARTBEAT_OK for the reply to still count as "ok". */
    ackMaxChars: z.number().int().min(0).default(300),
    activeHours: z
      .object({ start: hhmm, end: hhmm, timezone: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

const AgentDefaultsSchema = z
  .object({
    workspace: z.string().optional(),
    model: z
      .object({
        primary: z.string().default(DEFAULT_MODEL),
        fallbacks: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    /** Optional model catalog; also the allowlist for `/model` when non-empty. */
    models: z.record(z.string(), z.object({ alias: z.string().optional() }).strict()).default({}),
    thinkingDefault: z.enum(THINKING_LEVELS).default('low'),
    timeoutSeconds: z
      .number()
      .int()
      .min(10)
      .max(24 * 3600)
      .default(600),
    maxToolSteps: z.number().int().min(1).max(200).default(40),
    maxConcurrent: z.number().int().min(1).max(16).default(4),
    contextTokens: z.number().int().min(4000).default(200_000),
    bootstrapMaxChars: z.number().int().min(500).default(20_000),
    bootstrapTotalMaxChars: z.number().int().min(1000).default(60_000),
    skipBootstrap: z.boolean().default(false),
    userTimezone: z.string().optional(),
    heartbeat: HeartbeatSchema.prefault({}),
  })
  .strict();

const TelegramSchema = z
  .object({
    enabled: z.boolean().default(true),
    botToken: z.string().optional(),
    dmPolicy: z.enum(DM_POLICIES).default('pairing'),
    /** Numeric Telegram user ids (tg:/telegram: prefixes accepted), or "*" with dmPolicy open. */
    allowFrom: z.array(z.union([z.string(), z.number()]).transform(String)).default([]),
    groupPolicy: z.enum(['open', 'allowlist', 'disabled']).default('allowlist'),
    groupAllowFrom: z.array(z.union([z.string(), z.number()]).transform(String)).optional(),
    groups: z
      .record(
        z.string(),
        z
          .object({
            requireMention: z.boolean().optional(),
            groupPolicy: z.enum(['open', 'allowlist', 'disabled']).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Public URL for webhook mode; long polling is used when unset. */
    webhookUrl: z.string().url().optional(),
    webhookSecret: z.string().optional(),
    linkPreview: z.boolean().default(true),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    meta: z
      .object({ lastTouchedVersion: z.string().optional(), lastTouchedAt: z.string().optional() })
      .strict()
      .optional(),
    env: z.record(z.string(), z.string()).default({}),
    models: z
      .object({ providers: z.record(z.string(), ProviderSchema).default({}) })
      .strict()
      .prefault({}),
    agents: z
      .object({
        defaults: AgentDefaultsSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    session: z
      .object({
        dmScope: z
          .enum(['main', 'per-peer', 'per-channel-peer', 'per-account-channel-peer'])
          .default('main'),
        mainKey: z.string().default('main'),
        reset: z
          .object({
            mode: z.enum(['none', 'daily', 'idle']).default('none'),
            atHour: z.number().int().min(0).max(23).default(4),
            idleMinutes: z.number().int().min(1).default(120),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    channels: z
      .object({
        telegram: TelegramSchema.optional(),
      })
      .strict()
      .prefault({}),
    tools: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).default([]),
        exec: z
          .object({
            timeoutSec: z.number().int().min(1).default(1800),
            /** Auto-background after this many ms (returns a process session). */
            yieldMs: z.number().int().min(0).default(10_000),
            shell: z.string().optional(),
          })
          .strict()
          .prefault({}),
        web: z
          .object({
            search: z
              .object({
                enabled: z.boolean().default(true),
                apiKey: z.string().optional(),
                maxResults: z.number().int().min(1).max(10).default(5),
              })
              .strict()
              .prefault({}),
            fetch: z
              .object({
                enabled: z.boolean().default(true),
                maxChars: z.number().int().min(1000).default(50_000),
              })
              .strict()
              .prefault({}),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    browser: z
      .object({
        enabled: z.boolean().default(true),
        headless: z.boolean().default(false),
        channel: z.enum(['auto', 'chrome', 'msedge', 'chromium']).default('auto'),
      })
      .strict()
      .prefault({}),
    skills: z
      .object({
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                apiKey: z.string().optional(),
                env: z.record(z.string(), z.string()).optional(),
              })
              .strict(),
          )
          .default({}),
        load: z
          .object({ extraDirs: z.array(z.string()).default([]), watch: z.boolean().default(true) })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    cron: z
      .object({
        enabled: z.boolean().default(true),
        maxConcurrentRuns: z.number().int().min(1).default(1),
        webhookToken: z.string().optional(),
      })
      .strict()
      .prefault({}),
    gateway: z
      .object({
        port: z.number().int().min(1).max(65535).default(DEFAULT_GATEWAY_PORT),
        bind: z.enum(['loopback', 'lan']).default('loopback'),
        auth: z
          .object({
            mode: z.enum(['token', 'password', 'none']).default('token'),
            token: z.string().optional(),
            password: z.string().optional(),
          })
          .strict()
          .prefault({}),
        controlUi: z
          .object({
            enabled: z.boolean().default(true),
            allowedOrigins: z.array(z.string()).default([]),
          })
          .strict()
          .prefault({}),
        reload: z
          .object({ mode: z.enum(['hybrid', 'hot', 'off']).default('hybrid') })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    logging: z
      .object({
        level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      })
      .strict()
      .prefault({}),
    ui: z
      .object({
        assistant: z
          .object({ name: z.string().optional(), avatar: z.string().optional() })
          .strict()
          .optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type OpenPulseConfig = z.output<typeof ConfigSchema>;
export type TelegramConfig = z.output<typeof TelegramSchema>;

/** Field hints for the Control UI config form. */
export const UI_HINTS: Record<
  string,
  { label?: string; help?: string; sensitive?: boolean; order?: number }
> = {
  'agents.defaults.model.primary': {
    label: 'Primary model',
    help: 'provider/model, e.g. anthropic/claude-opus-5, openai/gpt-5, ollama/qwen3:8b',
  },
  'agents.defaults.workspace': {
    label: 'Workspace',
    help: 'Agent working directory (default ~/.openpulse/workspace)',
  },
  'agents.defaults.heartbeat.every': {
    label: 'Heartbeat interval',
    help: '"30m", "2h", "0m" disables',
  },
  'agents.defaults.heartbeat.target': { label: 'Heartbeat target', help: 'last | none | telegram' },
  'channels.telegram.botToken': { label: 'Bot token', sensitive: true },
  'channels.telegram.dmPolicy': { label: 'DM policy' },
  'channels.telegram.allowFrom': { label: 'Allow from', help: 'Numeric Telegram user ids' },
  'models.providers': { label: 'Model providers', help: 'apiKey / baseUrl per provider id' },
  'tools.web.search.apiKey': { label: 'Brave Search API key', sensitive: true },
  'gateway.auth.token': { label: 'Gateway token', sensitive: true },
  'gateway.auth.password': { label: 'Gateway password', sensitive: true },
  'cron.webhookToken': { label: 'Cron webhook token', sensitive: true },
};

export function parseDurationMs(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!m) throw new Error(`Invalid duration "${value}"`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms'];
  return n * unit;
}
