import type { JSX } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  GatewayConnection,
  RequestError,
  fetchControlConfig,
  type ClientStatus,
} from './client.js';

interface GatewayContextValue {
  connection: GatewayConnection;
  status: ClientStatus;
  assistantName: string;
  request: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<T>;
  setToken: (token: string) => void;
}

const GatewayContext = createContext<GatewayContextValue | undefined>(undefined);

/** Where the gateway lives: same origin in production, the proxy target during `vite dev`. */
function gatewayOrigin(): string {
  const override = new URLSearchParams(window.location.search).get('gateway');
  if (override) return override.replace(/\/$/, '');
  if (window.location.port === '5173')
    return `${window.location.protocol}//${window.location.hostname}:18789`;
  return window.location.origin;
}

export function GatewayProvider({ children }: { children: ReactNode }): JSX.Element {
  const origin = useMemo(() => gatewayOrigin(), []);
  const connection = useMemo(
    () => new GatewayConnection(`${origin.replace(/^http/, 'ws')}/`),
    [origin],
  );
  const [status, setStatus] = useState<ClientStatus>(connection.status);
  const [assistantName, setAssistantName] = useState('OpenPulse');

  useEffect(() => {
    let cancelled = false;
    void fetchControlConfig(origin)
      .then((cfg) => {
        if (cancelled) return;
        if (cfg.token) window.__OPENPULSE_TOKEN__ = cfg.token;
        setAssistantName(cfg.assistantName || 'OpenPulse');
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) connection.start();
      });
    const off = connection.onStatus(setStatus);
    return () => {
      cancelled = true;
      off();
      connection.stop();
    };
  }, [connection, origin]);

  const request = useCallback(
    <T,>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) =>
      connection.request<T>(method, params, timeoutMs),
    [connection],
  );

  const setToken = useCallback((token: string) => connection.setToken(token), [connection]);

  const value = useMemo(
    () => ({ connection, status, assistantName, request, setToken }),
    [connection, status, assistantName, request, setToken],
  );
  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error('useGateway must be used inside <GatewayProvider>');
  return ctx;
}

/** Subscribe to one gateway event for as long as the component is mounted. */
export function useGatewayEvent(
  event: string | string[],
  handler: (payload: unknown, event: string) => void,
): void {
  const { connection } = useGateway();
  const ref = useRef(handler);
  const names = Array.isArray(event) ? event : [event];
  const key = names.join(',');

  useEffect(() => {
    ref.current = handler;
  });

  useEffect(() => {
    const wanted = key.split(',');
    return connection.onEvent((name, payload) => {
      if (wanted.includes(name)) ref.current(payload, name);
    });
  }, [connection, key]);
}

export interface Query<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Call a gateway method and keep the result. Re-runs when `deps` change, when the connection
 * comes back, and whenever `reload()` is called (event handlers use this to stay fresh).
 */
export function useQuery<T>(
  method: string,
  params: Record<string, unknown> = {},
  deps: unknown[] = [],
): Query<T> {
  const { request, status } = useGateway();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    if (status.state !== 'open') return;
    let cancelled = false;
    request<T>(method, JSON.parse(paramsKey) as Record<string, unknown>)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof RequestError ? `${e.code}: ${e.message}` : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, method, paramsKey, nonce, status.state, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
