import { isStepCount, jsonSchema, streamText, tool, type ToolSet } from 'ai';
import type { OpenPulseConfig, ThinkingLevel } from '../config/schema.js';
import type { Logger } from '../infra/logger.js';
import type { FsPolicy } from '../policy/fs-policy.js';
import { mainSessionKey } from '../sessions/keys.js';
import type { SessionStore } from '../sessions/store.js';
import {
  appendTranscript,
  readTranscript,
  textOf,
  type AssistantMessage,
  type ContentPart,
} from '../sessions/transcript.js';
import { formatSkillsForPrompt, skillEnv, type SkillDefinition } from '../skills/loader.js';
import { loadBootstrapFiles } from '../workspace/workspace.js';
import { transcriptToMessages } from './context.js';
import {
  createModel,
  formatModelRef,
  maxOutputTokensFor,
  parseModelRef,
  thinkingProviderOptions,
  type ModelFactory,
} from './models.js';
import { buildSystemPrompt, DEFAULT_HEARTBEAT_PROMPT } from './system-prompt.js';
import { buildTools } from './tools/index.js';
import {
  ToolInputError,
  type AnyTool,
  type ToolContext,
  type ToolServices,
} from './tools/types.js';

export type AgentStream = 'lifecycle' | 'assistant' | 'thinking' | 'tool';

export interface AgentEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  stream: AgentStream;
  ts: number;
  data: Record<string, unknown>;
}

export interface ChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: { role: 'assistant'; content: ContentPart[]; timestamp: number };
  errorMessage?: string;
}

export interface RunParams {
  runId: string;
  sessionKey: string;
  message: string;
  /** Who/what produced the message. */
  source: { kind: 'user' | 'heartbeat' | 'cron' | 'system'; channel?: string; senderName?: string };
  extraSystemPrompt?: string;
  signal?: AbortSignal;
  onAgentEvent?: (e: AgentEvent) => void;
  onChatEvent?: (e: ChatEvent) => void;
  /** Tools to withhold for this run. */
  excludeTools?: string[];
  /** Override per-run model (cron payload). */
  model?: string;
  thinking?: ThinkingLevel;
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

export interface RunnerDeps {
  agentId: string;
  config: () => OpenPulseConfig;
  workspace: () => string;
  /** The filesystem boundary the tools enforce; re-read each run so config changes take effect. */
  fsPolicy: () => FsPolicy;
  sessions: SessionStore;
  skills: () => Promise<SkillDefinition[]>;
  services: ToolServices;
  log: Logger;
  modelFactory?: ModelFactory;
}

/**
 * Runs one agent turn: loads the session transcript as context, builds the system prompt
 * (bootstrap files, skills, runtime facts), streams the model with tools, and persists each step.
 */
export class AgentRunner {
  private readonly modelFactory: ModelFactory;

  constructor(private readonly deps: RunnerDeps) {
    this.modelFactory = deps.modelFactory ?? createModel;
  }

