import type { OpenPulseConfig } from '../../config/schema.js';
import { createBrowserTool, type BrowserSession } from './browser-tool.js';
import { createExecTool, processTool } from './exec-tools.js';
import { editTool, readTool, writeTool } from './fs-tools.js';
import {
  cronTool,
  memoryGetTool,
  memorySearchTool,
  messageTool,
  sessionsHistoryTool,
  sessionsListTool,
  sessionsSendTool,
  sessionStatusTool,
} from './misc-tools.js';
import type { AnyTool } from './types.js';
import { webFetchTool, webSearchTool } from './web-tools.js';

/** Shorthands usable in tools.allow / tools.deny. */
export const TOOL_GROUPS: Record<string, string[]> = {
  'group:fs': ['read', 'write', 'edit'],
  'group:runtime': ['exec', 'process'],
  'group:web': ['web_search', 'web_fetch'],
  'group:ui': ['browser'],
  'group:automation': ['cron'],
  'group:messaging': ['message'],
  'group:sessions': ['sessions_list', 'sessions_history', 'sessions_send', 'session_status'],
  'group:memory': ['memory_search', 'memory_get'],
};

export interface ToolBuildOptions {
  config: OpenPulseConfig;
  browser: BrowserSession;
  /** Extra names removed for this run (e.g. heartbeat/cron sessions can't message sessions). */
  exclude?: string[];
}

export function buildTools(opts: ToolBuildOptions): AnyTool[] {
  const { config } = opts;
  const all: AnyTool[] = [
    readTool,
    writeTool,
    editTool,
    createExecTool(config.tools.exec.shell),
    processTool,
    ...(config.tools.web.search.enabled &&
    (config.tools.web.search.apiKey || process.env.BRAVE_API_KEY)
      ? [webSearchTool]
      : []),
    ...(config.tools.web.fetch.enabled ? [webFetchTool] : []),
    ...(config.browser.enabled ? [createBrowserTool(opts.browser)] : []),
    cronTool,
    messageTool,
    sessionsListTool,
    sessionsHistoryTool,
    sessionsSendTool,
    sessionStatusTool,
    memorySearchTool,
    memoryGetTool,
  ];
  const allow = config.tools.allow ? expand(config.tools.allow) : undefined;
  const deny = expand([...config.tools.deny, ...(opts.exclude ?? [])]);

  // Security modes: read-only removes everything that can change this machine; custom mode lets an
  // operator switch individual tools off. Filesystem boundaries are enforced inside the tools.
  const security = config.security;
  const writeTools = new Set(['write', 'edit', 'exec', 'process', 'browser']);
  const securityDenied = (name: string): boolean => {
    if (security.mode === 'read-only' && writeTools.has(name)) return true;
    return security.tools[name] === false;
  };

  return all.filter(
    (t) => !matches(deny, t.name) && !securityDenied(t.name) && (!allow || matches(allow, t.name)),
  );
}

function expand(names: string[]): string[] {
  return names.flatMap((n) => TOOL_GROUPS[n.toLowerCase()] ?? [n.toLowerCase()]);
}

function matches(patterns: string[], name: string): boolean {
  return patterns.some(
    (p) => p === '*' || p === name || (p.endsWith('*') && name.startsWith(p.slice(0, -1))),
  );
}
