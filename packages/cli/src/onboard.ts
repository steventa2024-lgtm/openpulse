import { randomBytes } from 'node:crypto';
import path from 'node:path';
import * as p from '@clack/prompts';
import {
  ConfigStore,
  ensureWorkspace,
  KNOWN_MODELS,
  type OpenPulseConfig,
} from '@openpulse/gateway';
import { statePaths, type GlobalOptions } from './client.js';
import { c } from './palette.js';

export interface OnboardOptions extends GlobalOptions {
  nonInteractive?: boolean;
  workspace?: string;
  gatewayPort?: number;
  gatewayToken?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  telegramToken?: string;
  model?: string;
}

/**
 * First-run wizard: workspace, model provider + key, gateway port/token, optional Telegram.
 * Everything it collects is written to openpulse.json.
 */
export async function onboard(
  options: OnboardOptions,
): Promise<{ configPath: string; token: string }> {
  const paths = statePaths(options);
  const store = new ConfigStore(paths.configPath);
  await store.load();
  const existing = store.get().exists ? store.config : undefined;

  const patch: Record<string, unknown> = {};
  const token =
    options.gatewayToken ?? existing?.gateway.auth.token ?? randomBytes(24).toString('hex');

  if (options.nonInteractive) {
    const workspace =
      options.workspace ?? existing?.agents.defaults.workspace ?? paths.defaultWorkspace;
    Object.assign(patch, {
      agents: {
        defaults: { workspace, ...(options.model && { model: { primary: options.model } }) },
      },
      gateway: {
        port: options.gatewayPort ?? existing?.gateway.port ?? 18789,
        auth: { mode: 'token', token },
      },
      ...(options.anthropicApiKey && {
        models: { providers: { anthropic: { apiKey: options.anthropicApiKey } } },
      }),
      ...(options.openaiApiKey && {
        models: { providers: { openai: { apiKey: options.openaiApiKey } } },
      }),
      ...(options.telegramToken && {
        channels: {
          telegram: { enabled: true, botToken: options.telegramToken, dmPolicy: 'pairing' },
        },
      }),
    });
    await store.patch(patch);
    await ensureWorkspace(workspace);
    return { configPath: store.path, token };
  }

  p.intro(c.accent('OpenPulse onboarding'));
  p.note(
    [
      'OpenPulse runs on this machine with real access to your shell, files and browser.',
      'Only pair people you trust; risky commands pause for your approval.',
    ].join('\n'),
    'Before you start',
  );

  const workspace = String(
    await orCancel(
      p.text({
        message: 'Agent workspace (memory, skills and notes live here)',
        initialValue:
          options.workspace ?? existing?.agents.defaults.workspace ?? paths.defaultWorkspace,
      }),
    ),
  );

  const provider = String(
    await orCancel(
      p.select({
        message: 'Which model provider?',
        initialValue: 'anthropic',
        options: [
          { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'ANTHROPIC_API_KEY' },
          { value: 'openai', label: 'OpenAI', hint: 'OPENAI_API_KEY' },
          { value: 'ollama', label: 'Ollama (local)', hint: 'no key needed' },
          { value: 'lmstudio', label: 'LM Studio (local)', hint: 'no key needed' },
          { value: 'skip', label: 'Configure later' },
        ],
      }),
    ),
  );

  const providers: Record<string, { apiKey?: string }> = {};
  let model = options.model ?? existing?.agents.defaults.model.primary;
  if (provider === 'anthropic' || provider === 'openai') {
    const envKey =
      provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    if (!envKey) {
      const key = String(
        await orCancel(
          p.password({
            message: `${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key (leave empty to use the environment variable)`,
          }),
        ),
      );
      if (key.trim()) providers[provider] = { apiKey: key.trim() };
    } else {
      p.log.info(
        `Using ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} from the environment.`,
      );
    }
    const choices = KNOWN_MODELS.filter((m) => m.provider === provider);
    model = String(
      await orCancel(
        p.select({
          message: 'Default model',
          initialValue: choices[0]?.ref ?? model,
          options: choices.map((m) => ({ value: m.ref, label: m.name, hint: m.ref })),
        }),
      ),
    );
  } else if (provider === 'ollama' || provider === 'lmstudio') {
    model = String(
      await orCancel(
        p.text({
          message: `Model id on ${provider} (must support tool calling)`,
          initialValue: provider === 'ollama' ? 'ollama/qwen3:8b' : 'lmstudio/local-model',
        }),
      ),
    );
    p.log.warn(
      'Local models need a large context window — start Ollama with OLLAMA_CONTEXT_LENGTH=32768 or more.',
    );
  }

  const port = Number(
    await orCancel(
      p.text({
        message: 'Gateway port',
        initialValue: String(options.gatewayPort ?? existing?.gateway.port ?? 18789),
        validate: (v) =>
          Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536
            ? undefined
            : 'Enter a port between 1 and 65535',
      }),
    ),
  );

  const wantsTelegram = Boolean(
    await orCancel(
      p.confirm({
        message: 'Connect Telegram now? (you can do it later from the dashboard)',
        initialValue: false,
      }),
    ),
  );
  let telegram: Record<string, unknown> | undefined;
  if (wantsTelegram) {
    const botToken = String(await orCancel(p.password({ message: 'Bot token from @BotFather' })));
    if (botToken.trim())
      telegram = { enabled: true, botToken: botToken.trim(), dmPolicy: 'pairing' };
    p.note(
      'Message your bot once it is running — it replies with a pairing code to approve with\n  openpulse pairing approve telegram <CODE>',
      'Telegram',
    );
  }

  Object.assign(patch, {
    agents: { defaults: { workspace, ...(model && { model: { primary: model } }) } },
    gateway: { port, auth: { mode: 'token', token } },
    ...(Object.keys(providers).length > 0 && { models: { providers } }),
    ...(telegram && { channels: { telegram } }),
  });

  const spinner = p.spinner();
  spinner.start('Writing configuration');
  await store.patch(patch);
  const created = await ensureWorkspace(workspace);
  spinner.stop(`Configuration written to ${store.path}`);

  p.note(
    [
      `Workspace: ${workspace}${created.created.length ? ` (created ${created.created.join(', ')})` : ''}`,
      `Gateway:   http://127.0.0.1:${port}`,
      `Token:     ${token}`,
    ].join('\n'),
    'Ready',
  );
  p.outro(
    `Start it with ${c.accentBright('openpulse gateway')}, then open the dashboard: ${c.accentBright('openpulse dashboard')}`,
  );
  return { configPath: store.path, token };
}