  async run(p: RunParams): Promise<RunResult> {
    const config = this.deps.config();
    const { sessions, agentId } = this.deps;
    const log = this.deps.log.child(p.runId.slice(0, 8));
    let seq = 0;
    const agentEvent = (stream: AgentStream, data: Record<string, unknown>) =>
      p.onAgentEvent?.({
        runId: p.runId,
        sessionKey: p.sessionKey,
        seq: ++seq,
        stream,
        ts: Date.now(),
        data,
      });
    let chatSeq = 0;
    const chatEvent = (e: Omit<ChatEvent, 'runId' | 'sessionKey' | 'seq'>) =>
      p.onChatEvent?.({ runId: p.runId, sessionKey: p.sessionKey, seq: ++chatSeq, ...e });

    const entry = await sessions.ensure(p.sessionKey);
    const file = sessions.transcriptFile(entry);
    const workspace = this.deps.workspace();
    const isMain = p.sessionKey === mainSessionKey(agentId, config.session.mainKey);
    const modelRefStr = p.model ?? entry.modelOverride ?? config.agents.defaults.model.primary;
    const ref = parseModelRef(modelRefStr, config);
    const modelName = formatModelRef(ref);
    const thinking = p.thinking ?? entry.thinkingLevel ?? config.agents.defaults.thinkingDefault;
    const usage = { input: 0, output: 0, total: 0 };
    let toolCalls = 0;

    agentEvent('lifecycle', { phase: 'start', model: modelName, thinking });

    // Context first (before appending the new message).
    const history = transcriptToMessages(
      await readTranscript(file),
      config.agents.defaults.contextTokens * 3,
    );
    await appendTranscript(
      file,
      entry.sessionId,
      {
        role: 'user',
        content: [{ type: 'text', text: p.message }],
        timestamp: Date.now(),
        source: p.source.channel ?? p.source.kind,
        ...(p.source.senderName !== undefined && { senderName: p.source.senderName }),
      },
      workspace,
    );

    const fail = async (message: string): Promise<RunResult> => {
      log.error(`run failed: ${message}`);
      agentEvent('lifecycle', { phase: 'error', error: message });
      chatEvent({ state: 'error', errorMessage: message });
      await appendTranscript(file, entry.sessionId, {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
        stopReason: 'error',
        errorMessage: message,
        model: ref.model,
        provider: ref.provider,
      });
      return {
        runId: p.runId,
        sessionKey: p.sessionKey,
        text: '',
        aborted: false,
        error: message,
        model: modelName,
        toolCalls,
        usage,
      };
    };

    let model;
    try {
      model = this.modelFactory(ref, config);
    } catch (error) {
      return fail((error as Error).message);
    }

    const skills = await this.deps.skills();
    const tools = buildTools({
      config,
      browser: this.deps.services.browser,
      ...(p.excludeTools && { exclude: p.excludeTools }),
    });
    const ctx: ToolContext = {
      agentId,
      sessionKey: p.sessionKey,
      runId: p.runId,
      workspace,
      fsPolicy: this.deps.fsPolicy(),
      config,
      log: log.child('tool'),
      extraEnv: skillEnv(skills, config),
      isMainSession: isMain,
      services: this.deps.services,
      ...(p.signal && { signal: p.signal }),
    };

    const system = buildSystemPrompt({
      agentId,
      workspace,
      tools,
      skillsXml: formatSkillsForPrompt(skills),
      bootstrap: config.agents.defaults.skipBootstrap
        ? []
        : await loadBootstrapFiles(workspace, {
            includeMemory: isMain,
            maxChars: config.agents.defaults.bootstrapMaxChars,
            totalMaxChars: config.agents.defaults.bootstrapTotalMaxChars,
          }),
      isMainSession: isMain,
      heartbeatPrompt: config.agents.defaults.heartbeat.prompt ?? DEFAULT_HEARTBEAT_PROMPT,
      model: modelName,
      thinking,
      timezone:
        config.agents.defaults.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(p.source.channel !== undefined && { channel: p.source.channel }),
      ...(p.extraSystemPrompt !== undefined && { extra: p.extraSystemPrompt }),
    });

    const toolSet: ToolSet = {};
    for (const t of tools) toolSet[t.name] = this.wrapTool(t, ctx, agentEvent, () => toolCalls++);

    // Per-step accumulation, persisted at each step boundary.
    let stepText = '';
    let stepThinking = '';
    let stepCalls: ContentPart[] = [];
    let stepResults: { toolCallId: string; toolName: string; text: string; isError: boolean }[] =
      [];
    let runText = '';
    let lastStepText = '';
    let aborted = false;
    let streamError: string | undefined;

    const flushStep = async (stopReason: AssistantMessage['stopReason']) => {
      const content: ContentPart[] = [];
      if (stepThinking.trim()) content.push({ type: 'thinking', thinking: stepThinking });
      if (stepText.trim()) content.push({ type: 'text', text: stepText });
      content.push(...stepCalls);
      if (content.length > 0 || stopReason === 'aborted') {
        await appendTranscript(file, entry.sessionId, {
          role: 'assistant',
          content,
          timestamp: Date.now(),
          model: ref.model,
          provider: ref.provider,
          ...(stopReason && { stopReason }),
        });
      }
      for (const r of stepResults) {
        await appendTranscript(file, entry.sessionId, {
          role: 'toolResult',
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          content: [{ type: 'text', text: r.text }],
          isError: r.isError,
          timestamp: Date.now(),
        });
      }
      if (stepText.trim()) lastStepText = stepText.trim();
      stepText = '';
      stepThinking = '';
      stepCalls = [];
      stepResults = [];
    };

    const timeout = AbortSignal.timeout(config.agents.defaults.timeoutSeconds * 1000);
    const signal = p.signal ? AbortSignal.any([p.signal, timeout]) : timeout;
    const providerOptions = thinkingProviderOptions(ref, thinking);
    const maxOutputTokens = maxOutputTokensFor(ref);

    try {
      const result = streamText({
        model,
        system,
        messages: [...history, { role: 'user', content: p.message }],
        tools: toolSet,
        stopWhen: isStepCount(config.agents.defaults.maxToolSteps),
        abortSignal: signal,
        maxRetries: 2,
        ...(providerOptions && { providerOptions: providerOptions as never }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            stepText += part.text;
            runText += part.text;
            agentEvent('assistant', { delta: part.text });
            chatEvent({
              state: 'delta',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: runText }],
                timestamp: Date.now(),
              },
            });
            break;
          case 'reasoning-delta':
            stepThinking += part.text;
            agentEvent('thinking', { delta: part.text });
            break;
          case 'tool-call':
            stepCalls.push({
              type: 'toolCall',
              id: part.toolCallId,
              name: part.toolName,
              arguments: part.input,
            });
            if (runText && !runText.endsWith('\n\n')) runText += '\n\n';
            break;
          case 'tool-result':
            stepResults.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              text: String(part.output ?? ''),
              isError: String(part.output ?? '').startsWith('ERROR: '),
            });
            break;
          case 'tool-error':
            stepResults.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              text: `ERROR: ${errorText(part.error)}`,
              isError: true,
            });
            break;
          case 'finish-step':
            usage.input += part.usage.inputTokens ?? 0;
            usage.output += part.usage.outputTokens ?? 0;
            await flushStep(
              part.finishReason === 'tool-calls'
                ? 'toolUse'
                : part.finishReason === 'length'
                  ? 'length'
                  : 'stop',
            );
            break;
          case 'abort':
            aborted = true;
            break;
          case 'error':
            streamError = errorText(part.error);
            break;
        }
      }
    } catch (error) {
      if (signal.aborted) aborted = true;
      else streamError = errorText(error);
    }

    if (aborted || signal.aborted) {
      await flushStep('aborted');
      const reason = timeout.aborted ? 'timeout' : 'aborted';
      log.info(`run ${reason}`);
      agentEvent('lifecycle', { phase: 'end', aborted: true, reason });
      chatEvent({
        state: 'aborted',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: runText }],
          timestamp: Date.now(),
        },
      });
      await this.bumpSession(p.sessionKey, usage, modelName, true);
      return {
        runId: p.runId,
        sessionKey: p.sessionKey,
        text: runText.trim(),
        aborted: true,
        model: modelName,
        toolCalls,
        usage: { ...usage, total: usage.input + usage.output },
      };
    }
    if (streamError) {
      await flushStep('error');
      return fail(streamError);
    }
    await flushStep(undefined);

    usage.total = usage.input + usage.output;
    const finalText = lastStepText || runText.trim();
    await this.bumpSession(p.sessionKey, usage, modelName, false);
    agentEvent('lifecycle', { phase: 'end', usage, toolCalls });
    chatEvent({
      state: 'final',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: finalText }],
        timestamp: Date.now(),
      },
    });
    log.info(`run done`, {
      model: modelName,
      toolCalls,
      inputTokens: usage.input,
      outputTokens: usage.output,
    });
    return {
      runId: p.runId,
      sessionKey: p.sessionKey,
      text: finalText,
      aborted: false,
      model: modelName,
      toolCalls,
      usage,
    };
  }

  private wrapTool(
    t: AnyTool,
    ctx: ToolContext,
    emit: (s: AgentStream, d: Record<string, unknown>) => void,
    count: () => void,
  ) {
    return tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as never),
      execute: async (raw: unknown, opts: { toolCallId: string }) => {
        count();
        const started = Date.now();
        let summary = t.name;
        try {
          const input: unknown = t.parseInput(raw);
          summary = safe(() => t.summarize(input), t.name);
          emit('tool', {
            phase: 'start',
            toolCallId: opts.toolCallId,
            name: t.name,
            summary,
            args: raw,
          });
          const r = await t.execute(input, ctx);
          emit('tool', {
            phase: 'result',
            toolCallId: opts.toolCallId,
            name: t.name,
            summary,
            isError: Boolean(r.isError),
            result: r.content.slice(0, 8000),
            durationMs: Date.now() - started,
          });
          ctx.log.info(`${t.name}: ${summary}`, {
            ms: Date.now() - started,
            error: r.isError ? true : undefined,
          });
          return r.isError ? `ERROR: ${r.content}` : r.content;
        } catch (error) {
          const msg =
            error instanceof ToolInputError
              ? error.message
              : `${t.name} failed: ${(error as Error).message}`;
          emit('tool', {
            phase: 'result',
            toolCallId: opts.toolCallId,
            name: t.name,
            summary,
            isError: true,
            result: msg,
            durationMs: Date.now() - started,
          });
          ctx.log.warn(msg);
          return `ERROR: ${msg}`;
        }
      },
    });
  }

  private async bumpSession(
    key: string,
    usage: { input: number; output: number },
    model: string,
    aborted: boolean,
  ): Promise<void> {
    const cur = await this.deps.sessions.get(key);
    if (!cur) return;
    await this.deps.sessions.patch(key, {
      inputTokens: cur.inputTokens + usage.input,
      outputTokens: cur.outputTokens + usage.output,
      totalTokens: cur.totalTokens + usage.input + usage.output,
      contextTokens: usage.input,
      model,
      abortedLastRun: aborted,
    });
  }
}

export function lastAssistantText(
  entries: { message: { role: string; content: ContentPart[] } }[],
): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]!.message;
    if (m.role === 'assistant') {
      const t = textOf(m.content);
      if (t) return t;
    }
  }
  return '';
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}
