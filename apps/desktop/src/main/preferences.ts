import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface Preferences {
  window: WindowBounds;
  /** Keep running in the tray when the window is closed. */
  minimizeToTray: boolean;
  /** Ask the gateway to start with the app. */
  autoStartGateway: boolean;
  notifications: boolean;
  /** Port the desktop app talks to; also handed to the gateway it starts. */
  port: number;
  /** Set once the first-run wizard has been completed. */
  onboarded: boolean;
  /** Version that ran last, used to show "what's new" and to migrate preferences. */
  lastVersion?: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  window: { width: 1360, height: 900 },
  minimizeToTray: true,
  autoStartGateway: true,
  notifications: true,
  port: 18789,
  onboarded: false,
};

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

/**
 * Desktop preferences, stored next to the app's user data (never in ~/.openpulse, which belongs
 * to the gateway). Reads tolerate a missing or corrupt file: the app must still start.
 */
export class PreferencesStore {
  private data: Preferences = { ...DEFAULT_PREFERENCES };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  get current(): Preferences {
    return this.data;
  }

  load(): Preferences {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Preferences>;
        this.data = normalise(parsed);
      }
    } catch {
      this.data = { ...DEFAULT_PREFERENCES };
    }
    return this.data;
  }

  /** Merge a patch and persist it. Writes are serialised so rapid updates cannot interleave. */
  set(patch: Partial<Preferences>): Preferences {
    this.data = normalise({ ...this.data, ...patch });
    this.writeQueue = this.writeQueue.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    });
    this.writeQueue.catch(() => undefined);
    return this.data;
  }

  async flush(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }
}

/** Clamp anything a hand-edited (or stale) file might contain into something usable. */
function normalise(input: Partial<Preferences>): Preferences {
  const window = { ...DEFAULT_PREFERENCES.window, ...(input.window ?? {}) };
  const port = Number(input.port ?? DEFAULT_PREFERENCES.port);
  return {
    window: {
      width: clampInt(window.width, MIN_WIDTH, 10_000, DEFAULT_PREFERENCES.window.width),
      height: clampInt(window.height, MIN_HEIGHT, 10_000, DEFAULT_PREFERENCES.window.height),
      ...(Number.isFinite(window.x) ? { x: Math.round(window.x!) } : {}),
      ...(Number.isFinite(window.y) ? { y: Math.round(window.y!) } : {}),
      maximized: Boolean(window.maximized),
    },
    minimizeToTray: input.minimizeToTray ?? DEFAULT_PREFERENCES.minimizeToTray,
    autoStartGateway: input.autoStartGateway ?? DEFAULT_PREFERENCES.autoStartGateway,
    notifications: input.notifications ?? DEFAULT_PREFERENCES.notifications,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PREFERENCES.port,
    onboarded: Boolean(input.onboarded),
    ...(input.lastVersion ? { lastVersion: input.lastVersion } : {}),
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
