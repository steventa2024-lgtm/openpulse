import type { OpenPulseConfig } from '../../config/schema.js';
import { createBrowserTool, type BrowserSession } from './browser-tool.js';
import { proposeChangeTool } from './change-tools.js';
import { createExecTool, processTool } from './exec-tools.js';
import { buildMcpTools, type McpToolBridge } from './mcp-tools.js';
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
  'group:fs': ['read', 'write', 'edit', 'propose_change'],
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
  /** Connected MCP servers; their enabled tools join the built-in set. */
  mcp?: McpToolBridge;
  /** Extra names removed for this run (e.g. heartbeat/cron sessions can't message sessions). */
  exclude?: string[];
}

export function buildTools(opts: ToolBuildOptions): AnyTool[] {
  const { config } = opts;
  const all: AnyTool[] = [
    readTool,
    writeTool,
    editTool,
    proposeChangeTool,
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
    ...(opts.mcp ? buildMcpTools(opts.mcp) : []),
  ];
  const allow = config.tools.allow ? expand(config.tools.allow) : undefined;
  const deny = expand([...config.tools.deny, ...(opts.exclude ?? [])]);

  // Security modes: read-only removes everything that can change this machine; custom mode lets an
  // operator switch individual tools off. Filesystem boundaries are enforced inside the tools.
  const security = config.security;
  // propose_change only records a proposal, so it stays available in read-only mode.
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
