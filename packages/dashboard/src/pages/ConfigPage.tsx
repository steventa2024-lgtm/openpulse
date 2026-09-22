import type { JSX } from 'react';
import { useState } from 'react';
import { Card, PageHead, Pill, useAction, useToast } from '../components/ui.js';
import { useGateway, useGatewayEvent, useQuery } from '../gateway/provider.js';
import type { ConfigSnapshot } from '../types.js';

export function ConfigPage(): JSX.Element {
  const { request } = useGateway();
  const act = useAction();
  const toast = useToast();
  const snapshot = useQuery<ConfigSnapshot>('config.get');
  // `edit` is undefined until the operator types, so the editor follows the file until then.
  const [edit, setEdit] = useState<string>();
  const raw = snapshot.data?.raw ?? '';
  const baseHash = snapshot.data?.hash ?? '';
  const draft = edit ?? raw;
  const dirty = edit !== undefined && edit !== raw;
  const [saving, setSaving] = useState(false);

  useGatewayEvent('config.changed', () => {
    if (!dirty) snapshot.reload();
    else toast('The config changed on disk — reload before saving to avoid a conflict.', 'err');
  });

  const save = async () => {
    setSaving(true);
    await act(async () => {
      const result = await request<{ hash: string; valid: boolean; restartRequired: boolean }>(
        'config.apply',
        { raw: draft, baseHash },
      );
      setEdit(undefined);
      snapshot.reload();
      toast(
        result.restartRequired
          ? 'Saved — restart the gateway for the new port or bind address'
          : 'Saved and reloaded',
      );
    });
    setSaving(false);
  };

  return (
    <>
      <PageHead
        title="Config"
        subtitle={snapshot.data?.path}
        actions={
          <>
            <button
              className="btn"
              onClick={() => {
                setEdit(undefined);
                snapshot.reload();
              }}
            >
              Reload
            </button>
            <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
              Save
            </button>
          </>
        }
      />

      <Card
        title="openpulse.json"
        actions={
          snapshot.data ? (
            snapshot.data.valid ? (
              <Pill tone="ok">valid</Pill>
            ) : (
              <Pill tone="err">invalid</Pill>
            )
          ) : null
        }
      >
        <textarea
          className="editor"
          spellCheck={false}
          value={draft}
          onChange={(event) => setEdit(event.target.value)}
        />
        {snapshot.data?.issues?.length ? (
          <ul className="issues">
            {snapshot.data.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
        <p className="faint" style={{ marginBottom: 0 }}>
          JSON5 is accepted (comments, trailing commas). Unknown keys are rejected, and{' '}
          <code>${'{ENV_VAR}'}</code> is substituted from the environment. Saving writes the file
          and hot-reloads everything except the port and bind address.
        </p>
      </Card>
    </>
  );
}
