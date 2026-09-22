import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Skills shipped with the gateway (`packages/gateway/skills`), from both `src/` and `dist/`. */
export const BUNDLED_SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
);
