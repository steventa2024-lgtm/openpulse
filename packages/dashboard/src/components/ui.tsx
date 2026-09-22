import type { JSX } from 'react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'err' | 'idle';
  children: ReactNode;
}): JSX.Element {
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="card">
      {(title || actions) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {title && <h3 style={{ flex: 1 }}>{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Rows<T>({
  items,
  columns,
  empty,
  onRowClick,
  keyOf,
}: {
  items: T[];
  columns: { header: string; render: (item: T) => ReactNode; width?: string }[];
  empty: string;
  onRowClick?: (item: T) => void;
  keyOf: (item: T) => string;
}): JSX.Element {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <table className="rows">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.header} style={column.width ? { width: column.width } : undefined}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr
            key={keyOf(item)}
            className={onRowClick ? 'clickable' : undefined}
            onClick={onRowClick ? () => onRowClick(item) : undefined}
          >
            {columns.map((column) => (
              <td key={column.header}>{column.render(item)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- toasts --------------------------------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'err';
}

const ToastContext = createContext<(message: string, tone?: 'info' | 'err') => void>(
  () => undefined,
);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: 'info' | 'err' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((t) => t.id !== id)),
      tone === 'err' ? 8000 : 4000,
    );
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone === 'err' ? 'err' : ''}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, tone?: 'info' | 'err') => void {
  return useContext(ToastContext);
}

/** Run a gateway call, surfacing failures as a toast instead of an unhandled rejection. */
export function useAction(): (fn: () => Promise<unknown>, success?: string) => Promise<void> {
  const toast = useToast();
  return useCallback(
    async (fn, success) => {
      try {
        await fn();
        if (success) toast(success);
      } catch (error) {
        toast((error as Error).message, 'err');
      }
    },
    [toast],
  );
}
