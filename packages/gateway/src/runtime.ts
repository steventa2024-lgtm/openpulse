import path from 'node:path';
import { AgentService } from './agent/agent-service.js';
import type { ModelFactory } from './agent/models.js';
import { ProcessRegistry } from './agent/process-registry.js';
import { AgentRunner } from './agent/runner.js';
import { BrowserSession } from './agent/tools/browser-tool.js';
import type { ToolServices } from './agent/tools/types.js';
import { ExecApprovals } from './approvals/exec-approvals.js';
import { ChannelManager } from './channels/manager.js';
import { PairingStore } from './channels/pairing-store.js';
import type { OpenPulseConfig } from './config/schema.js';
import { ConfigStore } from './config/store.js';
import { CronService } from './cron/service.js';
import { DeviceStore } from './gateway/devices.js';
import { HeartbeatRunner } from './heartbeat/runner.js';
import { LogSink, type LogRecord, type Logger } from './infra/logger.js';
import { expandHome, resolvePaths, resolveStateDir, type StatePaths } from './infra/paths.js';
import { canonicalSessionKey, DEFAULT_AGENT_ID } from './sessions/keys.js';
import { SessionStore } from './sessions/store.js';
import { readTranscript, textOf } from './sessions/transcript.js';
import { BUNDLED_SKILLS_DIR } from './skills/bundled.js';
import {
  evaluateSkill,
  loadSkills,
  type SkillDefinition,
  type SkillStatus,
} from './skills/loader.js';
import { DEFAULT_DENY_PATTERNS, FsPolicy } from './policy/fs-policy.js';
import { ProjectStore } from './workspace/projects.js';
import { ensureWorkspace } from './workspace/workspace.js';

export interface RuntimeOptions {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  modelFactory?: ModelFactory;
  telegramFetch?: typeof fetch;
  telegramApiBase?: string;
  /** Mirror log records to a console printer. */
  logConsole?: (r: LogRecord) => void;
  bundledSkillsDir?: string;
}

export interface RuntimeStartOptions {
  channels?: boolean;
  cron?: boolean;
  heartbeat?: boolean;
}

/** The whole agent, minus the network server. Shared by the gateway and tests. */
export class Runtime {
  readonly agentId = DEFAULT_AGENT_ID;
  readonly paths: StatePaths;
  readonly logs: LogSink;
  readonly log: Logger;
  readonly config: ConfigStore;
  readonly approvals: ExecApprovals;
  readonly pairing: PairingStore;
  readonly devices: DeviceStore;
  readonly sessions: SessionStore;
  readonly projects: ProjectStore;
  readonly processes = new ProcessRegistry();
  readonly browser: BrowserSession;
  readonly runner: AgentRunner;
  readonly agent: AgentService;
  readonly channels: ChannelManager;
  readonly cron: CronService;
  readonly heartbeat: HeartbeatRunner;
  readonly startedAt = Date.now();
  private started = false;
  private fsPolicyValue: FsPolicy = new FsPolicy({
    mode: 'balanced',
    readRoots: [],
    writeRoots: [],
    denyPatterns: DEFAULT_DENY_PATTERNS,
  });
  private readonly onConfigChange = () => void this.applyConfig();

