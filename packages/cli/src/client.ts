import {
  ConfigStore,
  GatewayClient,
  loadOrCreateIdentity,
  resolvePaths,
  resolveStateDir,
  type GatewayClientOptions,
  type StatePaths,
} from '@openpulse/gateway';
import { c } from './palette.js';

export interface GlobalOptions {
  profile?: string;
  url?: string;
  token?: string;
  color?: boolean;
  json?: boolean;
}

export interface Connection {
  client: GatewayClient;
  url: string;
  paths: StatePaths;
}

export function statePaths(opts: GlobalOptions = {}): StatePaths {
  const env = { ...process.env, ...(opts.profile ? { OPENPULSE_PROFILE: opts.profile } : {}) };
  return resolvePaths(resolveStateDir(env), env);
}

/** Read the local config for the gateway URL and token (when not given explicitly). */
export async function localConnection(
  opts: GlobalOptions = {},
): Promise<{ url: string; token?: string; paths: StatePaths }> {
  const paths = statePaths(opts);
  const store = new ConfigStore(paths.configPath);
  await store.load().catch(() => undefined);
  const cfg = store.get?.().valid ? store.config : undefined;
  const port = cfg?.gateway.port ?? 18789;
  const url = opts.url ?? process.env.OPENPULSE_URL ?? `http://127.0.0.1:${port}`;
  const token = opts.token ?? process.env.OPENPULSE_TOKEN ?? cfg?.gateway.auth.token;
  return { url, paths, ...(token !== undefined && { token }) };
}

/** Connect to a running gateway, using this machine's device identity. */
export async function connect(
  opts: GlobalOptions = {},
  extra: Partial<GatewayClientOptions> = {},
): Promise<Connection> {
  const { url, token, paths } = await localConnection(opts);
  const identity = await loadOrCreateIdentity(paths.identityDir);
  const client = new GatewayClient({
    url,
    ...(token !== undefined && { token }),
    identity,
    clientId: 'openpulse-cli',
    mode: 'cli',
    displayName: `cli@${process.env.USERNAME ?? process.env.USER ?? 'local'}`,
    ...extra,
  });
  await client.connect();
  return { client, url, paths };
}

export function explainConnectionError(url: string, error: unknown): string {
  const e = error as { code?: string; message?: string };
  if (e.code === 'PAIRING_REQUIRED') {
    return `${c.warn('Pairing required')} — approve this device on the gateway host:\n  openpulse devices list\n  openpulse devices approve <requestId>`;
  }
  if (e.code === 'UNAUTHORIZED') {
    return `${c.error('Unauthorized')} — the gateway rejected the token.\n  Show it on the gateway host: openpulse config get gateway.auth.token\n  Then retry with --token <token> (or set OPENPULSE_TOKEN).`;
  }
  return `${c.error('Cannot reach the gateway')} at ${url} (${e.message ?? String(error)})\n  Start it with: openpulse gateway`;
}
