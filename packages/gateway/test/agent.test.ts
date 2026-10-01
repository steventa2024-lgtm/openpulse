import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ChatEvent } from '../src/agent/runner.js';
import { stripHeartbeatToken, isSilentReply, HEARTBEAT_TOKEN } from '../src/agent/system-prompt.js';
import { readTranscript, textOf } from '../src/sessions/transcript.js';
import { makeRuntime, tempDir } from './helpers.js';
import type { ScriptedStep } from './llm-helpers.js';

const MAIN = 'agent:main:main';

describe('agent runner', () => {
  it('builds the OpenClaw-style system prompt and records the exchange', async () => {
    const { rt, script } = await makeRuntime([{ text: 'Hello!' }]);
    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'hi',
      source: { kind: 'user', channel: 'webchat' },
    });

    expect(result.text).toBe('Hello!');
    const system = script.system();
    expect(system).toContain('## Tooling');
    expect(system).toContain('## Safety');
    expect(system).toContain('## Skills (mandatory)');
    expect(system).toContain('<available_skills>');
    expect(system).toContain('memory_search / memory_get'); // main session only
    expect(system).toContain('## Workspace');
    expect(system).toContain('## Heartbeats');
    expect(system).toContain(HEARTBEAT_TOKEN);
    expect(system).toContain('# Project Context');
    expect(system).toContain('# AGENTS.md — how to operate'); // bootstrap file injected
    expect(system).toMatch(/Runtime: agent=main \| host=/);
    expect(script.toolNames()).toEqual(
      expect.arrayContaining([
        'read',
        'write',
        'edit',
        'exec',
        'process',
        'cron',
        'message',
        'memory_search',
        'session_status',
      ]),
    );

    const entry = (await rt.sessions.get(MAIN))!;
    const transcript = await readTranscript(rt.sessions.transcriptFile(entry));
    expect(transcript.map((e) => e.message.role)).toEqual(['user', 'assistant']);
    expect(textOf(transcript[1]!.message.content)).toBe('Hello!');
    expect(entry.totalTokens).toBeGreaterThan(0);
  });

  it('tells the agent which project is open, so relative paths mean files in it', async () => {
    const { rt, script } = await makeRuntime([{ text: 'ok' }, { text: 'ok' }]);
    await rt.agent.runAndWait({ sessionKey: MAIN, message: 'hi', source: { kind: 'user' } });
    expect(script.system(0)).not.toContain('## Active project');

    const projectDir = await tempDir('openpulse-project-');
    const project = await rt.projects.add({ path: projectDir, name: 'demo-app' });
    await rt.projects.setActive(project.id);
    await rt.agent.runAndWait({ sessionKey: MAIN, message: 'hi', source: { kind: 'user' } });
    expect(script.system(1)).toContain('## Active project');
    expect(script.system(1)).toContain(`"demo-app" open at ${project.path}`);
  });

  it('omits MEMORY.md guidance outside the main session', async () => {
    const { rt, script } = await makeRuntime([{ text: 'ok' }]);
    await rt.agent.runAndWait({
      sessionKey: 'agent:main:telegram:group:-100',
      message: 'hi',
      source: { kind: 'user', channel: 'telegram' },
    });
    expect(script.system()).not.toContain('memory_search / memory_get');
  });

  it('runs tools, streams events and feeds results back', async () => {
    const { rt, script } = await makeRuntime([
      { text: 'Reading it.', toolCalls: [{ name: 'read', input: { path: 'AGENTS.md' } }] },
      { text: 'It explains how I operate.' },
    ]);
    const agentEvents: AgentEvent[] = [];
    const chatEvents: ChatEvent[] = [];
    rt.agent.on('agent', (e) => agentEvents.push(e));
    rt.agent.on('chat', (e) => chatEvents.push(e));

    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'what is AGENTS.md?',
      source: { kind: 'user' },
    });
    expect(result.text).toBe('It explains how I operate.');
    expect(result.toolCalls).toBe(1);

    const toolEvents = agentEvents.filter((e) => e.stream === 'tool');
    expect(toolEvents.map((e) => e.data.phase)).toEqual(['start', 'result']);
    expect(toolEvents[0]!.data.summary).toBe('read AGENTS.md');
    expect(String(toolEvents[1]!.data.result)).toContain('AGENTS.md — how to operate');
    expect(agentEvents.filter((e) => e.stream === 'assistant').length).toBeGreaterThan(1); // streamed deltas
    expect(agentEvents.at(-1)).toMatchObject({ stream: 'lifecycle', data: { phase: 'end' } });
    expect(chatEvents.at(-1)).toMatchObject({ state: 'final' });

    // Second model call saw the tool result.
    expect(script.transcript(1).join('\n')).toMatch(/\[call read\][\s\S]*AGENTS\.md/);

    const transcript = await readTranscript(
      rt.sessions.transcriptFile((await rt.sessions.get(MAIN))!),
    );
    expect(transcript.map((e) => e.message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
  });

  it('reports a missing model provider as an error instead of throwing', async () => {
    const { rt } = await makeRuntime([], { runtime: { modelFactory: undefined } });
    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'hi',
      source: { kind: 'user' },
    });
    expect(result.error).toMatch(/No API key for "anthropic"/);
  });

  it('can be aborted while a tool is running and records the abort', async () => {
    const sleep = process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20';
    const { rt } = await makeRuntime([
      {
        text: 'Working on it…',
        toolCalls: [{ name: 'exec', input: { command: sleep, yieldMs: 60_000 } }],
      },
      { text: 'later' },
    ]);

    const started = new Promise<void>((resolve) => {
      rt.agent.on('agent', (e) => {
        if (e.stream === 'tool' && e.data.phase === 'start') resolve();
      });
    });
    const run = rt.agent.runAndWait({ sessionKey: MAIN, message: 'go', source: { kind: 'user' } });
    await started;
    expect(rt.agent.abort(MAIN)).toBe(true);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.text).toContain('Working on it');
    const t = await readTranscript(rt.sessions.transcriptFile((await rt.sessions.get(MAIN))!));
    expect(
      t.some((e) => e.message.role === 'assistant' && e.message.stopReason === 'aborted'),
    ).toBe(true);
  }, 30_000);

  it('serialises turns per session and prefixes queued system events', async () => {
    const { rt, script } = await makeRuntime([{ text: 'one' }, { text: 'two' }]);
    rt.agent.enqueueSystemEvent(MAIN, 'Cron job "backup" finished');
    const [a, b] = await Promise.all([
      rt.agent.runAndWait({ sessionKey: MAIN, message: 'first', source: { kind: 'user' } }),
      rt.agent.runAndWait({ sessionKey: MAIN, message: 'second', source: { kind: 'user' } }),
    ]);
    expect([a.text, b.text]).toEqual(['one', 'two']);
    expect(script.transcript(0)[0]).toBe('user: System: Cron job "backup" finished\n\nfirst');
    expect(script.transcript(1)).toEqual([
      'user: System: Cron job "backup" finished\n\nfirst',
      'assistant: one',
      'user: second',
    ]);
  });
});

