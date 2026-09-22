/**
 * Per-chat routing overrides. When present, a chat's messages go to the
 * specified session instead of the default resolved by `resolveSessionKey`.
 *
 * Storage: ~/.openpulse/routes.json
 * Shape:   { "<channel>:<chatId>": "<sessionKey>" }
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export type RoutesFile = Record<string, string>;

export class RoutesStore {
  private cache: RoutesFile | undefined;

  constructor(readonly dir: string) {}

  get file(): string {
    return path.join(this.dir, 'routes.json');
  }

  private async load(): Promise<RoutesFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      this.cache = JSON.parse(raw) as RoutesFile;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(data: RoutesFile): Promise<void> {
    this.cache = data;
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  /** Returns the session key for `<channel>:<chatId>`, or undefined if unset. */
  async get(channel: string, chatId: string): Promise<string | undefined> {
    const all = await this.load();
    return all[`${channel}:${chatId}`];
  }

  /** Sets or clears the route. Pass `undefined` to remove. */
  async set(channel: string, chatId: string, sessionKey: string | undefined): Promise<void> {
    const all = await this.load();
    const key = `${channel}:${chatId}`;
    if (sessionKey === undefined) {
      delete all[key];
    } else {
      all[key] = sessionKey;
    }
    await this.save(all);
  }

  async list(): Promise<Array<{ route: string; sessionKey: string }>> {
    const all = await this.load();
    return Object.entries(all).map(([route, sessionKey]) => ({ route, sessionKey }));
  }

  async clear(): Promise<void> {
    await this.save({});
  }
}