  private constructor(private readonly options: RuntimeOptions) {
    const env = options.env ?? process.env;
    this.paths = resolvePaths(options.stateDir ?? resolveStateDir(env), env);
    this.logs = new LogSink({
      dir: this.paths.logsDir,
      ...(options.logConsole && { console: options.logConsole }),
    });
    this.log = this.logs.logger('gateway');
    this.config = new ConfigStore(this.paths.configPath, env);
    this.approvals = new ExecApprovals(this.paths.execApprovalsPath);
    this.pairing = new PairingStore(this.paths.credentialsDir);
    this.devices = new DeviceStore(this.paths.devicesDir);
    this.sessions = new SessionStore(this.paths.sessionsDir(this.agentId));
    this.projects = new ProjectStore(path.join(this.paths.stateDir, 'projects.json'));
    this.browser = new BrowserSession(
      () => this.cfg.browser,
      path.join(this.paths.stateDir, 'media', 'browser'),
      this.logs.logger('browser'),
    );

    const services: ToolServices = {
      approvals: this.approvals,
      processes: this.processes,
      browser: this.browser,
      cron: {
        status: () => Promise.resolve(this.cron.status()),
        list: (inc) => Promise.resolve(this.cron.list(inc)),
        add: (job) => this.cron.add(job),
        update: (id, patch) => this.cron.update(id, patch),
        remove: (id) => this.cron.remove(id),
        run: (id) => this.cron.run(id),
        runs: (id, limit) => this.cron.runs(id, limit),
        wake: (text, mode) => Promise.resolve(this.cron.wake(text, mode)),
      },
      sessions: {
        list: async ({ limit, activeMinutes }) => {
          const cutoff = activeMinutes ? Date.now() - activeMinutes * 60_000 : 0;
          return (await this.sessions.list())
            .filter((s) => s.updatedAt >= cutoff)
            .slice(0, limit ?? 50)
            .map((s) => ({
              key: s.key,
              kind: s.chatType,
              updatedAt: new Date(s.updatedAt).toISOString(),
              model: s.model,
              totalTokens: s.totalTokens,
              displayName: s.displayName,
            }));
        },
        history: async (key, limit) => {
          const entry = await this.sessions.get(this.canonical(key));
          if (!entry) return [];
          return (await readTranscript(this.sessions.transcriptFile(entry)))
            .slice(-(limit ?? 20))
            .map((e) => ({
              role: e.message.role,
              text:
                e.message.role === 'toolResult'
                  ? `[${e.message.toolName}] ${textOf(e.message.content).slice(0, 500)}`
                  : textOf(e.message.content),
              at: e.timestamp,
            }));
        },
        send: async (key, message, from) => {
          const r = await this.agent.runAndWait({
            sessionKey: this.canonical(key),
            message,
            source: { kind: 'system', channel: `session:${from}` },
          });
          return r.error ? `ERROR: ${r.error}` : r.text || '(no reply)';
        },
        status: async (key) => {
          const e = await this.sessions.ensure(key);
          return {
            sessionKey: key,
            sessionId: e.sessionId,
            model: e.modelOverride ?? this.cfg.agents.defaults.model.primary,
            thinking: e.thinkingLevel ?? this.cfg.agents.defaults.thinkingDefault,
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            contextTokens: e.contextTokens,
            now: new Date().toISOString(),
          };
        },
      },
      messaging: {
        channels: () => this.channels.running(),
        send: (channel, to, text) => this.channels.send(channel, to, text),
        lastRoute: async (key) => {
          const e = (await this.sessions.get(key)) ?? (await this.sessions.get(this.agent.mainKey));
          return e?.lastChannel && e.lastTo ? { channel: e.lastChannel, to: e.lastTo } : undefined;
        },
      },
    };

    this.runner = new AgentRunner({
      agentId: this.agentId,
      config: () => this.cfg,
      workspace: () => this.workspaceDir,
      fsPolicy: () => this.fsPolicy,
      sessions: this.sessions,
      skills: () => this.activeSkills(),
      services,
      log: this.logs.logger('agent'),
      ...(options.modelFactory && { modelFactory: options.modelFactory }),
    });
    this.agent = new AgentService({
      runner: this.runner,
      sessions: this.sessions,
      config: () => this.cfg,
      approvals: this.approvals,
      agentId: this.agentId,
      log: this.logs.logger('agent'),
    });
    this.channels = new ChannelManager({
      config: () => this.cfg,
      agent: this.agent,
      sessions: this.sessions,
      pairing: this.pairing,
      approvals: this.approvals,
      log: this.logs.logger('channels'),
      ...(options.telegramFetch && { telegramFetch: options.telegramFetch }),
      ...(options.telegramApiBase && { telegramApiBase: options.telegramApiBase }),
    });
    const deliver = (channel: string, to: string, text: string) =>
      this.channels.send(channel, to, text);
    this.heartbeat = new HeartbeatRunner({
      config: () => this.cfg,
      workspace: () => this.workspaceDir,
      agent: this.agent,
      sessions: this.sessions,
      deliver,
      log: this.logs.logger('heartbeat'),
    });
    this.cron = new CronService({
      dir: this.paths.cronDir,
      config: () => this.cfg,
      agent: this.agent,
      sessions: this.sessions,
      deliver,
      wakeHeartbeat: (reason) => this.heartbeat.requestNow(reason),
      log: this.logs.logger('cron'),
    });
  }