describe('chat commands', () => {
  it('handles /help, /status, /model, /think, /new without calling the model', async () => {
    const { rt, script } = await makeRuntime([{ text: 'should not run' }]);
    const send = (message: string) =>
      rt.agent.dispatch({
        sessionKey: MAIN,
        message,
        source: { kind: 'user', channel: 'telegram', senderId: '42', senderName: 'Steve' },
      });

    expect((await send('/help')).reply).toMatch(/\/new \[model\]/);
    expect((await send('/status')).reply).toMatch(
      /OpenPulse status[\s\S]*Model: anthropic\/claude-opus-5/,
    );
    expect((await send('/model openai/gpt-5')).reply).toMatch(/Model set to openai\/gpt-5/);
    expect((await rt.sessions.get(MAIN))?.modelOverride).toBe('openai/gpt-5');
    expect((await send('/think high')).reply).toBe('Thinking level: high.');
    expect((await send('/think sideways')).reply).toMatch(/Usage: \/think/);
    expect((await send('/whoami')).reply).toBe('You are Steve (telegram:42).');

    const before = (await rt.sessions.get(MAIN))!.sessionId;
    expect((await send('/new')).reply).toMatch(/New session started/);
    expect((await rt.sessions.get(MAIN))!.sessionId).not.toBe(before);
    expect((await rt.sessions.get(MAIN))!.thinkingLevel).toBe('high'); // preserved across reset
    expect(script.count).toBe(0);
  });

  it('routes unknown slash commands to the model', async () => {
    const { rt, script } = await makeRuntime([{ text: 'I do not know /banana' }]);
    const r = await rt.agent.dispatch({
      sessionKey: MAIN,
      message: '/banana',
      source: { kind: 'user' },
    });
    expect(r.status).toBe('started');
    await vi.waitFor(() => expect(script.count).toBe(1));
  });

  it('answers exec approvals from chat with /approve', async () => {
    const { rt } = await makeRuntime([]);
    const pending = rt.approvals.request({
      command: 'rm x',
      cwd: '/w',
      agentId: 'main',
      sessionKey: MAIN,
      risk: { level: 'high', reason: 'deletes files' },
    });
    const id = await vi.waitFor(() => {
      const list = rt.approvals.list();
      expect(list).toHaveLength(1);
      return list[0]!.id;
    });
    const r = await rt.agent.dispatch({
      sessionKey: MAIN,
      message: `/approve ${id} deny`,
      source: { kind: 'user', channel: 'telegram', senderId: '42' },
    });
    expect(r.reply).toMatch(/deny/);
    expect(await pending).toMatchObject({ decision: 'deny', resolvedBy: 'telegram:42' });
  });
});