/** Create the config + workspace without prompting (used by `openpulse setup`). */
export async function setup(
  options: GlobalOptions & { workspace?: string },
): Promise<{ configPath: string; workspace: string; created: string[] }> {
  const paths = statePaths(options);
  const store = new ConfigStore(paths.configPath);
  await store.ensure();
  const workspace =
    options.workspace ?? store.config.agents.defaults.workspace ?? paths.defaultWorkspace;
  if (options.workspace) await store.patch({ agents: { defaults: { workspace } } });
  const result = await ensureWorkspace(path.resolve(workspace));
  return { configPath: store.path, workspace: result.dir, created: result.created };
}

export function describeConfig(cfg: OpenPulseConfig): string {
  return [
    `model:     ${cfg.agents.defaults.model.primary}`,
    `workspace: ${cfg.agents.defaults.workspace ?? '(default)'}`,
    `gateway:   127.0.0.1:${cfg.gateway.port} (auth: ${cfg.gateway.auth.mode})`,
    `heartbeat: ${cfg.agents.defaults.heartbeat.every} → ${cfg.agents.defaults.heartbeat.target}`,
  ].join('\n');
}

async function orCancel<T>(value: Promise<T | symbol>): Promise<T> {
  const result = await value;
  if (p.isCancel(result)) {
    p.cancel('Onboarding cancelled.');
    process.exit(1);
  }
  return result as T;
}
