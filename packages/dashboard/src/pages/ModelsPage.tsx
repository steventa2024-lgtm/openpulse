import type { JSX } from 'react';
import { useState } from 'react';
import { Card, Empty, Field, PageHead, Pill, Rows, useAction } from '../components/ui.js';
import { useGateway, useQuery } from '../gateway/provider.js';
import { bytes, duration } from '../format.js';

interface DetectedModel {
  id: string;
  ref: string;
  label: string;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  quantisation?: string;
}

interface ProviderProbe {
  id: 'ollama' | 'lmstudio';
  label: string;
  baseUrl: string;
  installed: boolean;
  running: boolean;
  version?: string;
  models: DetectedModel[];
  error?: string;
  hint?: string;
}

interface DetectResponse {
  local: ProviderProbe[];
  hosted: {
    id: 'anthropic' | 'openai';
    label: string;
    configured: boolean;
    source: string | null;
  }[];
  current: { primary: string; fallbacks: string[]; thinking: string };
}

interface TestResult {
  ok: boolean;
  model: string;
  durationMs: number;
  text?: string;
  error?: string;
  toolCallingSupported?: boolean;
  usage?: { input: number; output: number };
}

interface ModelDetails {
  contextLength?: number;
  supportsTools?: boolean;
  family?: string;
  warnings: string[];
}

