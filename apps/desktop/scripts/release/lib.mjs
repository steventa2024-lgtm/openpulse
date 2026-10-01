/**
 * Release helpers used by .github/workflows/release.yml and by hand. They only describe what is
 * actually there: version numbers read from package.json, checksums computed from the files, and
 * a signing status read from the binaries — never assumed from configuration.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** "v0.2.0" or "0.2.0" → "0.2.0"; anything that is not semver is rejected. */
export function versionFromTag(tag) {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  if (!match) throw new Error(`"${tag}" is not a version tag like v1.2.3`);
  return match[1];
}

/** Every workspace package.json that must carry the release version. */
export async function packageVersions(root) {
  const manifests = ['package.json'];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group);
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(group, name, 'package.json');
      if (await fs.stat(path.join(root, file)).catch(() => undefined)) manifests.push(file);
    }
  }
  const versions = [];
  for (const file of manifests) {
    const json = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    versions.push({ file: file.split(path.sep).join('/'), name: json.name, version: json.version });
  }
  return versions;
}

/** The manifests whose version differs from the tag's. Empty means the tag is consistent. */
export function versionMismatches(versions, expected) {
  return versions.filter((v) => v.version !== expected);
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** The release binaries in a directory: the installer and the portable build. */
export async function releaseFiles(dir, version) {
  const wanted = [`OpenPulse-Setup-${version}-x64.exe`, `OpenPulse-Portable-${version}-x64.exe`];
  const present = new Set(await fs.readdir(dir));
  const missing = wanted.filter((name) => !present.has(name));
  if (missing.length) throw new Error(`missing release files in ${dir}: ${missing.join(', ')}`);
  const files = [];
  for (const name of wanted) {
    const full = path.join(dir, name);
    const { size } = await fs.stat(full);
    files.push({ name, path: full, size, sha256: await sha256(full) });
  }
  return files;
}

/** The standard `sha256sum` format, which `sha256sum -c` and PowerShell users can both check. */
export function checksumFile(files) {
  return files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n';
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Release notes. The "Code signing:" line is read by the website's download page, so it must say
 * exactly what the files are: `signing` comes from inspecting the binaries.
 */
export function releaseNotes({ version, signing, files, changes = [], previousTag }) {
  if (signing !== 'signed' && signing !== 'unsigned') {
    throw new Error(`signing must be "signed" or "unsigned", not "${signing}"`);
  }
  const lines = [
    `OpenPulse ${version} for Windows 10 and 11 (64-bit).`,
    '',
    `Code signing: ${signing}`,
    '',
  ];
  if (signing === 'unsigned') {
    lines.push(
      'These builds are not code-signed, so Windows SmartScreen will warn the first time you run one.',
      'Check the SHA-256 checksum below first; then choose **More info → Run anyway**.',
      '',
    );
  }
  lines.push(
    '## Downloads',
    '',
    '| File | Size | SHA-256 |',
    '| ---- | ---- | ------- |',
    ...files.map((f) => `| \`${f.name}\` | ${mib(f.size)} | \`${f.sha256}\` |`),
    '',
    'The installer installs for your user account; the portable build runs without installing. Both',
    'keep your data in `%USERPROFILE%\\.openpulse`, which installing, upgrading and uninstalling never touch.',
    '',
    'Verify a download in PowerShell — the hash must match the table and `SHA256SUMS.txt`:',
    '',
    '```powershell',
    `Get-FileHash .\\OpenPulse-Setup-${version}-x64.exe -Algorithm SHA256`,
    '```',
    '',
  );
  if (changes.length) {
    lines.push(
      previousTag ? `## Changes since ${previousTag}` : '## Changes',
      '',
      ...changes.map((c) => `- ${c}`),
      '',
    );
  }
  return lines.join('\n');
}
