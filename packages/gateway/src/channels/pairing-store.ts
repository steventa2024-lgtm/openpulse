import { randomInt } from 'node:crypto';
import path from 'node:path';
import { KeyedMutex, readTextOr, writeFileAtomic } from '../util/fs.js';

export interface PairingRequest {
  code: string;
  userId: string;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0 O 1 I
const TTL_MS = 60 * 60_000;
const MAX_PENDING = 3;

/**
 * DM pairing: unknown senders get a short code; the owner approves it from the CLI or Control UI,
 * which moves the sender into the channel's allow store.
 *   credentials/<channel>-pairing.json    pending requests
 *   credentials/<channel>-allowFrom.json  approved sender ids
 */
export class PairingStore {
  private readonly lock = new KeyedMutex();

  constructor(private readonly dir: string) {}

  async listPending(channel: string): Promise<PairingRequest[]> {
    const data = await this.readPending(channel);
    return data.requests.filter((r) => Date.now() - r.createdAt < TTL_MS);
  }

  async allowFrom(channel: string): Promise<string[]> {
    const text = await readTextOr(this.allowFile(channel), '');
    try {
      return text ? ((JSON.parse(text) as { allowFrom?: string[] }).allowFrom ?? []) : [];
    } catch {
      return [];
    }
  }

  async isAllowed(channel: string, userId: string, configAllow: string[] = []): Promise<boolean> {
    const norm = (v: string) => v.replace(/^(tg|telegram):/i, '');
    const all = [...configAllow, ...(await this.allowFrom(channel))].map(norm);
    return all.includes('*') || all.includes(norm(userId));
  }

  /** Create (or refresh) a pairing request. Returns undefined when too many are pending. */
  async request(
    channel: string,
    userId: string,
    name?: string,
  ): Promise<{ code: string; created: boolean } | undefined> {
    return this.lock.run(channel, async () => {
      const data = await this.readPending(channel);
      const now = Date.now();
      data.requests = data.requests.filter((r) => now - r.createdAt < TTL_MS);
      const existing = data.requests.find((r) => r.userId === userId);
      if (existing) {
        existing.lastSeenAt = now;
        await this.writePending(channel, data);
        return { code: existing.code, created: false };
      }
      if (data.requests.length >= MAX_PENDING) return undefined;
      const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      data.requests.push({
        code,
        userId,
        ...(name !== undefined && { name }),
        createdAt: now,
        lastSeenAt: now,
      });
      await this.writePending(channel, data);
      return { code, created: true };
    });
  }

  async approve(channel: string, code: string): Promise<PairingRequest | undefined> {
    return this.lock.run(channel, async () => {
      const data = await this.readPending(channel);
      const req = data.requests.find(
        (r) => r.code === code.trim().toUpperCase() && Date.now() - r.createdAt < TTL_MS,
      );
      if (!req) return undefined;
      data.requests = data.requests.filter((r) => r !== req);
      await this.writePending(channel, data);
      await this.addAllow(channel, req.userId);
      return req;
    });
  }

  async reject(channel: string, code: string): Promise<boolean> {
    return this.lock.run(channel, async () => {
      const data = await this.readPending(channel);
      const before = data.requests.length;
      data.requests = data.requests.filter((r) => r.code !== code.trim().toUpperCase());
      await this.writePending(channel, data);
      return data.requests.length < before;
    });
  }

  async addAllow(channel: string, userId: string): Promise<void> {
    const list = await this.allowFrom(channel);
    if (!list.includes(userId)) list.push(userId);
    await writeFileAtomic(
      this.allowFile(channel),
      `${JSON.stringify({ version: 1, allowFrom: list }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async removeAllow(channel: string, userId: string): Promise<void> {
    const list = (await this.allowFrom(channel)).filter((u) => u !== userId);
    await writeFileAtomic(
      this.allowFile(channel),
      `${JSON.stringify({ version: 1, allowFrom: list }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private pendingFile(channel: string) {
    return path.join(this.dir, `${channel}-pairing.json`);
  }

  private allowFile(channel: string) {
    return path.join(this.dir, `${channel}-allowFrom.json`);
  }

  private async readPending(channel: string): Promise<{ version: 1; requests: PairingRequest[] }> {
    const text = await readTextOr(this.pendingFile(channel), '');
    try {
      const parsed = text ? (JSON.parse(text) as { requests?: PairingRequest[] }) : {};
      return { version: 1, requests: parsed.requests ?? [] };
    } catch {
      return { version: 1, requests: [] };
    }
  }

  private async writePending(
    channel: string,
    data: { version: 1; requests: PairingRequest[] },
  ): Promise<void> {
    await writeFileAtomic(this.pendingFile(channel), `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
