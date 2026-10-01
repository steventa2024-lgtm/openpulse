import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { KeyedMutex, readTextOr, writeFileAtomic } from '../util/fs.js';
import type { ThinkingLevel } from '../config/schema.js';
import { parseSessionKey } from './keys.js';
import { transcriptPath } from './transcript.js';

export interface SessionEntry {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  /** Last user/channel interaction, used by idle resets. */
  lastInteractionAt?: number;
  displayName?: string;
  label?: string;
  chatType: 'direct' | 'group' | 'main' | 'cron' | 'named' | 'other';
  /** Last delivery route, used by heartbeat target "last" and cron announce fallbacks. */
  lastChannel?: string;
  lastTo?: string;
  thinkingLevel?: ThinkingLevel;
  verboseLevel?: 'on' | 'off';
  modelOverride?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Size of the last prompt, i.e. how full the context window is. */
  contextTokens?: number;
  abortedLastRun?: boolean;
}

export type SessionPatch = Partial<Omit<SessionEntry, 'sessionId' | 'createdAt'>>;

/**
 * sessions.json: session key → metadata. The transcript itself lives in <sessionId>.jsonl so a
 * reset just points the key at a new session id (old transcripts are kept on disk).
 */
export class SessionStore {
  private cache: Record<string, SessionEntry> | undefined;
  private readonly lock = new KeyedMutex();

  constructor(readonly dir: string) {}

  get file(): string {
    return path.join(this.dir, 'sessions.json');
  }

  async list(): Promise<Array<{ key: string } & SessionEntry>> {
    const all = await this.load();
    return Object.entries(all)
      .map(([key, e]) => ({ key, ...e }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(key: string): Promise<SessionEntry | undefined> {
    return (await this.load())[key];
  }

  /** Get the entry for `key`, creating a fresh session if needed. */
  async ensure(key: string, init: SessionPatch = {}): Promise<SessionEntry> {
    return this.lock.run('store', async () => {
      const all = await this.load();
      if (all[key]) return all[key];
      const now = Date.now();
      const entry: SessionEntry = {
        sessionId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        chatType: kindOf(key),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        ...init,
      };
      all[key] = entry;
      await this.save(all);
      return entry;
    });
  }

  async patch(key: string, patch: SessionPatch): Promise<SessionEntry> {
    return this.lock.run('store', async () => {
      const all = await this.load();
      const current = all[key];
      if (!current) throw new Error(`Unknown session "${key}"`);
      const next: SessionEntry = {
        ...current,
        ...stripUndefined(patch),
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete (next as unknown as Record<string, unknown>)[k];
      }
      all[key] = next;
      await this.save(all);
      return next;
    });
  }

  /** Start a new transcript for `key`, keeping user-facing overrides (thinking, model, route). */
  async reset(key: string): Promise<SessionEntry> {
    return this.lock.run('store', async () => {
      const all = await this.load();
      const prev = all[key];
      const now = Date.now();
      const entry: SessionEntry = {
        sessionId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        chatType: prev?.chatType ?? kindOf(key),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        ...(prev?.displayName !== undefined && { displayName: prev.displayName }),
        ...(prev?.label !== undefined && { label: prev.label }),
        ...(prev?.lastChannel !== undefined && { lastChannel: prev.lastChannel }),
        ...(prev?.lastTo !== undefined && { lastTo: prev.lastTo }),
        ...(prev?.thinkingLevel !== undefined && { thinkingLevel: prev.thinkingLevel }),
        ...(prev?.verboseLevel !== undefined && { verboseLevel: prev.verboseLevel }),
        ...(prev?.modelOverride !== undefined && { modelOverride: prev.modelOverride }),
      };
      all[key] = entry;
      await this.save(all);
      return entry;
    });
  }

  async delete(key: string, opts: { deleteTranscript?: boolean } = {}): Promise<boolean> {
    return this.lock.run('store', async () => {
      const all = await this.load();
      const prev = all[key];
      if (!prev) return false;
      delete all[key];
      await this.save(all);
      if (opts.deleteTranscript) {
        await fsp.rm(transcriptPath(this.dir, prev.sessionId), { force: true });
      }
      return true;
    });
  }

  transcriptFile(entry: SessionEntry): string {
    return transcriptPath(this.dir, entry.sessionId);
  }

  private async load(): Promise<Record<string, SessionEntry>> {
    if (this.cache) return this.cache;
    const text = await readTextOr(this.file, '');
    try {
      this.cache = text.trim() ? (JSON.parse(text) as Record<string, SessionEntry>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(all: Record<string, SessionEntry>): Promise<void> {
    this.cache = all;
    await writeFileAtomic(this.file, `${JSON.stringify(all, null, 2)}\n`);
  }
}

function kindOf(key: string): SessionEntry['chatType'] {
  const k = parseSessionKey(key).kind;
  return k === 'other' ? 'other' : k;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>;
}
