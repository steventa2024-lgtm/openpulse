import { createRequire } from 'node:module';

/**
 * Kept in step with packages/gateway/package.json by a test. It is the value used when the gateway
 * runs from a bundle (the desktop app), where package.json is not a file next to this module.
 */
const FALLBACK_VERSION = '0.1.0';

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // Bundled build: fall through to the compiled-in value.
  }
  return process.env.OPENPULSE_VERSION || FALLBACK_VERSION;
}

export const VERSION: string = readVersion();
export { FALLBACK_VERSION };