const HOSTED_MODELS: Record<string, { ref: string; label: string }[]> = {
  anthropic: [
    { ref: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
    { ref: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    { ref: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  openai: [{ ref: 'openai/gpt-5', label: 'GPT-5' }],
};

export function ModelsPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const detect = useQuery<DetectResponse>('models.detect');
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({});
  const [details, setDetails] = useState<Record<string, ModelDetails | 'loading'>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [fallback, setFallback] = useState('');

  const current = detect.data?.current;

  const test = async (ref: string) => {
    setTests((t) => ({ ...t, [ref]: 'running' }));
    try {
      const result = await request<TestResult>('models.test', { model: ref }, 200_000);
      setTests((t) => ({ ...t, [ref]: result }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [ref]: { ok: false, model: ref, durationMs: 0, error: (e as Error).message },
      }));
    }
  };

  const inspect = async (ref: string) => {
    setDetails((d) => ({ ...d, [ref]: 'loading' }));
    try {
      const result = await request<ModelDetails>('models.inspect', { model: ref });
      setDetails((d) => ({ ...d, [ref]: result }));
    } catch (e) {
      setDetails((d) => ({ ...d, [ref]: { warnings: [(e as Error).message] } }));
    }
  };

  const use = (ref: string) =>
    act(async () => {
      await request('models.use', { primary: ref });
      detect.reload();
    }, `${ref} is now the default model`);

  return (
    <>
      <PageHead
        title="Models"
        subtitle="Connect a local or hosted model. Local models need no API key."
        actions={
          <button className="btn" onClick={() => detect.reload()}>
            Detect again
          </button>
        }
      />

      <Card title="Current setup">
        {current ? (
          <dl className="kv">
            <dt>Default model</dt>
            <dd className="mono">{current.primary}</dd>
            <dt>Fallbacks</dt>
            <dd className="mono">
              {current.fallbacks.length ? current.fallbacks.join(', ') : 'none'}
            </dd>
            <dt>Thinking</dt>
            <dd>{current.thinking}</dd>
          </dl>
        ) : (
          <Empty>{detect.error ?? 'Looking…'}</Empty>
        )}
        <div className="toolbar" style={{ marginTop: '0.75rem' }}>
          <button
            className="btn"
            onClick={() => current && void test(current.primary)}
            disabled={!current || tests[current.primary] === 'running'}
          >
            {current && tests[current.primary] === 'running'
              ? 'Testing…'
              : 'Test the default model'}
          </button>
          {current && <TestOutcome result={tests[current.primary]} />}
        </div>
      </Card>

      {(detect.data?.local ?? []).map((provider) => (
        <Card
          key={provider.id}
          title={provider.label}
          actions={
            provider.running ? (
              <Pill tone="ok">running{provider.version ? ` · v${provider.version}` : ''}</Pill>
            ) : (
              <Pill tone="idle">not running</Pill>
            )
          }
        >
          <p className="faint mono" style={{ marginTop: 0, fontSize: 12 }}>
            {provider.baseUrl}
          </p>
          {provider.error && <p style={{ color: 'var(--warn)' }}>{provider.error}</p>}
          {provider.hint && <p className="muted">{provider.hint}</p>}
          <Rows
            items={provider.models}
            keyOf={(m) => m.ref}
            empty={provider.running ? 'No models installed.' : 'Start it to see its models.'}
            columns={[
              {
                header: '',
                width: '5rem',
                render: (m) => (m.ref === current?.primary ? <Pill tone="ok">default</Pill> : null),
              },
              {
                header: 'Model',
                render: (m) => (
                  <>
                    <div className="mono">{m.id}</div>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {[
                        m.family,
                        m.parameterSize,
                        m.quantisation,
                        m.sizeBytes ? bytes(m.sizeBytes) : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <ModelDetailsLine details={details[m.ref]} />
                  </>
                ),
              },
              { header: 'Test', render: (m) => <TestOutcome result={tests[m.ref]} /> },
              {
                header: '',
                render: (m) => (
                  <span style={{ display: 'flex', gap: '0.4rem' }}>
                    {provider.id === 'ollama' && (
                      <button className="btn ghost" onClick={() => void inspect(m.ref)}>
                        Inspect
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() => void test(m.ref)}
                      disabled={tests[m.ref] === 'running'}
                    >
                      {tests[m.ref] === 'running' ? 'Testing…' : 'Test'}
                    </button>
                    {m.ref !== current?.primary && (
                      <button className="btn primary" onClick={() => void use(m.ref)}>
                        Use
                      </button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      ))}

      {(detect.data?.hosted ?? []).map((provider) => (
        <Card
          key={provider.id}
          title={provider.label}
          actions={
            provider.configured ? (
              <Pill tone="ok">key from {provider.source}</Pill>
            ) : (
              <Pill tone="idle">no key</Pill>
            )
          }
        >
          <form
            style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await request('models.credentials.set', {
                  provider: provider.id,
                  apiKey: keys[provider.id] ?? '',
                });
                setKeys((k) => ({ ...k, [provider.id]: '' }));
                detect.reload();
              }, 'Key saved');
            }}
          >
            <Field label="API key (stored in openpulse.json, never shown again)">
              <input
                type="password"
                value={keys[provider.id] ?? ''}
                onChange={(e) => setKeys((k) => ({ ...k, [provider.id]: e.target.value }))}
                placeholder={provider.configured ? 'Replace the stored key' : 'Paste a key'}
                autoComplete="off"
              />
            </Field>
            <button className="btn" type="submit" style={{ marginBottom: '0.75rem' }}>
              Save key
            </button>
          </form>
          <Rows
            items={HOSTED_MODELS[provider.id] ?? []}
            keyOf={(m) => m.ref}
            empty=""
            columns={[
              {
                header: '',
                width: '5rem',
                render: (m) => (m.ref === current?.primary ? <Pill tone="ok">default</Pill> : null),
              },
              { header: 'Model', render: (m) => <span className="mono">{m.ref}</span> },
              { header: 'Test', render: (m) => <TestOutcome result={tests[m.ref]} /> },
              {
                header: '',
                render: (m) => (
                  <span style={{ display: 'flex', gap: '0.4rem' }}>
                    <button
                      className="btn"
                      onClick={() => void test(m.ref)}
                      disabled={!provider.configured || tests[m.ref] === 'running'}
                    >
                      Test
                    </button>
                    {m.ref !== current?.primary && (
                      <button
                        className="btn primary"
                        onClick={() => void use(m.ref)}
                        disabled={!provider.configured}
                      >
                        Use
                      </button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      ))}

      <Card title="Fallback model">
        <p className="muted" style={{ marginTop: 0 }}>
          Used when the default model fails. Any model reference works, for example{' '}
          <span className="mono">ollama/qwen3:8b</span>.
        </p>
        <form
          style={{ display: 'flex', gap: '0.5rem' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!current) return;
            void act(async () => {
              await request('models.use', {
                primary: current.primary,
                fallbacks: fallback.trim() ? [fallback.trim()] : [],
              });
              setFallback('');
              detect.reload();
            }, 'Fallback saved');
          }}
        >
          <input
            type="text"
            value={fallback}
            onChange={(e) => setFallback(e.target.value)}
            placeholder="provider/model — leave empty to clear"
          />
          <button className="btn" type="submit">
            Save
          </button>
        </form>
      </Card>
    </>
  );
}

function TestOutcome({
  result,
}: {
  result: TestResult | 'running' | undefined;
}): JSX.Element | null {
  if (!result) return null;
  if (result === 'running') return <span className="faint">running a real request…</span>;
  if (!result.ok) {
    return (
      <span style={{ color: 'var(--err)', fontSize: 12 }} title={result.error}>
        ✗ {result.error?.slice(0, 120)}
      </span>
    );
  }
  return (
    <span style={{ fontSize: 12 }}>
      <span style={{ color: 'var(--ok)' }}>✓ answered in {duration(result.durationMs)}</span>
      {result.toolCallingSupported === false && (
        <span style={{ color: 'var(--warn)' }}> · no tool calls</span>
      )}
      {result.toolCallingSupported && <span className="faint"> · tools work</span>}
    </span>
  );
}

function ModelDetailsLine({
  details,
}: {
  details: ModelDetails | 'loading' | undefined;
}): JSX.Element | null {
  if (!details) return null;
  if (details === 'loading')
    return (
      <div className="faint" style={{ fontSize: 11 }}>
        inspecting…
      </div>
    );
  return (
    <div style={{ fontSize: 11, marginTop: '0.2rem' }}>
      {details.contextLength && (
        <span className="faint">context {details.contextLength.toLocaleString()} tokens · </span>
      )}
      {details.supportsTools !== undefined && (
        <span style={{ color: details.supportsTools ? 'var(--ok)' : 'var(--warn)' }}>
          {details.supportsTools ? 'tool calling' : 'no tool calling'}
        </span>
      )}
      {details.warnings.map((warning) => (
        <div key={warning} style={{ color: 'var(--warn)' }}>
          {warning}
        </div>
      ))}
    </div>
  );
}
