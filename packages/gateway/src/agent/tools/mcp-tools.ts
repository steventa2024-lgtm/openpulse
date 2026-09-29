import { renderToolResult, type McpToolResult } from '../../mcp/client.js';
import type { McpToolStatus } from '../../mcp/manager.js';
import type { AnyTool, JsonObjectSchema, ToolContext, ToolResult } from './types.js';

export interface McpToolBridge {
  /** Tools from connected servers that the config leaves enabled. */
  activeTools(): (McpToolStatus & { trust: 'ask' | 'allow'; serverLabel: string })[];
  callTool(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

/**
 * Wrap the MCP tools a server offers as agent tools.
 *
 * The schema the server advertises is passed to the model unchanged, so tools behave as their
 * authors intended. Servers marked "ask" route every call through the same approval flow as shell
 * commands, which means an MCP tool cannot quietly act on this machine.
 */
export function buildMcpTools(bridge: McpToolBridge): AnyTool[] {
  return bridge.activeTools().map((tool) => mcpTool(bridge, tool));
}

function mcpTool(
  bridge: McpToolBridge,
  tool: McpToolStatus & { trust: 'ask' | 'allow'; serverLabel: string },
): AnyTool {
  const schema = normaliseSchema(tool.inputSchema);
  return {
    name: tool.qualifiedName,
    description: `${tool.description ?? tool.name} (from the "${tool.serverLabel}" MCP server)`,
    inputSchema: schema,
    parseInput: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    summarize: (input: unknown) => `${tool.serverLabel}: ${tool.name}${summariseArgs(input)}`,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = (input ?? {}) as Record<string, unknown>;

      if (tool.trust === 'ask') {
        const resolved = await ctx.services.approvals.request(
          {
            command: `mcp ${tool.serverId}/${tool.name} ${JSON.stringify(args).slice(0, 500)}`,
            cwd: ctx.workspace,
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
            risk: {
              level: 'medium',
              reason: `calls the "${tool.serverLabel}" MCP server, which runs outside OpenPulse`,
            },
          },
          ctx.signal,
        );
        const decision = resolved.decision;
        if (decision !== 'allow-once' && decision !== 'allow-always') {
          return {
            content:
              decision === 'timeout'
                ? `Nobody answered the approval request for ${tool.name}, so it was not run.`
                : `The developer declined the call to ${tool.name}.`,
            isError: true,
          };
        }
      }

      try {
        const result = await bridge.callTool(tool.serverId, tool.name, args);
        return { content: renderToolResult(result), ...(result.isError && { isError: true }) };
      } catch (error) {
        return { content: `${tool.serverLabel}: ${(error as Error).message}`, isError: true };
      }
    },
  } as AnyTool;
}

/** Servers occasionally advertise a loose schema; the model needs a well-formed object schema. */
function normaliseSchema(schema: Record<string, unknown>): JsonObjectSchema {
  if (schema && schema.type === 'object' && typeof schema.properties === 'object') {
    return schema as JsonObjectSchema;
  }
  return { type: 'object', properties: {}, ...(schema ?? {}) };
}

function summariseArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 3);
  if (entries.length === 0) return '';
  const rendered = entries
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'string' ? value.slice(0, 40) : JSON.stringify(value)?.slice(0, 40)}`,
    )
    .join(' ');
  return ` ${rendered}`;
}
