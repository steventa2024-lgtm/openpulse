import fs from 'node:fs';
import path from 'node:path';

export interface ResourcePaths {
  /** Bundled gateway entry (ESM) run by the Electron binary. */
  gatewayEntry: string;
  /** Built Control UI the gateway serves. */
  controlUiDir: string;
  /** Skills shipped with the app. */
  bundledSkillsDir: string;
  /** Static pages the desktop shell itself shows (loading, failure). */
  shellDir: string;
  iconFile: string;
}

/**
 * Where the app's resources live, which differs between `electron .` in the repo and an installed
 * build (`resources/` inside the app directory). Every path is checked so a packaging mistake
 * surfaces as a clear error instead of a blank window.
 */
export function resolveResources(
  appPath: string,
  isPackaged: boolean,
  resourcesPath: string,
): ResourcePaths {
  const root = isPackaged ? resourcesPath : appPath;
  const candidates: ResourcePaths = isPackaged
    ? {
        gatewayEntry: path.join(root, 'gateway', 'main.mjs'),
        controlUiDir: path.join(root, 'dashboard'),
        bundledSkillsDir: path.join(root, 'skills'),
        shellDir: path.join(appPath, 'dist', 'shell'),
        iconFile: path.join(root, 'icon.ico'),
      }
    : {
        gatewayEntry: path.join(root, 'dist', 'gateway', 'main.mjs'),
        controlUiDir: path.resolve(root, '..', '..', 'packages', 'dashboard', 'dist'),
        bundledSkillsDir: path.resolve(root, '..', '..', 'packages', 'gateway', 'skills'),
        shellDir: path.join(root, 'dist', 'shell'),
        iconFile: path.join(root, 'build', 'icon.ico'),
      };
  return candidates;
}

/** Resources that must exist before the app can work, with a readable message when they do not. */
export function checkResources(paths: ResourcePaths): string[] {
  const problems: string[] = [];
  if (!fs.existsSync(paths.gatewayEntry)) {
    problems.push(
      `Gateway bundle is missing at ${paths.gatewayEntry} (run "pnpm --filter @openpulse/desktop build").`,
    );
  }
  if (!fs.existsSync(path.join(paths.controlUiDir, 'index.html'))) {
    problems.push(
      `Control UI build is missing at ${paths.controlUiDir} (run "pnpm --filter @openpulse/dashboard build").`,
    );
  }
  return problems;
}
