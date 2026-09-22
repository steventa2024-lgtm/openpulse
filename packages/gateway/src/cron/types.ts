import { z } from 'zod';
import { THINKING_LEVELS } from '../config/schema.js';

export const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: z.string().min(1) }),
  z.object({
    kind: z.literal('every'),
    everyMs: z.number().int().min(10_000),
    anchorMs: z.number().int().optional(),
  }),
  z.object({ kind: z.literal('cron'), expr: z.string().min(1), tz: z.string().optional() }),
]);

export const PayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('systemEvent'), text: z.string().min(1) }),
  z.object({
    kind: z.literal('agentTurn'),
    message: z.string().min(1),
    model: z.string().optional(),
    thinking: z.enum(THINKING_LEVELS).optional(),
    timeoutSeconds: z.number().int().min(10).optional(),
  }),
]);

export const DeliverySchema = z.object({
  mode: z.enum(['announce', 'none', 'webhook']),
  channel: z.string().optional(),
  to: z.string().optional(),
  bestEffort: z.boolean().optional(),
});

export const CronJobInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    agentId: z.string().optional(),
    enabled: z.boolean().default(true),
    schedule: ScheduleSchema,
    sessionTarget: z.enum(['main', 'isolated']),
    wakeMode: z.enum(['now', 'next-heartbeat']).default('now'),
    payload: PayloadSchema,
    delivery: DeliverySchema.optional(),
    deleteAfterRun: z.boolean().optional(),
  })
  .refine((j) => (j.sessionTarget === 'main') === (j.payload.kind === 'systemEvent'), {
    message:
      'sessionTarget "main" requires payload.kind "systemEvent"; "isolated" requires "agentTurn"',
    path: ['payload'],
  })
  .refine((j) => !(j.sessionTarget === 'main' && j.delivery?.mode === 'announce'), {
    message: 'announce delivery is only valid for isolated jobs',
    path: ['delivery'],
  });

export type CronJobInput = z.input<typeof CronJobInputSchema>;

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  runningAtMs?: number;
}

export type CronJob = z.output<typeof CronJobInputSchema> & {
  jobId: string;
  createdAtMs: number;
  updatedAtMs: number;
  state: CronJobState;
};

export interface CronRunRecord {
  ts: number;
  jobId: string;
  action: 'finished';
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
  runAtMs: number;
  durationMs: number;
  nextRunAtMs?: number;
  delivered?: boolean;
}
