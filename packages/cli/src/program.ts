import readline from 'node:readline/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Command, InvalidArgumentError } from 'commander';
import JSON5 from 'json5';
import {
  BUNDLED_SKILLS_DIR,
  ConfigStore,
  GatewayClientError,
  VERSION,
  getPath,
  loadSkills,
  parseDurationMs,
  startGateway,
  type CronJob,
  type CronRunRecord,
  type GatewayClient,
  type SessionEntry,
  type SkillStatus,
} from '@openpulse/gateway';
import {
  connect,
  explainConnectionError,
  localConnection,
  statePaths,
  type GlobalOptions,
} from './client.js';
import { describeConfig, onboard, setup } from './onboard.js';
import { c, relativeTime, setColor, statusDot, table } from './palette.js';
import { runTui } from './tui.js';
import {
  createBackup,
  formatSize,
  listBackups,
  pruneBackups,
  restoreBackup,
} from './backup.js';

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Commander hands action options through untyped; treat them as unknown values. */
type Opts = Record<string, string | number | boolean | undefined>;

/** Thrown for expected failures; main.ts prints the message and exits 1. */
export class CliError extends Error {}

export function createProgram(io: CliIO = defaultIO): Command {
  const program = new Command();

  program
    .name('openpulse')
    .description('OpenPulse — a self-hosted agent that lives in your chats')
    .version(VERSION, '-v, --version')
    .option('--profile <name>', 'state profile (OPENPULSE_PROFILE)')
    .option('--url <url>', 'gateway URL (default: from openpulse.json)')
    .option('--token <token>', 'gateway auth token')
    .option('--json', 'print raw JSON')
    .option('--no-color', 'disable colour')
    .configureOutput({
      writeOut: (str) => io.out(str.replace(/\n$/, '')),
      writeErr: (str) => io.err(str.replace(/\n$/, '')),
    });

  const g = (cmd: Command): GlobalOptions => {
    const opts = cmd.optsWithGlobals();
    if (opts.color === false) setColor(false);
    return opts;
  };

  /** Connect, run, always close. Connection problems become readable CliErrors. */
  const withClient = async <T>(
    cmd: Command,
    fn: (client: GatewayClient) => Promise<T>,
  ): Promise<T> => {
    const opts = g(cmd);
    let conn;
    try {
      conn = await connect(opts);
    } catch (error) {
      const { url } = await localConnection(opts);
      throw new CliError(explainConnectionError(url, error));
    }
    try {
      return await fn(conn.client);
    } catch (error) {
      if (error instanceof GatewayClientError)
        throw new CliError(`${c.error(error.code)} ${error.message}`);
      throw error;
    } finally {
      conn.client.close();
    }
  };

  const emit = (cmd: Command, data: unknown, human: () => string): void => {
    if (g(cmd).json) io.out(JSON.stringify(data, null, 2));
    else io.out(human());
  };

  // ---- onboarding ------------------------------------------------------------------------------
  program
    .command('onboard')
    .description('interactive first-run setup (workspace, model, gateway, channels)')
    .option('--non-interactive', 'take everything from flags and defaults')
    .option('--workspace <dir>', 'agent workspace directory')
    .option('--port <port>', 'gateway port', parsePort)
    .option('--gateway-token <token>', 'use this gateway token instead of generating one')
    .option('--model <ref>', 'default model, e.g. anthropic/claude-opus-5')
    .option('--anthropic-key <key>', 'Anthropic API key')
    .option('--openai-key <key>', 'OpenAI API key')
    .option('--telegram-token <token>', 'Telegram bot token')
    .action(async (opts: Opts, cmd: Command) => {
      const result = await onboard({
        ...g(cmd),
        ...(opts.nonInteractive && { nonInteractive: true }),
        ...(opts.workspace && { workspace: String(opts.workspace) }),
        ...(opts.port !== undefined && { gatewayPort: Number(opts.port) }),
        ...(opts.gatewayToken && { gatewayToken: String(opts.gatewayToken) }),
        ...(opts.model && { model: String(opts.model) }),
        ...(opts.anthropicKey && { anthropicApiKey: String(opts.anthropicKey) }),
        ...(opts.openaiKey && { openaiApiKey: String(opts.openaiKey) }),
        ...(opts.telegramToken && { telegramToken: String(opts.telegramToken) }),
      });
      if (opts.nonInteractive) io.out(`config: ${result.configPath}\ntoken:  ${result.token}`);
    });

  program
    .command('setup')
    .description('create the config file and workspace without prompting')
    .option('--workspace <dir>', 'agent workspace directory')
    .action(async (opts: Opts, cmd: Command) => {
      const r = await setup({
        ...g(cmd),
        ...(opts.workspace && { workspace: String(opts.workspace) }),
      });
      emit(cmd, r, () =>
        [
          `config:    ${r.configPath}`,
          `workspace: ${r.workspace}`,
          r.created.length ? `created:   ${r.created.join(', ')}` : 'workspace already up to date',
        ].join('\n'),
      );
    });

  // ---- status / health / doctor ----------------------------------------------------------------
  const statusAction = async (cmd: Command) => {
    const status = await withClient(cmd, (client) => client.request<StatusResponse>('status'));
    emit(cmd, status, () => {
      const hb = status.heartbeat;
      const rows: (string | undefined)[][] = [
        ['version', `${status.version} (node ${status.node}, ${status.platform})`],
        ['uptime', formatDuration(status.uptimeMs)],
        ['model', status.model],
        ['workspace', status.workspace],
        ['state dir', status.stateDir],
        [
          'config',
          `${status.configPath} ${status.configValid ? c.info('valid') : c.error('invalid')}`,
        ],
        ['sessions', `${status.sessions} (main: ${status.mainSessionKey})`],
        ['connections', String(status.connections)],
        ['active runs', String(status.activeRuns)],
        [
          'approvals',
          status.pendingApprovals ? c.warn(`${status.pendingApprovals} pending`) : '0 pending',
        ],
        [
          'heartbeat',
          !hb.enabled
            ? c.muted('disabled')
            : Number.parseFloat(hb.every) === 0
              ? c.muted(`off (every ${hb.every})`)
              : `every ${hb.every}, next ${relativeTime(hb.nextRunAt)}`,
        ],
        [
          'cron',
          status.cron.enabled
            ? `${status.cron.jobs} jobs, next ${relativeTime(status.cron.nextWakeAtMs)}`
            : c.muted('disabled'),
        ],
        [
          'channels',
          status.channels.length
            ? status.channels
                .map((ch) => `${statusDot(ch.configured ? ch.connected : undefined)} ${ch.id}`)
                .join('  ')
            : c.muted('none configured'),
        ],
      ];
      return table(rows);
    });
  };

  // ---- gateway ---------------------------------------------------------------------------------
  const gateway = program.command('gateway').description('run and inspect the gateway daemon');

  gateway
    .command('run', { isDefault: true })
    .description('run the gateway in the foreground (Ctrl-C to stop)')
    .option('--port <port>', 'override the configured port', parsePort)
    .option('--host <host>', 'bind address (default 127.0.0.1)')
    .option('--no-channels', 'do not start messaging channels')
    .option('--no-cron', 'do not start the cron scheduler')
    .option('--no-heartbeat', 'do not start the heartbeat loop')
    .action(async (opts: Opts, cmd: Command) => {
      const globals = g(cmd);
      const running = await startGateway({
        ...(globals.profile && { env: { ...process.env, OPENPULSE_PROFILE: globals.profile } }),
        ...(opts.port !== undefined && { port: Number(opts.port) }),
        ...(opts.host && { host: String(opts.host) }),
        channels: opts.channels !== false,
        cron: opts.cron !== false,
        heartbeat: opts.heartbeat !== false,
      });
      io.out(
        [
          `${c.accent('OpenPulse')} ${c.muted(`v${VERSION}`)}`,
          `gateway   ${running.url}`,
          `dashboard ${running.url}/`,
          `state     ${running.runtime.paths.stateDir}`,
          describeConfig(running.runtime.cfg),
          c.muted('Ctrl-C to stop.'),
        ].join('\n'),
      );
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        io.out(c.muted('\nshutting down…'));
        void running.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise<never>(() => {});
    });

  gateway
    .command('status')
    .description('show gateway status')
    .action(async (_opts: Opts, cmd: Command) => statusAction(cmd));

  gateway
    .command('call <method> [json]')
    .description('call a gateway RPC method directly')
    .action(async (method: string, json: string | undefined, _opts: Opts, cmd: Command) => {
      const params = json ? JSON5.parse<Record<string, unknown>>(json) : {};
      const result = await withClient(cmd, (client) => client.request(method, params));
      io.out(JSON.stringify(result, null, 2));
    });

  program
    .command('status')
    .description('show gateway status')
    .action(async (_opts: Opts, cmd: Command) => statusAction(cmd));

  program
    .command('health')
    .description('check that the gateway is up (exit code 0/1)')
    .action(async (_opts: Opts, cmd: Command) => {
      const health = await withClient(cmd, (client) => client.request<HealthResponse>('health'));
      emit(
        cmd,
        health,
        () =>
          `${statusDot(health.ok)} ${health.ok ? c.info('healthy') : c.error('unhealthy')} · v${health.version} · up ${formatDuration(health.uptimeMs)}`,
      );
    });

  program
    .command('doctor')
    .description('check local configuration, workspace and gateway reachability')
    .action(async (_opts: Opts, cmd: Command) => {
      const opts = g(cmd);
      const paths = statePaths(opts);
      const store = new ConfigStore(paths.configPath);
      await store.load().catch(() => undefined);
      const snapshot = store.get();
      const checks: { ok: boolean | undefined; label: string; detail: string }[] = [
        { ok: snapshot.exists, label: 'config file', detail: paths.configPath },
        {
          ok: snapshot.valid,
          label: 'config valid',
          detail: snapshot.issues.map((i) => `${i.path}: ${i.message}`).join('; ') || 'no issues',
        },
      ];
      if (snapshot.valid) {
        const cfg = snapshot.config;
        const provider = cfg.agents.defaults.model.primary.split('/')[0] ?? '';
        const keyed =
          provider === 'anthropic'
            ? Boolean(cfg.models.providers.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY)
            : provider === 'openai'
              ? Boolean(cfg.models.providers.openai?.apiKey ?? process.env.OPENAI_API_KEY)
              : true;
        checks.push({
          ok: keyed,
          label: 'model credentials',
          detail: `${cfg.agents.defaults.model.primary}${keyed ? '' : ' — no API key configured'}`,
        });
        const workspace = cfg.agents.defaults.workspace ?? paths.defaultWorkspace;
        const skills = await loadSkills({
          bundled: BUNDLED_SKILLS_DIR,
          workspace: `${workspace}/skills`,
          managed: paths.managedSkillsDir,
        });
        checks.push({
          ok: skills.errors.length === 0,
          label: 'skills',
          detail: `${skills.skills.length} loaded${skills.errors.length ? `, ${skills.errors.length} failed to parse` : ''}`,
        });
      }
      const { url } = await localConnection(opts);
      let reachable = false;
      let detail = url;
      try {
        const conn = await connect(opts);
        reachable = true;
        conn.client.close();
      } catch (error) {
        detail = `${url} — ${(error as Error).message}`;
      }
      checks.push({ ok: reachable, label: 'gateway', detail });
      emit(cmd, { checks }, () =>
        checks
          .map((x) => `${statusDot(x.ok)} ${x.label.padEnd(18)} ${c.muted(x.detail)}`)
          .join('\n'),
      );
      if (checks.some((x) => x.ok === false)) process.exitCode = 1;
    });

  // ---- dashboard -------------------------------------------------------------------------------
  program
    .command('dashboard')
    .description('open the Control UI in your browser')
    .option('--no-open', 'print the URL instead of opening a browser')
    .action(async (opts: Opts, cmd: Command) => {
      const { url } = await localConnection(g(cmd));
      io.out(`${c.accent('Control UI')} ${url}`);
      if (opts.open !== false) openBrowser(url);
    });

  // ---- chat ------------------------------------------------------------------------------------
  program
    .command('tui')
    .alias('chat')
    .description('interactive chat with the agent')
    .option('-s, --session <key>', 'session key', 'main')
    .option('--verbose', 'show tool activity')
    .action(async (opts: Opts, cmd: Command) => {
      const globals = g(cmd);
      let conn;
      try {
        conn = await connect(globals);
      } catch (error) {
        const { url } = await localConnection(globals);
        throw new CliError(explainConnectionError(url, error));
      }
      const { sessionKey } = await conn.client.request<{ sessionKey: string }>('chat.history', {
        sessionKey: String(opts.session),
        limit: 1,
      });
      try {
        await runTui({ client: conn.client, sessionKey, verbose: Boolean(opts.verbose) });
      } finally {
        conn.client.close();
      }
    });

  program
    .command('agent')
    .description('run one agent turn and print the reply')
    .requiredOption('-m, --message <text>', 'message to send')
    .option('-s, --session <key>', 'session key', 'main')
    .option('--deliver <channel:to>', 'also deliver the reply to a channel target')
    .action(async (opts: Opts, cmd: Command) => {
      const [channel, ...rest] = String(opts.deliver ?? '').split(':');
      const result = await withClient(cmd, (client) =>
        client.request<{ text: string; status: string }>(
          'agent',
          {
            sessionKey: String(opts.session),
            message: String(opts.message),
            ...(opts.deliver && { deliver: true, channel, to: rest.join(':') }),
          },
          600_000,
        ),
      );
      emit(cmd, result, () => result.text || c.muted('(no reply)'));
    });

  // ---- sessions --------------------------------------------------------------------------------
  const sessions = program.command('sessions').description('inspect agent sessions');

  sessions
    .command('list', { isDefault: true })
    .description('list sessions')
    .option('--active <minutes>', 'only sessions touched in the last N minutes', (v) => Number(v))
    .option('--limit <n>', 'maximum rows', (v) => Number(v), 50)
    .action(async (opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<{ sessions: (SessionEntry & { key: string; running: boolean })[] }>(
          'sessions.list',
          {
            limit: Number(opts.limit),
            ...(opts.active !== undefined && { activeMinutes: Number(opts.active) }),
          },
        ),
      );
      emit(cmd, data, () =>
        data.sessions.length === 0
          ? c.muted('no sessions yet')
          : table(
              data.sessions.map((s) => [
                statusDot(s.running ? true : undefined),
                s.key,
                s.chatType,
                `${s.totalTokens} tok`,
                relativeTime(s.updatedAt),
              ]),
              ['', 'KEY', 'TYPE', 'TOKENS', 'UPDATED'],
            ),
      );
    });

  sessions
    .command('reset <key>')
    .description('start a fresh transcript for a session')
    .action(async (key: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<{ sessionId: string }>('sessions.reset', { key }),
      );
      emit(cmd, r, () => `${c.info('reset')} ${key} → ${r.sessionId}`);
    });

  sessions
    .command('delete <key>')
    .description('delete a session')
    .option('--transcript', 'also delete the transcript file')
    .action(async (key: string, opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<{ deleted: boolean }>('sessions.delete', {
          key,
          deleteTranscript: Boolean(opts.transcript),
        }),
      );
      emit(cmd, r, () =>
        r.deleted ? `${c.info('deleted')} ${key}` : c.muted(`no such session: ${key}`),
      );
    });

  // ---- channels & pairing ----------------------------------------------------------------------

  // ---- session routes ---------------------------------------------------------------------------
  const routes = sessions
    .command('routes')
    .description('pin a chat to a named session (overrides dmScope)');

  routes
    .command('list')
    .description('show all chat → session routes')
    .action(async function (this: Command) {
      await withClient(this, async (client) => {
        const data = await client.request<{ routes: { route: string; sessionKey: string }[] }>(
          'session.routes.list',
        );
        if (data.routes.length === 0) {
          c.info('no routes set — all chats use the default session');
          return;
        }
        for (const r of data.routes) {
          c.info(`${r.route}  →  ${r.sessionKey}`);
        }
      });
    });

  routes
    .command('set <channel> <chatId> <slug>')
    .description('route a chat to a named session (use "main" to reset)')
    .action(async function (this: Command, channel: string, chatId: string, slug: string) {
      await withClient(this, async (client) => {
        const sessionKey = slug === 'main' ? null : `agent:main:s:${slug.toLowerCase()}`;
        await client.request('session.routes.set', { channel, chatId, sessionKey });
        c.info(sessionKey ? `routed ${channel}:${chatId} → ${sessionKey}` : `cleared route for ${channel}:${chatId}`);
      });
    });

  routes
    .command('clear')
    .description('remove all chat routes')
    .action(async function (this: Command) {
      await withClient(this, async (client) => {
        await client.request('session.routes.clear');
        c.info('all routes cleared');
      });
    });

  const channels = program.command('channels').description('messaging channels');

  channels
    .command('status', { isDefault: true })
    .description('show channel status')
    .option('--probe', 'ask each channel to verify its credentials')
    .action(async (opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<{ channels: ChannelRow[]; probes: Record<string, unknown> }>(
          'channels.status',
          { probe: Boolean(opts.probe) },
        ),
      );
      emit(cmd, data, () =>
        data.channels.length === 0
          ? c.muted('no channels configured')
          : table(
              data.channels.map((ch) => [
                statusDot(ch.configured ? ch.connected : undefined),
                ch.id,
                ch.configured
                  ? ch.running
                    ? ch.connected
                      ? 'connected'
                      : 'starting'
                    : 'stopped'
                  : 'not configured',
                ch.accountName ?? '',
                ch.lastError
                  ? c.error(ch.lastError)
                  : ch.lastInboundAt
                    ? `in ${relativeTime(ch.lastInboundAt)}`
                    : '',
              ]),
              ['', 'CHANNEL', 'STATE', 'ACCOUNT', 'NOTE'],
            ),
      );
    });

  const pairing = program.command('pairing').description('approve people who message the bot');

  pairing
    .command('list [channel]')
    .description('list pending pairing codes and allowed users')
    .action(async (channel = 'telegram', _opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<PairingList>('channels.pairing.list', { channel }),
      );
      emit(cmd, data, () =>
        [
          data.requests.length
            ? table(
                data.requests.map((r) => [
                  c.accentBright(r.code),
                  r.userId,
                  r.name ?? '',
                  relativeTime(r.createdAt),
                ]),
                ['CODE', 'USER', 'NAME', 'REQUESTED'],
              )
            : c.muted('no pending pairing requests'),
          '',
          data.allowFrom.length
            ? `${c.bold('allowed')}: ${data.allowFrom.join(', ')}`
            : c.muted('no users paired yet'),
        ].join('\n'),
      );
    });

  pairing
    .command('approve <channel> <code>')
    .description('approve a pairing code')
    .action(async (channel: string, code: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<{ userId: string }>('channels.pairing.approve', {
          channel,
          code: code.toUpperCase(),
        }),
      );
      emit(cmd, r, () => `${c.info('paired')} ${channel}:${r.userId}`);
    });

  pairing
    .command('reject <channel> <code>')
    .description('reject a pairing code')
    .action(async (channel: string, code: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<{ rejected: boolean }>('channels.pairing.reject', {
          channel,
          code: code.toUpperCase(),
        }),
      );
      emit(cmd, r, () =>
        r.rejected ? `${c.info('rejected')} ${code}` : c.muted('no such pairing code'),
      );
    });

  pairing
    .command('revoke <channel> <userId>')
    .description('remove a paired user')
    .action(async (channel: string, userId: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request('channels.allow.remove', { channel, userId }),
      );
      emit(cmd, r, () => `${c.info('revoked')} ${channel}:${userId}`);
    });

  // ---- devices ---------------------------------------------------------------------------------
  const devices = program
    .command('devices')
    .description('paired control devices (CLI, browsers, nodes)');

  devices
    .command('list', { isDefault: true })
    .description('list paired devices and pending requests')
    .action(async (_opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<DeviceList>('device.pair.list'),
      );
      emit(cmd, data, () =>
        [
          data.pending.length
            ? table(
                data.pending.map((p) => [
                  c.accentBright(p.requestId),
                  p.deviceId.slice(0, 12),
                  p.displayName ?? p.clientId ?? '-',
                  relativeTime(p.ts),
                ]),
                ['REQUEST', 'DEVICE', 'NAME', 'ASKED'],
              )
            : c.muted('no pending device requests'),
          '',
          data.paired.length
            ? table(
                data.paired.map((d) => [
                  d.deviceId.slice(0, 12),
                  d.displayName ?? d.clientId ?? '-',
                  d.role,
                  relativeTime(d.lastSeenAtMs),
                ]),
                ['DEVICE', 'NAME', 'ROLE', 'LAST SEEN'],
              )
            : c.muted('no paired devices'),
        ].join('\n'),
      );
    });

  devices
    .command('approve <requestId>')
    .description('approve a device pairing request')
    .action(async (requestId: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<{ deviceId: string }>('device.pair.approve', { requestId }),
      );
      emit(cmd, r, () => `${c.info('approved')} ${r.deviceId}`);
    });

  devices
    .command('reject <requestId>')
    .description('reject a device pairing request')
    .action(async (requestId: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<{ rejected: boolean }>('device.pair.reject', { requestId }),
      );
      emit(cmd, r, () =>
        r.rejected ? `${c.info('rejected')} ${requestId}` : c.muted('no such request'),
      );
    });

  devices
    .command('remove <deviceId>')
    .description('unpair a device')
    .action(async (deviceId: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<{ removed: boolean }>('device.pair.remove', { deviceId }),
      );
      emit(cmd, r, () =>
        r.removed ? `${c.info('removed')} ${deviceId}` : c.muted('no such device'),
      );
    });

  // ---- cron ------------------------------------------------------------------------------------
  const cron = program.command('cron').description('scheduled jobs');

  cron
    .command('list', { isDefault: true })
    .description('list cron jobs')
    .action(async (_opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<{ jobs: CronJob[] }>('cron.list'),
      );
      emit(cmd, data, () =>
        data.jobs.length === 0
          ? c.muted('no cron jobs')
          : table(
              data.jobs.map((j) => [
                statusDot(j.enabled ? j.state.lastStatus !== 'error' : undefined),
                j.jobId.slice(0, 8),
                j.name,
                describeSchedule(j),
                j.sessionTarget,
                j.state.nextRunAtMs ? relativeTime(j.state.nextRunAtMs) : c.muted('—'),
              ]),
              ['', 'ID', 'NAME', 'SCHEDULE', 'TARGET', 'NEXT RUN'],
            ),
      );
    });

  cron
    .command('add <name>')
    .description('add a cron job')
    .option('--every <duration>', 'run every duration, e.g. 30m, 2h')
    .option('--at <iso>', 'run once at an ISO timestamp')
    .option('--cron <expr>', 'cron expression, e.g. "0 9 * * *"')
    .option('--tz <zone>', 'timezone for --cron')
    .option('--message <text>', 'prompt (isolated) or system note (main)', 'Check in.')
    .option('--isolated', 'run in its own session instead of the main one')
    .option('--announce <channel:to>', 'deliver the result to a channel (isolated jobs only)')
    .option('--disabled', 'create the job disabled')
    .action(async (name: string, opts: Opts, cmd: Command) => {
      const schedule = opts.every
        ? { kind: 'every' as const, everyMs: parseDurationMs(String(opts.every)) }
        : opts.at
          ? { kind: 'at' as const, at: String(opts.at) }
          : opts.cron
            ? {
                kind: 'cron' as const,
                expr: String(opts.cron),
                ...(opts.tz && { tz: String(opts.tz) }),
              }
            : undefined;
      if (!schedule) throw new CliError('One of --every, --at or --cron is required.');
      const isolated = Boolean(opts.isolated);
      const [channel, ...rest] = String(opts.announce ?? '').split(':');
      const job = {
        name,
        enabled: !opts.disabled,
        schedule,
        sessionTarget: isolated ? 'isolated' : 'main',
        payload: isolated
          ? { kind: 'agentTurn', message: String(opts.message) }
          : { kind: 'systemEvent', text: String(opts.message) },
        ...(opts.announce &&
          isolated && { delivery: { mode: 'announce', channel, to: rest.join(':') } }),
      };
      const r = await withClient(cmd, (client) => client.request<CronJob>('cron.add', { job }));
      emit(
        cmd,
        r,
        () =>
          `${c.info('added')} ${r.jobId} ${r.name} — next ${relativeTime(r.state.nextRunAtMs)}`,
      );
    });

  cron
    .command('rm <jobId>')
    .description('delete a cron job')
    .action(async (jobId: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) => client.request('cron.remove', { jobId }));
      emit(cmd, r, () => `${c.info('removed')} ${jobId}`);
    });

  for (const [verb, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    cron
      .command(`${verb} <jobId>`)
      .description(`${verb} a cron job`)
      .action(async (jobId: string, _opts: Opts, cmd: Command) => {
        const r = await withClient(cmd, (client) =>
          client.request('cron.update', { jobId, patch: { enabled } }),
        );
        emit(cmd, r, () => `${c.info(`${verb}d`)} ${jobId}`);
      });
  }

  cron
    .command('run <jobId>')
    .description('run a cron job now')
    .action(async (jobId: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) => client.request('cron.run', { jobId }, 600_000));
      emit(cmd, r, () => `${c.info('ran')} ${jobId}`);
    });

  cron
    .command('runs <jobId>')
    .description('show recent runs of a cron job')
    .option('--limit <n>', 'maximum rows', (v) => Number(v), 20)
    .action(async (jobId: string, opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<{ runs: CronRunRecord[] }>('cron.runs', {
          jobId,
          limit: Number(opts.limit),
        }),
      );
      emit(cmd, data, () =>
        data.runs.length === 0
          ? c.muted('no runs recorded')
          : table(
              data.runs.map((r) => [
                statusDot(r.status === 'ok'),
                new Date(r.ts).toISOString(),
                r.status,
                r.error ?? r.summary ?? '',
              ]),
              ['', 'WHEN', 'STATUS', 'DETAIL'],
            ),
      );
    });

  // ---- skills ----------------------------------------------------------------------------------
  const skills = program.command('skills').description('agent skills');

  skills
    .command('list', { isDefault: true })
    .description('list skills and whether their requirements are met')
    .action(async (_opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<{ skills: SkillStatus[] }>('skills.status'),
      );
      emit(cmd, data, () =>
        data.skills.length === 0
          ? c.muted('no skills found')
          : table(
              data.skills.map((s) => [
                statusDot(s.disabled ? undefined : s.eligible),
                s.name,
                s.source,
                s.disabled
                  ? c.muted('disabled')
                  : s.eligible
                    ? c.info('ready')
                    : c.warn(missingSummary(s)),
                s.description.slice(0, 60),
              ]),
              ['', 'SKILL', 'SOURCE', 'STATE', 'DESCRIPTION'],
            ),
      );
    });

  skills
    .command('info <name>')
    .description('show one skill in detail')
    .action(async (name: string, _opts: Opts, cmd: Command) => {
      const data = await withClient(cmd, (client) =>
        client.request<{ skills: SkillStatus[] }>('skills.status'),
      );
      const skill = data.skills.find((s) => s.name === name);
      if (!skill) throw new CliError(`No skill named ${name}. Run "openpulse skills list".`);
      emit(cmd, skill, () =>
        table([
          ['name', skill.name],
          ['description', skill.description],
          ['source', skill.source],
          ['file', skill.filePath],
          ['state', skill.disabled ? 'disabled' : skill.eligible ? 'ready' : missingSummary(skill)],
          ['user invocable', skill.userInvocable ? 'yes' : 'no'],
          [
            'api key',
            skill.primaryEnv
              ? skill.hasApiKey
                ? 'configured'
                : `missing (${skill.primaryEnv})`
              : '—',
          ],
          ...(skill.error ? [['error', c.error(skill.error)]] : []),
        ]),
      );
    });

  skills
    .command('enable <name>')
    .description('enable a skill')
    .action(async (name: string, _opts: Opts, cmd: Command) => {
      await withClient(cmd, (client) => client.request('skills.update', { name, enabled: true }));
      io.out(`${c.info('enabled')} ${name}`);
    });

  skills
    .command('disable <name>')
    .description('disable a skill')
    .action(async (name: string, _opts: Opts, cmd: Command) => {
      await withClient(cmd, (client) => client.request('skills.update', { name, enabled: false }));
      io.out(`${c.info('disabled')} ${name}`);
    });

  // ---- approvals -------------------------------------------------------------------------------

  // ---- backup -----------------------------------------------------------------------------------
  const backup = program
    .command('backup')
    .description('create, list, restore, and prune state backups');

  backup
    .command('create')
    .description('create a new backup tarball')
    .option('--output <dir>', 'output directory (default: <state>/backups)')
    .option('--keep <n>', 'delete older backups, keeping the N most recent', (v: string) => Number(v))
    .action(async function (this: Command, opts: { output?: string; keep?: number }) {
      try {
        const file = await createBackup({ outputDir: opts.output });
        io.out(c.info(`backup created: ${file}`));
        if (opts.keep && opts.keep > 0) {
          const removed = await pruneBackups(opts.keep);
          if (removed.length) io.out(c.info(`pruned ${removed.length} old backup(s)`));
        }
      } catch (e) {
        io.err(`backup create failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  backup
    .command('list')
    .description('list existing backups')
    .action(async function (this: Command) {
      const all = await listBackups();
      if (all.length === 0) {
        io.out(c.info('no backups yet — run `openpulse backup create`'));
        return;
      }
      for (const b of all) {
        const when = new Date(b.createdAt).toLocaleString();
        io.out(c.info(`${path.basename(b.file)}  ·  ${formatSize(b.sizeBytes)}  ·  ${when}`));
      }
    });

  backup
    .command('restore <file>')
    .description('restore from a backup tarball (moves current state aside first)')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async function (this: Command, file: string, opts: { yes?: boolean }) {
      if (!opts.yes) {
        io.out(c.warn('This will move your current state aside and replace it with the backup.'));
        io.out(c.warn('The current state will be saved to <state>.pre-restore-<timestamp>.'));
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
        rl.close();
        if (answer !== 'y' && answer !== 'yes') {
          io.out(c.info('cancelled'));
          return;
        }
      }
      try {
        const { restoredFrom, savedTo } = await restoreBackup(path.resolve(file));
        io.out(c.info(`restored from ${restoredFrom}`));
        io.out(c.info(`previous state saved to ${savedTo}`));
        io.out(c.warn('Restart the gateway for the restored config to take effect.'));
      } catch (e) {
        io.err(`restore failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  backup
    .command('prune')
    .description('delete old backups, keeping the N most recent')
    .requiredOption('--keep <n>', 'number of backups to keep', (v: string) => Number(v))
    .action(async function (this: Command, opts: { keep: number }) {
      const removed = await pruneBackups(opts.keep);
      if (removed.length === 0) {
        io.out(c.info(`nothing to prune — fewer than ${opts.keep} backups exist`));
        return;
      }
      for (const f of removed) io.out(c.info(`deleted ${path.basename(f)}`));
      io.out(c.info(`pruned ${removed.length} backup(s)`));
    });

  // ---- config ----------------------------------------------------------------------------------
  const config = program.command('config').description('read and write openpulse.json');

  config
    .command('get [path]')
    .description('print the config, or one dotted path')
    .action(async (dotted: string | undefined, _opts: Opts, cmd: Command) => {
      const snapshot = await withClient(cmd, (client) =>
        client.request<ConfigSnapshotWire>('config.get'),
      );
      const value = dotted ? getPath(snapshot.config, dotted) : snapshot.config;
      if (value === undefined) throw new CliError(`No such config path: ${dotted}`);
      io.out(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    });

  config
    .command('set <path> <value>')
    .description('set a dotted config path (value is parsed as JSON5, else kept as a string)')
    .action(async (dotted: string, value: string, _opts: Opts, cmd: Command) => {
      let parsed: unknown;
      try {
        parsed = JSON5.parse(value);
      } catch {
        parsed = value;
      }
      const r = await withClient(cmd, (client) =>
        client.request<{ valid: boolean }>('config.patch', { path: dotted, value: parsed }),
      );
      emit(cmd, r, () => `${c.info('set')} ${dotted} = ${JSON.stringify(parsed)}`);
    });

  config
    .command('unset <path>')
    .description('remove a dotted config path (restores the default)')
    .action(async (dotted: string, _opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request('config.patch', { path: dotted, value: null }),
      );
      emit(cmd, r, () => `${c.info('unset')} ${dotted}`);
    });

  config
    .command('path')
    .description('print the config file path')
    .action((_opts: Opts, cmd: Command) => io.out(statePaths(g(cmd)).configPath));

  // ---- messaging -------------------------------------------------------------------------------
  const message = program.command('message').description('send messages through a channel');

  message
    .command('send <channel> <to> <text...>')
    .description('send a message as the agent')
    .action(async (channel: string, to: string, text: string[], _opts: Opts, cmd: Command) => {
      await withClient(cmd, (client) =>
        client.request('send', { channel, to, message: text.join(' ') }),
      );
      io.out(`${c.info('sent')} → ${channel}:${to}`);
    });

  // ---- system / heartbeat ----------------------------------------------------------------------
  const system = program.command('system').description('runtime controls');
  const heartbeat = system.command('heartbeat').description('the periodic self-check loop');

  heartbeat
    .command('last', { isDefault: true })
    .description('show the last heartbeat')
    .action(async (_opts: Opts, cmd: Command) => {
      const last = await withClient(cmd, (client) =>
        client.request<HeartbeatEventWire | null>('last-heartbeat'),
      );
      emit(cmd, last, () =>
        last
          ? table([
              ['when', `${new Date(last.ts).toISOString()} (${relativeTime(last.ts)})`],
              ['status', last.status],
              ['trigger', last.trigger],
              ['reason', last.reason ?? '—'],
              ['preview', last.preview ?? '—'],
            ])
          : c.muted('no heartbeat yet'),
      );
    });

  heartbeat
    .command('run')
    .description('run a heartbeat now')
    .action(async (_opts: Opts, cmd: Command) => {
      const r = await withClient(cmd, (client) =>
        client.request<HeartbeatEventWire>('heartbeat.run', {}, 600_000),
      );
      emit(
        cmd,
        r,
        () =>
          `${statusDot(r.status !== 'failed')} ${r.status}${r.reason ? ` — ${r.reason}` : r.preview ? ` — ${r.preview}` : ''}`,
      );
    });

  for (const [verb, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    heartbeat
      .command(verb)
      .description(`${verb} heartbeats`)
      .action(async (_opts: Opts, cmd: Command) => {
        await withClient(cmd, (client) => client.request('set-heartbeats', { enabled }));
        io.out(c.info(`heartbeats ${verb}d`));
      });
  }

  system
    .command('wake [text...]')
    .description('wake the agent now, optionally with a note')
    .action(async (text: string[] | undefined, _opts: Opts, cmd: Command) => {
      await withClient(cmd, (client) =>
        client.request('wake', { ...(text?.length && { text: text.join(' ') }) }),
      );
      io.out(c.info('woken'));
    });

  // ---- logs ------------------------------------------------------------------------------------
  program
    .command('logs')
    .description('show gateway logs')
    .option('-f, --follow', 'keep streaming new lines')
    .option('-n, --limit <n>', 'lines to show', (v) => Number(v), 200)
    .option('--level <level>', 'minimum level (debug|info|warn|error)')
    .action(async (opts: Opts, cmd: Command) => {
      const globals = g(cmd);
      let conn;
      try {
        conn = await connect(globals);
      } catch (error) {
        const { url } = await localConnection(globals);
        throw new CliError(explainConnectionError(url, error));
      }
      const order = ['trace', 'debug', 'info', 'warn', 'error'];
      const min = opts.level ? order.indexOf(String(opts.level)) : 0;
      const show = (lines: string[]) => {
        for (const line of lines) {
          const record = safeParse(line);
          if (!record) continue;
          if (order.indexOf(record.level) < min) continue;
          io.out(globals.json ? line : formatLog(record));
        }
      };
      try {
        let tail = await conn.client.request<LogTailWire>('logs.tail', {
          limit: Number(opts.limit),
        });
        show(tail.lines);
        while (opts.follow) {
          await delay(1000);
          tail = await conn.client.request<LogTailWire>('logs.tail', {
            cursor: tail.cursor,
            limit: 500,
          });
          show(tail.lines);
        }
      } finally {
        conn.client.close();
      }
    });

  return program;
}

// ---- wire shapes -------------------------------------------------------------------------------

interface StatusResponse {
  version: string;
  uptimeMs: number;
  configValid: boolean;
  configPath: string;
  stateDir: string;
  workspace: string;
  model: string;
  mainSessionKey: string;
  sessions: number;
  connections: number;
  activeRuns: number;
  pendingApprovals: number;
  node: string;
  platform: string;
  heartbeat: { enabled: boolean; every: string; nextRunAt: number | null };
  cron: { enabled: boolean; jobs: number; nextWakeAtMs: number | null };
  channels: ChannelRow[];
}

interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
}

interface ChannelRow {
  id: string;
  configured: boolean;
  running: boolean;
  connected: boolean;
  accountName?: string;
  lastError?: string;
  lastInboundAt?: number;
}

interface PairingList {
  requests: {
    code: string;
    userId: string;
    name?: string;
    createdAt: number;
    lastSeenAt: number;
  }[];
  allowFrom: string[];
}

interface DeviceList {
  pending: {
    requestId: string;
    deviceId: string;
    clientId?: string;
    displayName?: string;
    remoteIp?: string;
    role: string;
    ts: number;
  }[];
  paired: {
    deviceId: string;
    clientId?: string;
    displayName?: string;
    role: string;
    approvedAtMs: number;
    lastSeenAtMs?: number;
  }[];
}

interface ApprovalsFile {
  path: string;
  file: {
    version: number;
    defaults: {
      security: string;
      ask: string;
      askFallback: string;
      autoAllowSafe: boolean;
      timeoutSeconds: number;
    };
    agents: Record<string, { allowlist: { id: string; pattern: string; lastUsedAt?: number }[] }>;
  };
}

interface PendingApproval {
  id: string;
  createdAtMs: number;
  request: { command: string; risk: { level: string; reason: string } };
}

interface ConfigSnapshotWire {
  config: unknown;
}

interface HeartbeatEventWire {
  ts: number;
  status: string;
  trigger: string;
  reason?: string;
  preview?: string;
  durationMs?: number;
}

interface LogTailWire {
  cursor: number;
  lines: string[];
}

interface LogLine {
  time: string;
  level: string;
  subsystem: string;
  msg: string;
}

// ---- formatting --------------------------------------------------------------------------------

const LEVEL_COLOR: Record<string, (s: string) => string> = {
  trace: c.muted,
  debug: c.muted,
  info: c.info,
  warn: c.warn,
  error: c.error,
};

function formatLog(record: LogLine): string {
  const paint = LEVEL_COLOR[record.level] ?? ((s: string) => s);
  const time = new Date(record.time).toLocaleTimeString([], { hour12: false });
  return `${c.muted(time)} ${paint(record.level.toUpperCase().padEnd(5))} ${c.bold(record.subsystem.padEnd(10))} ${record.msg}`;
}

function safeParse(line: string): LogLine | undefined {
  try {
    return JSON.parse(line) as LogLine;
  } catch {
    return undefined;
  }
}

function describeSchedule(job: CronJob): string {
  const s = job.schedule;
  if (s.kind === 'every') return `every ${formatDuration(s.everyMs)}`;
  if (s.kind === 'at') return `at ${s.at}`;
  return `cron ${s.expr}${s.tz ? ` ${s.tz}` : ''}`;
}

function missingSummary(skill: SkillStatus): string {
  const parts: string[] = [];
  if (skill.missing.bins.length) parts.push(`needs ${skill.missing.bins.join(', ')}`);
  if (skill.missing.anyBins.length) parts.push(`needs one of ${skill.missing.anyBins.join('/')}`);
  if (skill.missing.env.length) parts.push(`set ${skill.missing.env.join(', ')}`);
  if (skill.missing.config.length) parts.push(`configure ${skill.missing.config.join(', ')}`);
  if (skill.missing.os.length) parts.push(`${skill.missing.os.join('/')} only`);
  return parts.join('; ') || 'unavailable';
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new InvalidArgumentError('Port must be an integer between 1 and 65535.');
  return port;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
