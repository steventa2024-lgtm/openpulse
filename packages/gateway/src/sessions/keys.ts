export type DmScope = 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';

export const DEFAULT_AGENT_ID = 'main';

export function mainSessionKey(agentId = DEFAULT_AGENT_ID, mainKey = 'main'): string {
  return `agent:${agentId}:${mainKey}`;
}

export function namedSessionKey(slug: string, agentId = DEFAULT_AGENT_ID): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) throw new Error('named session slug cannot be empty');
  return `agent:${agentId}:s:${s}`;
}

export function isNamedSessionKey(key: string): boolean {
  return /^agent:[^:]+:s:[a-z0-9-]+$/.test(key);
}

export interface InboundRoute {
  agentId?: string;
  channel: string;
  accountId?: string;
  peerKind: 'dm' | 'group';
  /** Sender id for DMs, chat id for groups. */
  peerId: string;
  threadId?: string;
}

/**
 * Map an inbound message to its session key:
 *   DMs follow session.dmScope (default: everyone shares the main session),
 *   groups are always isolated per group (and per topic).
 */
export function resolveSessionKey(
  route: InboundRoute,
  opts: { dmScope: DmScope; mainKey?: string },
): string {
  const agent = route.agentId ?? DEFAULT_AGENT_ID;
  const peer = sanitize(route.peerId);
  if (route.peerKind === 'group') {
    const base = `agent:${agent}:${route.channel}:group:${peer}`;
    return route.threadId ? `${base}:topic:${sanitize(route.threadId)}` : base;
  }
  switch (opts.dmScope) {
    case 'main':
      return mainSessionKey(agent, opts.mainKey);
    case 'per-peer':
      return `agent:${agent}:dm:${peer}`;
    case 'per-channel-peer':
      return `agent:${agent}:${route.channel}:dm:${peer}`;
    case 'per-account-channel-peer':
      return `agent:${agent}:${route.channel}:${sanitize(route.accountId ?? 'default')}:dm:${peer}`;
  }
}

export function cronSessionKey(jobId: string, agentId = DEFAULT_AGENT_ID): string {
  return `agent:${agentId}:cron:${sanitize(jobId)}`;
}

/**
 * Accept shorthand keys from UIs/CLIs: "main" → agent:main:main, "telegram:dm:42" →
 * agent:main:telegram:dm:42. Fully-qualified keys pass through.
 */
export function canonicalSessionKey(
  key: string,
  agentId = DEFAULT_AGENT_ID,
  mainKey = 'main',
): string {
  const k = key.trim();
  if (k === '' || k === 'main' || k === mainKey) return mainSessionKey(agentId, mainKey);
  if (k.startsWith('agent:')) return k;
  return `agent:${agentId}:${k}`;
}

export function parseSessionKey(key: string): {
  agentId: string;
  rest: string;
  kind: 'main' | 'direct' | 'group' | 'cron' | 'named' | 'other';
} {
  const m = /^agent:([^:]+):(.+)$/.exec(key);
  if (!m) return { agentId: DEFAULT_AGENT_ID, rest: key, kind: 'other' };
  const rest = m[2]!;
  const kind =
    rest === 'main'
      ? 'main'
      : rest.startsWith('s:')
        ? 'named'
        : rest.includes(':group:')
          ? 'group'
          : rest.startsWith('cron:')
            ? 'cron'
            : rest.includes('dm:')
              ? 'direct'
              : 'other';
  return { agentId: m[1]!, rest, kind };
}

function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_.@+-]/g, '_');
}
