/**
 * Backup and restore ~/.openpulse state.
 *
 * Shells out to the system `tar` binary (available on every Linux/macOS host).
 * Everything lives under ~/.openpulse/, so a single tarball captures the full
 * workspace: config, sessions, cron jobs, skills, memory, and crypto keys.
 *
 * Excludes:
 *   - logs/      (ephemeral, potentially large)
 *   - backups/   (would recurse into itself)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface BackupEntry {
  file: string;
  sizeBytes: number;
  createdAt: number;
}

export interface BackupOptions {
  /** Root of the state directory. Defaults to ~/.openpulse. */
  stateDir?: string;
  /** Where to write tarballs. Defaults to <stateDir>/backups. */
  outputDir?: string;
}

function resolveStateDir(opts: BackupOptions): string {
  if (opts.stateDir) return opts.stateDir;
  const env = process.env.OPENPULSE_STATE_DIR;
  if (env) return env;
  return path.join(os.homedir(), '.openpulse');
}

function resolveOutputDir(opts: BackupOptions, stateDir: string): string {
  return opts.outputDir ?? path.join(stateDir, 'backups');
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Create a new backup tarball. Returns the path to the created file.
 */
export async function createBackup(opts: BackupOptions = {}): Promise<string> {
  const stateDir = resolveStateDir(opts);
  const outputDir = resolveOutputDir(opts, stateDir);

  if (!fs.existsSync(stateDir)) {
    throw new Error(`State directory not found: ${stateDir}`);
  }

  await fsp.mkdir(outputDir, { recursive: true });

  const outFile = path.join(outputDir, `openpulse-${timestamp()}.tar.gz`);

  // Write a manifest into a temp file so it lands inside the tarball.
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    stateDir,
    files: await countFiles(stateDir),
  };
  const manifestPath = path.join(stateDir, 'MANIFEST.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // tar -czf out -C stateDir --exclude=logs --exclude=backups .
  const args = [
    '-czf',
    outFile,
    '-C',
    stateDir,
    '--exclude=./logs',
    '--exclude=./backups',
    '--exclude=./MANIFEST.json', // write fresh each time, do not persist
    '.',
  ];

  const result = spawnSync('tar', args, { stdio: 'pipe' });
  // Clean up the manifest we wrote even if the tar succeeded.
  await fsp.unlink(manifestPath).catch(() => undefined);

  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr?.toString().trim() || 'unknown error'}`);
  }

  return outFile;
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const skip = new Set(['logs', 'backups']);
  async function walk(p: string) {
    const entries = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) await walk(full);
      else count++;
    }
  }
  await walk(dir);
  return count;
}

/**
 * List existing backups, newest first.
 */
export async function listBackups(opts: BackupOptions = {}): Promise<BackupEntry[]> {
  const stateDir = resolveStateDir(opts);
  const outputDir = resolveOutputDir(opts, stateDir);

  if (!fs.existsSync(outputDir)) return [];
  const entries = await fsp.readdir(outputDir, { withFileTypes: true });
  const out: BackupEntry[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.tar.gz')) continue;
    const full = path.join(outputDir, e.name);
    const st = await fsp.stat(full);
    out.push({ file: full, sizeBytes: st.size, createdAt: st.mtimeMs });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Restore from a tarball. Current state is moved aside to <stateDir>.pre-restore-<ts>
 * so the operation can be undone.
 */
export async function restoreBackup(
  file: string,
  opts: BackupOptions = {},
): Promise<{ restoredFrom: string; savedTo: string }> {
  const stateDir = resolveStateDir(opts);

  if (!fs.existsSync(file)) throw new Error(`Backup file not found: ${file}`);

  // Stage a copy of the tarball outside the state dir, so the rename below
  // does not take the file with it (backups normally live under stateDir/backups).
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openpulse-restore-'));
  const tmpFile = path.join(tmpDir, path.basename(file));
  await fsp.copyFile(file, tmpFile);

  try {
    const savedTo = `${stateDir}.pre-restore-${Date.now()}`;
    if (fs.existsSync(stateDir)) {
      await fsp.rename(stateDir, savedTo).catch(async () => {
        await fsp.cp(stateDir, savedTo, { recursive: true });
        await fsp.rm(stateDir, { recursive: true, force: true });
      });
    }
    await fsp.mkdir(stateDir, { recursive: true });

    const args = ['-xzf', tmpFile, '-C', stateDir];
    const result = spawnSync('tar', args, { stdio: 'pipe' });
    if (result.status !== 0) {
      // Roll back: remove partial extraction, restore original.
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rename(savedTo, stateDir).catch(() => undefined);
      const stderr = result.stderr?.toString().trim() || '';
      throw new Error(`tar failed (status ${result.status})${stderr ? ': ' + stderr : ''}`);
    }

    // Copy the backup file into the fresh state's backups folder, so the user
    // still has it after the restore (the original path was inside the renamed dir).
    const newBackupsDir = path.join(stateDir, 'backups');
    await fsp.mkdir(newBackupsDir, { recursive: true });
    await fsp
      .copyFile(tmpFile, path.join(newBackupsDir, path.basename(file)))
      .catch(() => undefined);

    return { restoredFrom: file, savedTo };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Delete old backups, keeping the N newest.
 */
export async function pruneBackups(keep: number, opts: BackupOptions = {}): Promise<string[]> {
  const all = await listBackups(opts);
  const toDelete = all.slice(keep);
  const deleted: string[] = [];
  for (const entry of toDelete) {
    await fsp.unlink(entry.file);
    deleted.push(entry.file);
  }
  return deleted;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