  static async create(options: RuntimeOptions = {}): Promise<Runtime> {
    const rt = new Runtime(options);
    await rt.config.ensure();
    rt.logs.setLevel(rt.cfg.logging.level);
    await ensureWorkspace(rt.workspaceDir, { skipBootstrap: rt.cfg.agents.defaults.skipBootstrap });
    await rt.approvals.load();
    await rt.projects.load();
    await rt.refreshFsPolicy();
    return rt;
  }

  get cfg(): OpenPulseConfig {
    return this.config.config;
  }

  get workspaceDir(): string {
    const w = this.cfg.agents.defaults.workspace;
    return w ? path.resolve(expandHome(w)) : this.paths.defaultWorkspace;
  }

  /**
   * The filesystem boundary the tools enforce: the agent workspace plus every registered project,
   * widened only by explicit config. Rebuilt whenever config or the project list changes.
   */
  async refreshFsPolicy(): Promise<FsPolicy> {
    const security = this.cfg.security;
    const projectRoots = await this.projects.roots();
    this.fsPolicyValue = new FsPolicy({
      mode: security.mode,
      readRoots: [this.workspaceDir, ...projectRoots, ...security.readRoots],
      writeRoots: [this.workspaceDir, ...projectRoots, ...security.writeRoots],
      denyPatterns: [
        ...DEFAULT_DENY_PATTERNS,
        `${this.paths.stateDir.replaceAll('\\', '/')}/credentials/**`,
        `${this.paths.stateDir.replaceAll('\\', '/')}/identity/**`,
        ...security.denyPatterns,
      ],
    });
    return this.fsPolicyValue;
  }

  get fsPolicy(): FsPolicy {
    return this.fsPolicyValue;
  }

  canonical(key: string | undefined): string {
    return canonicalSessionKey(key ?? 'main', this.agentId, this.cfg.session.mainKey);
  }

  async skillStatus(): Promise<SkillStatus[]> {
    const { skills, errors } = await this.loadAllSkills();
    return [...skills.map((s) => evaluateSkill(s, this.cfg)), ...errors];
  }

  async loadAllSkills() {
    return loadSkills({
      bundled: this.options.bundledSkillsDir ?? BUNDLED_SKILLS_DIR,
      managed: this.paths.managedSkillsDir,
      workspace: path.join(this.workspaceDir, 'skills'),
      extra: this.cfg.skills.load.extraDirs.map((d) => path.resolve(expandHome(d))),
    });
  }

  /** Skills offered to the model: enabled, eligible, not excluded from model invocation. */
  async activeSkills(): Promise<SkillDefinition[]> {
    const { skills } = await this.loadAllSkills();
    return skills.filter((s) => {
      const st = evaluateSkill(s, this.cfg);
      return st.eligible && !st.disabled && !s.disableModelInvocation;
    });
  }

  async start(opts: RuntimeStartOptions = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.config.get().valid) {
      this.log.error('config is invalid — running with defaults', {
        issues: this.config.get().issues,
      });
    }
    this.config.on('change', this.onConfigChange);
    if (this.cfg.gateway.reload.mode !== 'off') this.config.watch();
    if (opts.cron !== false) await this.cron.start();
    if (opts.heartbeat !== false) this.heartbeat.start();
    if (opts.channels !== false) await this.channels.sync();
    this.log.info('runtime started', {
      stateDir: this.paths.stateDir,
      workspace: this.workspaceDir,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.config.off('change', this.onConfigChange);
    this.config.unwatch();
    this.heartbeat.stop();
    this.cron.stop();
    this.agent.abortAll();
    this.approvals.cancelAll();
    this.processes.killAll();
    await this.channels.stopAll();
    await this.browser.stop();
    this.log.info('runtime stopped');
    await this.logs.flush();
  }

  private async applyConfig(): Promise<void> {
    const snap = this.config.get();
    if (!snap.valid) {
      this.log.warn('config changed but is invalid; keeping previous behaviour', {
        issues: snap.issues,
      });
      return;
    }
    this.logs.setLevel(this.cfg.logging.level);
    this.heartbeat.reconfigure();
    await this.refreshFsPolicy();
    await this.channels.sync();
    this.log.info('config reloaded');
  }
}