describe('exec tool + approvals integration', () => {
  it('asks before a destructive command and does not run it when denied', async () => {
    const isWindows = process.platform === 'win32';
    const steps: ScriptedStep[] = [];
    const { rt } = await makeRuntime(steps);
    const victim = path.join(rt.workspaceDir, 'victim.txt');
    await fs.writeFile(victim, 'precious');
    const command = isWindows ? `Remove-Item '${victim}'` : `rm '${victim}'`;
    steps.push({ toolCalls: [{ name: 'exec', input: { command } }] }, { text: 'It was denied.' });

    const requested = vi.fn((a: { id: string }) => rt.approvals.resolve(a.id, 'deny', 'test'));
    rt.approvals.on('requested', requested);

    const result = await rt.agent.runAndWait({
      sessionKey: MAIN,
      message: 'delete it',
      source: { kind: 'user' },
    });
    expect(requested).toHaveBeenCalledOnce();
    expect(result.text).toBe('It was denied.');
    expect(await fs.readFile(victim, 'utf8')).toBe('precious');
  });

  it('runs read-only commands without asking', async () => {
    const { rt } = await makeRuntime([
      { toolCalls: [{ name: 'exec', input: { command: 'echo hello' } }] },
      { text: 'It said hello.' },
    ]);
    const requested = vi.fn();
    rt.approvals.on('requested', requested);
    await rt.agent.runAndWait({ sessionKey: MAIN, message: 'say hello', source: { kind: 'user' } });
    expect(requested).not.toHaveBeenCalled();
    const transcript = await readTranscript(
      rt.sessions.transcriptFile((await rt.sessions.get(MAIN))!),
    );
    expect(
      textOf(transcript.find((e) => e.message.role === 'toolResult')!.message.content),
    ).toMatch(/Exit code 0[\s\S]*hello/);
  });
});

describe('heartbeat token handling', () => {
  it.each([
    [HEARTBEAT_TOKEN, true, ''],
    [`\`${HEARTBEAT_TOKEN}\``, true, ''],
    [`${HEARTBEAT_TOKEN} — nothing due`, true, 'nothing due'],
    [`All quiet. ${HEARTBEAT_TOKEN}`, true, 'All quiet.'],
    ['Disk is 95% full!', false, 'Disk is 95% full!'],
  ])('%s → ok=%s', (text, ok, rest) => {
    expect(stripHeartbeatToken(text, 300)).toEqual({ ok, text: rest });
  });

  it('treats a long message alongside the token as an alert', () => {
    const long = `${HEARTBEAT_TOKEN} ${'x'.repeat(400)}`;
    expect(stripHeartbeatToken(long, 300).ok).toBe(false);
  });

  it('detects the silent reply token', () => {
    expect(isSilentReply('NO_REPLY')).toBe(true);
    expect(isSilentReply('**NO_REPLY**')).toBe(true);
    expect(isSilentReply('no reply needed')).toBe(false);
  });
});
