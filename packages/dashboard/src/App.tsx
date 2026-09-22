import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Pill, ToastProvider } from './components/ui.js';
import { GatewayProvider, useGateway, useGatewayEvent } from './gateway/provider.js';
import type { HealthSnapshot } from './types.js';
import { ChannelsPage } from './pages/ChannelsPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { CronPage } from './pages/CronPage.js';
import { DebugPage } from './pages/DebugPage.js';
import { DocsPage } from './pages/DocsPage.js';
import { InstancesPage } from './pages/InstancesPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { NodesPage } from './pages/NodesPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { SessionsPage } from './pages/SessionsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';

interface Route {
  id: string;
  label: string;
  group: string;
  icon: string;
  element: () => JSX.Element;
}

const ROUTES: Route[] = [
  { id: 'chat', label: 'Chat', group: 'Chat', icon: '✦', element: ChatPage },
  { id: 'overview', label: 'Overview', group: 'Control', icon: '◉', element: OverviewPage },
  { id: 'channels', label: 'Channels', group: 'Control', icon: '⇄', element: ChannelsPage },
  { id: 'instances', label: 'Instances', group: 'Control', icon: '❏', element: InstancesPage },
  { id: 'sessions', label: 'Sessions', group: 'Control', icon: '☰', element: SessionsPage },
  { id: 'cron', label: 'Cron Jobs', group: 'Control', icon: '⏱', element: CronPage },
  { id: 'skills', label: 'Skills', group: 'Agent', icon: '✸', element: SkillsPage },
  { id: 'nodes', label: 'Nodes', group: 'Agent', icon: '⬡', element: NodesPage },
  { id: 'config', label: 'Config', group: 'Settings', icon: '⚙', element: ConfigPage },
  { id: 'debug', label: 'Debug', group: 'Settings', icon: '❖', element: DebugPage },
  { id: 'logs', label: 'Logs', group: 'Settings', icon: '▤', element: LogsPage },
  { id: 'docs', label: 'Docs', group: 'Resources', icon: '◈', element: DocsPage },
];

const GROUPS = ['Chat', 'Control', 'Agent', 'Settings', 'Resources'];

function useHashRoute(): [string, (id: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, '') || 'chat');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.replace(/^#\/?/, '') || 'chat');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = (id: string) => {
    window.location.hash = `#/${id}`;
  };
  return [route, navigate];
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('openpulse.theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('openpulse.theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

function HealthPill(): JSX.Element {
  const { status, request } = useGateway();
  const [health, setHealth] = useState<HealthSnapshot>();

  useEffect(() => {
    if (status.state !== 'open') return;
    let alive = true;
    const poll = () =>
      request<HealthSnapshot>('health')
        .then((h) => alive && setHealth(h))
        .catch(() => undefined);
    void poll();
    const timer = window.setInterval(poll, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [request, status.state]);

  useGatewayEvent('tick', () => undefined);

  if (status.state !== 'open') {
    const label =
      status.state === 'connecting'
        ? 'Connecting'
        : status.state === 'closed'
          ? 'Reconnecting'
          : 'Disconnected';
    return (
      <Pill tone={status.state === 'connecting' || status.state === 'closed' ? 'warn' : 'err'}>
        {label}
      </Pill>
    );
  }
  if (!health) return <Pill tone="idle">Health …</Pill>;
  const degraded = !health.configValid || health.channels.some((c) => c.configured && !c.connected);
  return <Pill tone={degraded ? 'warn' : 'ok'}>{degraded ? 'Health degraded' : 'Health OK'}</Pill>;
}

function ApprovalsPill({ onClick }: { onClick: () => void }): JSX.Element | null {
  const { request, status } = useGateway();
  const [count, setCount] = useState(0);

  const refresh = () =>
    request<{ pending: unknown[] }>('exec.approval.list')
      .then((r) => setCount(r.pending.length))
      .catch(() => undefined);

  useEffect(() => {
    if (status.state === 'open') void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state]);
  useGatewayEvent(['exec.approval.requested', 'exec.approval.resolved'], () => void refresh());

  if (count === 0) return null;
  return (
    <button className="btn ghost" onClick={onClick} style={{ color: 'var(--warn)' }}>
      ⚠ {count} approval{count === 1 ? '' : 's'}
    </button>
  );
}

function Shell(): JSX.Element {
  const [route, navigate] = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const { status, assistantName } = useGateway();
  const active = ROUTES.find((r) => r.id === route) ?? ROUTES[0]!;
  const Page = active.element;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <span>{assistantName.toUpperCase()}</span>
          <span className="sep">/</span>
          <span className="sub">Gateway Dashboard</span>
        </div>
        <div className="spacer" />
        <ApprovalsPill onClick={() => navigate('chat')} />
        <span className="faint mono" style={{ fontSize: 11 }}>
          {status.hello?.server.version ? `v${status.hello.server.version}` : ''}
        </span>
        <HealthPill />
        <button
          className="icon"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      <nav className="sidebar">
        {GROUPS.map((group) => (
          <div className="nav-group" key={group}>
            <h4>{group}</h4>
            {ROUTES.filter((r) => r.group === group).map((item) => (
              <button
                key={item.id}
                className="nav-item"
                aria-current={item.id === active.id ? 'page' : undefined}
                onClick={() => navigate(item.id)}
              >
                <span aria-hidden>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <main className="main">
        {status.state === 'unauthorized' || status.state === 'pairing-required' ? (
          <Gate />
        ) : (
          <Page />
        )}
      </main>
    </div>
  );
}

/** Shown when the gateway refuses this browser: ask for a token, or explain device pairing. */
function Gate(): JSX.Element {
  const { status, setToken } = useGateway();
  const [value, setValue] = useState('');

  if (status.state === 'pairing-required') {
    return (
      <div className="gate card">
        <h3>Pairing required</h3>
        <p className="muted">
          This browser is not paired with the gateway yet. On the machine running OpenPulse, approve
          it:
        </p>
        <pre className="mono">
          openpulse devices list{'\n'}openpulse devices approve &lt;requestId&gt;
        </pre>
        <p className="faint">{status.error}</p>
      </div>
    );
  }

  return (
    <div className="gate card">
      <h3>Gateway token</h3>
      <p className="muted">
        The gateway rejected this browser. Paste the token from openpulse.json (gateway.auth.token).
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) setToken(value.trim());
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="gateway token"
          autoFocus
        />
        <button className="btn primary" type="submit" style={{ marginTop: '0.6rem' }}>
          Connect
        </button>
      </form>
      <p className="faint" style={{ marginBottom: 0 }}>
        {status.error}
      </p>
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <GatewayProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </GatewayProvider>
  );
}
