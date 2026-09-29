import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GitRepo, gitAvailable } from '../src/git/git.js';
import { SkillRegistry, SkillRegistryError, starterTemplate } from '../src/skills/registry.js';
import { loadSkills } from '../src/skills/loader.js';
import { tempDir } from './helpers.js';

let git = { available: false } as { available: boolean };
beforeAll(async () => {
  git = await gitAvailable();
});

async function registry() {
  const root = await tempDir('openpulse-skills-');
  return {
    root,
    registry: new SkillRegistry(path.join(root, 'managed'), path.join(root, 'workspace', 'skills')),
  };
}

async function skillFolder(name: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = path.join(await tempDir(), name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Summarise open pull requests for the current repository.\n---\n\n# ${name}\n\nUse gh pr list and summarise each pull request in one line.\n`,
  );
  for (const [file, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
  return dir;
}

describe('skill validation', () => {
  it('accepts a well-formed skill', async () => {
    const { registry: r } = await registry();
    const result = await r.validate(await skillFolder('pr-summary'));

    expect(result.valid).toBe(true);
    expect(result.name).toBe('pr-summary');
    expect(result.errors).toEqual([]);
  });

  it('lists shipped scripts without running them', async () => {
    const { registry: r } = await registry();
    const marker = path.join(await tempDir(), 'ran.txt');
    const dir = await skillFolder('with-script', {
      'install.sh': `echo ran > "${marker}"`,
      'scripts/helper.py': 'print("hi")',
    });

    const result = await r.validate(dir);
    expect(result.executables.sort()).toEqual(['install.sh', 'scripts/helper.py']);
    expect(result.warnings.join(' ')).toContain('never run on install');

    await r.importLocal(dir);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('rejects a folder without SKILL.md, a bad name and broken frontmatter', async () => {
    const { registry: r } = await registry();
    expect((await r.validate(await tempDir())).errors[0]).toContain('no SKILL.md');

    const badName = path.join(await tempDir(), 'Bad');
    await fs.mkdir(badName);
    await fs.writeFile(
      path.join(badName, 'SKILL.md'),
      '---\nname: Bad Name\ndescription: A description that is long enough.\n---\nBody text here for the agent.\n',
    );
    expect((await r.validate(badName)).errors.join(' ')).toContain('lowercase');

    const broken = path.join(await tempDir(), 'broken');
    await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, 'SKILL.md'), 'no frontmatter at all');
    expect((await r.validate(broken)).valid).toBe(false);
  });
});

describe('installing skills', () => {
  it('imports a local folder into the managed directory, where the loader finds it', async () => {
    const { registry: r, root } = await registry();
    const installed = await r.importLocal(await skillFolder('pr-summary'));

    expect(installed.dir).toBe(path.join(root, 'managed', 'pr-summary'));
    expect(installed.origin).toMatchObject({ kind: 'local' });

    const { skills } = await loadSkills({ managed: path.join(root, 'managed') });
    expect(skills.map((s) => s.name)).toContain('pr-summary');
  });

  it('refuses to overwrite an installed skill unless asked', async () => {
    const { registry: r } = await registry();
    const dir = await skillFolder('pr-summary');
    await r.importLocal(dir);

    await expect(r.importLocal(dir)).rejects.toMatchObject({ code: 'EXISTS' });
    await expect(r.importLocal(dir, { overwrite: true })).resolves.toMatchObject({
      name: 'pr-summary',
    });
  });

  it('installs from a git repository and records the commit', async () => {
    if (!git.available) return;
    const { registry: r } = await registry();
    const source = await skillFolder('from-git');
    const repo = new GitRepo(source);
    await repo.git(['init', '--initial-branch=main']);
    await repo.git(['config', 'user.email', 'test@openpulse.local']);
    await repo.git(['config', 'user.name', 'OpenPulse Test']);
    await repo.add(['.']);
    await repo.commit('Add skill');

    const installed = await r.installFromGit(source);
    expect(installed.name).toBe('from-git');
    expect(installed.origin).toMatchObject({ kind: 'git', url: source });
    expect((installed.origin as { commit?: string }).commit).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.stat(path.join(installed.dir, '.git'))).rejects.toThrow();
  });

  it('picks up upstream changes on update', async () => {
    if (!git.available) return;
    const { registry: r } = await registry();
    const source = await skillFolder('updatable');
    const repo = new GitRepo(source);
    await repo.git(['init', '--initial-branch=main']);
    await repo.git(['config', 'user.email', 'test@openpulse.local']);
    await repo.git(['config', 'user.name', 'OpenPulse Test']);
    await repo.add(['.']);
    await repo.commit('v1');
    const installed = await r.installFromGit(source);

    await fs.writeFile(path.join(source, 'NOTES.md'), 'new in v2\n');
    await repo.add(['NOTES.md']);
    await repo.commit('v2');

    await r.update('updatable');
    await expect(fs.readFile(path.join(installed.dir, 'NOTES.md'), 'utf8')).resolves.toBe(
      'new in v2\n',
    );
  });

  it('rejects URLs that are not git locations', async () => {
    const { registry: r } = await registry();
    await expect(r.installFromGit('javascript:alert(1)')).rejects.toBeInstanceOf(
      SkillRegistryError,
    );
  });
});

describe('creating and removing skills', () => {
  it('scaffolds a valid skill from the starter template', async () => {
    const { registry: r } = await registry();
    const created = await r.create({
      name: 'deploy-check',
      description: 'Check a deployment is healthy before announcing it.',
    });

    expect(created.source).toBe('workspace');
    const validation = await r.validate(created.dir);
    expect(validation.valid).toBe(true);
    expect(validation.name).toBe('deploy-check');
  });

  it('removes managed and workspace skills, but not unknown ones', async () => {
    const { registry: r } = await registry();
    await r.importLocal(await skillFolder('managed-one'));
    await r.create({
      name: 'workspace-one',
      description: 'A workspace skill for the removal test.',
    });

    await expect(r.remove('managed-one')).resolves.toBeTruthy();
    await expect(r.remove('workspace-one')).resolves.toBeTruthy();
    await expect(r.remove('never-installed')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('will not remove anything outside the skill directories', async () => {
    const { registry: r } = await registry();
    await expect(r.remove('../../etc')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('produces a template the loader accepts', () => {
    expect(starterTemplate('x-y', 'Does a thing.')).toContain('name: x-y');
  });
});
