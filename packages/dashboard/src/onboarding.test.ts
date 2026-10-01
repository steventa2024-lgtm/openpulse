import { describe, expect, it } from 'vitest';
import { modelReadiness, type DetectSnapshot } from './onboarding.js';

function snapshot(primary: string, overrides: Partial<DetectSnapshot> = {}): DetectSnapshot {
  return {
    local: [
      {
        id: 'ollama',
        label: 'Ollama',
        running: true,
        installed: true,
        models: [
          { id: 'llama3.2:1b', ref: 'ollama/llama3.2:1b', label: 'llama3.2:1b' },
          { id: 'qwen3:8b', ref: 'ollama/qwen3:8b', label: 'qwen3:8b', supportsTools: true },
        ],
      },
      { id: 'lmstudio', label: 'LM Studio', running: false, installed: false, models: [] },
    ],
    hosted: [
      { id: 'anthropic', label: 'Anthropic', configured: false },
      { id: 'openai', label: 'OpenAI', configured: true },
    ],
    current: { primary },
    ...overrides,
  };
}

describe('modelReadiness', () => {
  it('is ready when the local model is installed on a running server', () => {
    expect(modelReadiness(snapshot('ollama/qwen3:8b')).state).toBe('ready');
  });

  it('flags a hosted model without a key and suggests a local model that can call tools', () => {
    expect(modelReadiness(snapshot('anthropic/claude-opus-5'))).toEqual({
      state: 'needs-key',
      detail: 'anthropic/claude-opus-5 needs an API key for Anthropic, and none is set.',
      suggestion: 'ollama/qwen3:8b',
    });
  });

  it('is ready for a hosted model whose key is set', () => {
    expect(modelReadiness(snapshot('openai/gpt-5')).state).toBe('ready');
  });

  it('notices a local model that is not installed, or a server that is not running', () => {
    expect(modelReadiness(snapshot('ollama/mistral:7b'))).toMatchObject({
      state: 'not-installed',
      suggestion: 'ollama/qwen3:8b',
    });
    expect(modelReadiness(snapshot('lmstudio/qwen2.5-coder-7b'))).toMatchObject({
      state: 'not-running',
      suggestion: 'ollama/qwen3:8b',
    });
  });

  it('offers no suggestion when nothing local is available', () => {
    const none = snapshot('anthropic/claude-opus-5', {
      local: [{ id: 'ollama', label: 'Ollama', running: false, installed: false, models: [] }],
    });
    expect(modelReadiness(none)).toEqual({
      state: 'needs-key',
      detail: 'anthropic/claude-opus-5 needs an API key for Anthropic, and none is set.',
    });
  });

  it('suggests a laptop-sized model that can call tools over a huge or tiny one', () => {
    const GB = 1024 ** 3;
    const many = snapshot('anthropic/claude-opus-5', {
      local: [
        {
          id: 'ollama',
          label: 'Ollama',
          running: true,
          installed: true,
          models: [
            {
              id: 'big',
              ref: 'ollama/qwen3-coder:30b',
              label: 'big',
              supportsTools: true,
              sizeBytes: 18 * GB,
            },
            {
              id: 'tiny',
              ref: 'ollama/qwen2.5-coder:1.5b',
              label: 'tiny',
              supportsTools: true,
              sizeBytes: 1 * GB,
            },
            {
              id: 'mid',
              ref: 'ollama/qwen3:8b',
              label: 'mid',
              supportsTools: true,
              sizeBytes: 5.2 * GB,
            },
            { id: 'notools', ref: 'ollama/old:7b', label: 'old', sizeBytes: 4.9 * GB },
          ],
        },
      ],
    });
    expect(modelReadiness(many)).toMatchObject({ suggestion: 'ollama/qwen3:8b' });
  });

  it('does not judge providers it knows nothing about', () => {
    expect(modelReadiness(snapshot('myproxy/some-model')).state).toBe('unknown');
  });
});
