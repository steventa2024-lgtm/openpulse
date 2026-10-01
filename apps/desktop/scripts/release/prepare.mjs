#!/usr/bin/env node
/**
 * Prepares a GitHub release from built binaries:
 *
 *   node apps/desktop/scripts/release/prepare.mjs set-version 0.2.0
 *     sets that version in every workspace package.json (then commit, tag v0.2.0 and push the tag)
 *
 *   node apps/desktop/scripts/release/prepare.mjs check-version v0.2.0
 *     fails unless every workspace package.json says 0.2.0
 *
 *   node apps/desktop/scripts/release/prepare.mjs assemble v0.2.0 <signed|unsigned> [previousTag]
 *     writes apps/desktop/release/SHA256SUMS.txt and release-notes.md for the built binaries
 *
 * The signing status is passed in by the workflow, which reads it from the binaries with
 * Get-AuthenticodeSignature; nothing here infers it from whether a certificate was configured.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checksumFile,
  packageVersions,
  releaseFiles,
  releaseNotes,
  versionFromTag,
  versionMismatches,
} from './lib.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(desktopDir, '..', '..');
const releaseDir = path.join(desktopDir, 'release');

const [command, tag, signing, previousTag] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

/** One line per commit since the previous tag, without merge noise. */
function changesSince(prev) {
  if (!prev) return [];
  try {
    const out = execFileSync('git', ['log', '--no-merges', '--format=%s', `${prev}..HEAD`], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

if (!tag)
  fail(
    'usage: prepare.mjs <set-version|check-version|assemble> <tag> [signed|unsigned] [previousTag]',
  );
let version;
try {
  version = versionFromTag(tag);
} catch (error) {
  fail(error.message);
}

if (command === 'set-version') {
  for (const { file } of await packageVersions(root)) {
    const full = path.join(root, file);
    const text = await fs.readFile(full, 'utf8');
    // Replace only the top-level "version" so formatting and key order are kept.
    const next = text.replace(/^(\s{2}"version":\s*)"[^"]*"/m, `$1"${version}"`);
    if (next === text && !text.includes(`"version": "${version}"`))
      fail(`no version field in ${file}`);
    await fs.writeFile(full, next);
  }
  process.stdout.write(`every package set to ${version}\n`);
} else if (command === 'check-version') {
  const mismatches = versionMismatches(await packageVersions(root), version);
  if (mismatches.length) {
    fail(
      `tag ${tag} does not match:\n${mismatches.map((m) => `  ${m.file}: ${m.version}`).join('\n')}`,
    );
  }
  process.stdout.write(`every package is at ${version}\n`);
} else if (command === 'assemble') {
  const files = await releaseFiles(releaseDir, version).catch((error) => fail(error.message));
  await fs.writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), checksumFile(files));
  const notes = releaseNotes({
    version,
    signing,
    files,
    changes: changesSince(previousTag),
    ...(previousTag && { previousTag }),
  });
  await fs.writeFile(path.join(releaseDir, 'release-notes.md'), notes);
  process.stdout.write(
    `${checksumFile(files)}notes: ${path.join(releaseDir, 'release-notes.md')}\n`,
  );
} else {
  fail(`unknown command "${command}"`);
}
