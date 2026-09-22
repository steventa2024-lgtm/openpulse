import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { BUNDLED_SKILLS_DIR } from '../src/skills/bundled.js';
import {
  evaluateSkill,
  formatSkillsForPrompt,
  loadSkills,
  onPath,
  parseSkillFile,
  skillEnv,
} from '../src/skills/loader.js';
import { tempDir } from './helpers.js';

const loc = {
  baseDir: '/skills/demo',
  filePath: '/skills/demo/SKILL.md',
  source: 'workspace' as const,
};
const config = (patch: Record<string, unknown> = {}) => ConfigSchema.parse(patch);

async function writeSkill(root: string, dir: string, text: string): Promise<string> {
  await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, dir, 'SKILL.md'), text);
  return path.join(root, dir);
}

describe('parseSkillFile', () => {
  it('parses frontmatter, metadata JSON and the instruction body', () => {
    const skill = parseSkillFile(
      `---
name: nano-pro
description: Generate images
homepage: https://example.com
user-invocable: false
metadata: { "openpulse": { "emoji": "🎨", "primaryEnv": "NANO_KEY", "requires": { "bins": ["uv"], "env": ["NANO_KEY"] } } }
---
Run \`{baseDir}/run.sh\` to generate.`,
      loc,
    );
    expect(skill).toMatchObject({
      name: 'nano-pro',
      description: 'Generate images',
      homepage: 'https://example.com',
      userInvocable: false,
      disableModelInvocation: false,
      source: 'workspace',
    });
    expect(skill.metadata.requires?.bins).toEqual(['uv']);
    expect(skill.body).toBe('Run `/skills/demo/run.sh` to generate.');
  });

  it('accepts OpenClaw-style metadata and YAML-mapped metadata', () => {
    const a = parseSkillFile(
      '---\nname: a\ndescription: d\nmetadata: { "openclaw": { "emoji": "x" } }\n---\nbody',
      loc,
    );
    expect(a.metadata.emoji).toBe('x');
    const b = parseSkillFile(
      '---\nname: b\ndescription: d\nmetadata:\n  openpulse:\n    requires:\n      bins: [git]\n---\nbody',
      loc,
    );
    expect(b.metadata.requires?.bins).toEqual(['git']);
  });

  it.each([
    ['no frontmatter', '# hi', /must start with YAML frontmatter/],
    ['bad name', '---\nname: Nope Spaces\ndescription: d\n---\n', /name/],
    ['missing description', '---\nname: ok\n---\n', /description/],
    ['bad yaml', '---\nname: [\n---\n', /invalid frontmatter/],
  ])('rejects %s', (_l, text, re) => {
    expect(() => parseSkillFile(text, loc)).toThrow(re);
  });
});

describe('loadSkills', () => {
  it('applies precedence workspace > managed > bundled and reports broken skills', async () => {
    const bundled = await tempDir();
    const managed = await tempDir();
    const workspace = await tempDir();
    await writeSkill(bundled, 'alpha', '---\nname: alpha\ndescription: bundled alpha\n---\nb');
    await writeSkill(bundled, 'beta', '---\nname: beta\ndescription: bundled beta\n---\nb');
    await writeSkill(managed, 'alpha', '---\nname: alpha\ndescription: managed alpha\n---\nm');
    await writeSkill(workspace, 'alpha', '---\nname: alpha\ndescription: workspace alpha\n---\nw');
    await writeSkill(workspace, 'broken', 'nope');

    const { skills, errors } = await loadSkills({ bundled, managed, workspace });
    expect(skills.map((s) => `${s.name}:${s.description}`)).toEqual([
      'alpha:workspace alpha',
      'beta:bundled beta',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: 'broken', eligible: false });
  });

  it('loads the bundled skills', async () => {
    const { skills, errors } = await loadSkills({ bundled: BUNDLED_SKILLS_DIR });
    expect(errors).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(['github', 'system-info', 'weather']);
  });
});

describe('evaluateSkill', () => {
  const base = '---\nname: gated\ndescription: d\nmetadata: { "openpulse": ';

  it('gates on bins, env, config and os', () => {
    const missingBin = parseSkillFile(
      `${base}{ "requires": { "bins": ["definitely-not-real-xyz"] } } }\n---\n`,
      loc,
    );
    expect(evaluateSkill(missingBin, config()).missing.bins).toEqual(['definitely-not-real-xyz']);

    const needsEnv = parseSkillFile(
      `${base}{ "requires": { "env": ["MY_KEY"] }, "primaryEnv": "MY_KEY" } }\n---\n`,
      loc,
    );
    expect(evaluateSkill(needsEnv, config(), {}).eligible).toBe(false);
    expect(evaluateSkill(needsEnv, config(), { MY_KEY: 'x' }).eligible).toBe(true);
    expect(
      evaluateSkill(
        needsEnv,
        config({ skills: { entries: { gated: { apiKey: 'from-config' } } } }),
        {},
      ).eligible,
    ).toBe(true);

    const needsConfig = parseSkillFile(
      `${base}{ "requires": { "config": ["browser.enabled"] } } }\n---\n`,
      loc,
    );
    expect(evaluateSkill(needsConfig, config()).eligible).toBe(true);
    expect(
      evaluateSkill(needsConfig, config({ browser: { enabled: false } })).missing.config,
    ).toEqual(['browser.enabled']);

    const otherOs = parseSkillFile(`${base}{ "os": ["plan9"] } }\n---\n`, loc);
    expect(evaluateSkill(otherOs, config()).missing.os).toEqual(['plan9']);

    const always = parseSkillFile(
      `${base}{ "always": true, "requires": { "bins": ["definitely-not-real-xyz"] } } }\n---\n`,
      loc,
    );
    expect(evaluateSkill(always, config()).eligible).toBe(true);
  });

  it('honours skills.entries disable and exposes api key state', () => {
    const skill = parseSkillFile('---\nname: gated\ndescription: d\n---\n', loc);
    const status = evaluateSkill(
      skill,
      config({ skills: { entries: { gated: { enabled: false, apiKey: 'k' } } } }),
    );
    expect(status).toMatchObject({ disabled: true, eligible: true, hasApiKey: true });
  });

  it('collects env for tool processes', () => {
    const skill = parseSkillFile(`${base}{ "primaryEnv": "MY_KEY" } }\n---\n`, loc);
    const cfg = config({
      skills: { entries: { gated: { apiKey: 'secret', env: { OTHER: '1' } } } },
    });
    expect(skillEnv([skill], cfg)).toEqual({ MY_KEY: 'secret', OTHER: '1' });
    expect(
      skillEnv(
        [skill],
        config({ skills: { entries: { gated: { enabled: false, apiKey: 'secret' } } } }),
      ),
    ).toEqual({});
  });
});

describe('formatSkillsForPrompt', () => {
  it('renders the available_skills XML block', () => {
    const skill = parseSkillFile(
      '---\nname: weather\ndescription: Weather & forecasts\n---\nbody',
      loc,
    );
    expect(formatSkillsForPrompt([skill])).toBe(
      `<available_skills>\n  <skill>\n    <name>weather</name>\n    <description>Weather &amp; forecasts</description>\n    <location>/skills/demo/SKILL.md</location>\n  </skill>\n</available_skills>`,
    );
    expect(formatSkillsForPrompt([])).toBe('');
  });
});

describe('onPath', () => {
  it('finds node and rejects nonsense', () => {
    expect(onPath('node')).toBe(true);
    expect(onPath('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});
