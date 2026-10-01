import { z } from 'zod';
import { defineTool, fail, ok } from './types.js';

export const proposeChangeTool = defineTool({
  name: 'propose_change',
  description:
    'Propose edits to the active project for the developer to review. Nothing is written until they approve it. Use this when asked for a reviewable change, or when the edit is large enough that someone should look before it lands. For quick work in your own workspace use write/edit instead.',
  input: z.object({
    title: z
      .string()
      .min(1)
      .max(200)
      .describe('Short summary of the change, e.g. "Handle expired tokens"'),
    description: z
      .string()
      .max(4000)
      .optional()
      .describe('Why the change is needed and what it does'),
    files: z
      .array(
        z.object({
          path: z.string().min(1).describe('Path relative to the project root'),
          action: z.enum(['create', 'modify', 'delete']),
          content: z
            .string()
            .optional()
            .describe('Full contents of the file after the change; omit for delete'),
        }),
      )
      .min(1)
      .max(50),
  }),
  summarize: (i) =>
    `propose ${i.files.length} file change${i.files.length === 1 ? '' : 's'}: ${i.title}`,
  async execute(input, ctx) {
    const changes = ctx.services.changes;
    if (!changes) return fail('Proposed changes are not available in this session.');

    try {
      const result = await changes.propose({
        title: input.title,
        ...(input.description !== undefined && { description: input.description }),
        files: input.files,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
      });
      const lines = result.files.map(
        (file) => `  ${file.action.padEnd(6)} ${file.path} (+${file.additions} -${file.deletions})`,
      );
      return ok(
        [
          `Proposed "${input.title}" for review (${result.files.length} file${result.files.length === 1 ? '' : 's'}).`,
          ...lines,
          '',
          'Status: waiting for review. It is NOT approved and NOT written to disk.',
          'Tell the developer it is ready to review under Workspace → Changes. Do not write these files yourself.',
        ].join('\n'),
      );
    } catch (error) {
      return fail((error as Error).message);
    }
  },
});
