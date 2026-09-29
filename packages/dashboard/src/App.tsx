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
import { ProjectsPage } from './pages/ProjectsPage.js';
import { GitPage } from './pages/GitPage.js';
import { EditorPage } from './pages/EditorPage.js';
import { ChangesPage } from './pages/ChangesPage.js';
import { CheckpointsPage } from './pages/CheckpointsPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { MonitoringPage } from './pages/MonitoringPage.js';
import { WorkflowsPage } from './pages/WorkflowsPage.js';
import { TestsPage } from './pages/TestsPage.js';
import { DebuggerPage } from './pages/DebuggerPage.js';
import { McpPage } from './pages/McpPage.js';
import { SecurityPage } from './pages/SecurityPage.js';
import { ProjectProvider, useProject } from './project/provider.js';

interface Route {
  id: string;
  label: string;
  group: string;
  icon: string;
  element: () => JSX.Element;
}

const ROUTES: Route[] = [
  // Home
  { id: 'overview', label: 'Overview', group: 'Home', icon: '◉', element: OverviewPage },
  // Workspace
  { id: 'projects', label: 'Projects', group: 'Workspace', icon: '▦', element: ProjectsPage },
  { id: 'editor', label: 'Editor', group: 'Workspace', icon: '✎', element: EditorPage },
  { id: 'git', label: 'Git', group: 'Workspace', icon: '⑂', element: GitPage },
  { id: 'changes', label: 'Changes', group: 'Workspace', icon: '±', element: ChangesPage },
  {
    id: 'checkpoints',
    label: 'Checkpoints',
    group: 'Workspace',
    icon: '⟲',
    element: CheckpointsPage,
  },
  // AI
  { id: 'chat', label: 'Chat', group: 'AI', icon: '✦', element: ChatPage },
  { id: 'workflows', label: 'Workflows', group: 'AI', icon: '⋔', element: WorkflowsPage },
  { id: 'models', label: 'Models', group: 'AI', icon: '◇', element: ModelsPage },
  { id: 'monitoring', label: 'Monitoring', group: 'AI', icon: '∿', element: MonitoringPage },
  { id: 'sessions', label: 'Sessions', group: 'AI', icon: '☰', element: SessionsPage },
  // Automation
  { id: 'cron', label: 'Cron Jobs', group: 'Automation', icon: '⏱', element: CronPage },
  { id: 'channels', label: 'Channels', group: 'Automation', icon: '⇄', element: ChannelsPage },
  // Developer tools
  { id: 'tests', label: 'Tests', group: 'Developer tools', icon: '✓', element: TestsPage },
  { id: 'debugger', label: 'Debugger', group: 'Developer tools', icon: '⌕', element: DebuggerPage },
  { id: 'mcp', label: 'MCP', group: 'Developer tools', icon: '⧉', element: McpPage },
  { id: 'skills', label: 'Skills', group: 'Developer tools', icon: '✸', element: SkillsPage },
  // System
  { id: 'security', label: 'Permissions', group: 'System', icon: '⛨', element: SecurityPage },
  { id: 'config', label: 'Config', group: 'System', icon: '⚙', element: ConfigPage },
  { id: 'debug', label: 'Diagnostics', group: 'System', icon: '❖', element: DebugPage },
  { id: 'logs', label: 'Logs', group: 'System', icon: '▤', element: LogsPage },
  { id: 'nodes', label: 'Devices', group: 'System', icon: '⬡', element: NodesPage },
  { id: 'instances', label: 'Instances', group: 'System', icon: '❏', element: InstancesPage },
  { id: 'docs', label: 'Docs', group: 'System', icon: '◈', element: DocsPage },
];

const GROUPS = ['Home', 'Workspace', 'AI', 'Automation', 'Developer tools', 'System'];

/** Routes used before the navigation was reorganised keep working. */
const ALIASES: Record<string, string> = {};

function useHashRoute(): [string, (id: string) => void] {
  const read = () => {
    const id = window.location.hash.replace(/^#\/?/, '') || 'overview';
    return ALIASES[id] ?? id;
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
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
        <ProjectSwitcher onManage={() => navigate('projects')} />
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

/** The active project, switchable from anywhere. Every workspace page follows it. */
function ProjectSwitcher({ onManage }: { onManage: () => void }): JSX.Element | null {
  const { projects, active, select } = useProject();
  const { status } = useGateway();
  if (status.state !== 'open') return null;
  if (projects.length === 0) {
    return (
      <button className="btn ghost project-switcher" onClick={onManage}>
        ＋ Add a project
      </button>
    );
  }
  return (
    <select
      className="project-switcher"
      value={active?.id ?? ''}
      onChange={(event) => {
        if (event.target.value === '__manage') onManage();
        else void select(event.target.value);
      }}
      aria-label="Active project"
      title={active?.path}
    >
      {!active && <option value="">Choose a project…</option>}
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
      <option value="__manage">Manage projects…</option>
    </select>
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
      <ProjectProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </ProjectProvider>
    </GatewayProvider>
  );
}
