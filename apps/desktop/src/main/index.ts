import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { GatewaySupervisor, type GatewayStatus } from './gateway-supervisor.js';
import { checkResources, resolveResources, type ResourcePaths } from './paths.js';
import { PreferencesStore, type Preferences } from './preferences.js';

const SINGLE_INSTANCE = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let supervisor: GatewaySupervisor | undefined;
let resources: ResourcePaths;
let prefs: PreferencesStore;
let quitting = false;
/** Set once the Control UI has been loaded, so status changes know whether to reload. */
let uiLoaded = false;

if (!SINGLE_INSTANCE) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void main();
}

async function main(): Promise<void> {
  process.on('uncaughtException', (error) => {
    logLine(`uncaught: ${error.stack ?? error.message}`);
    process.stderr.write(`OpenPulse main process error: ${error.stack ?? error.message}
`);
  });
  process.on('unhandledRejection', (reason) => logLine(`unhandled rejection: ${String(reason)}`));

  prefs = new PreferencesStore(path.join(app.getPath('userData'), 'desktop-preferences.json'));
  prefs.load();

  await app.whenReady();
  logLine('electron ready');
  resources = resolveResources(app.getAppPath(), app.isPackaged, process.resourcesPath);

  createWindow();
  createTray();
  registerIpc();

  logLine(`app ${app.getVersion()} starting (packaged: ${app.isPackaged})`);
  const problems = checkResources(resources);
  if (problems.length > 0) {
    await showShell('error', {
      title: 'OpenPulse is not fully installed',
      detail: problems.join('\n'),
    });
    return;
  }

  await showShell('loading', {});
  await startGateway();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
}

// ---- window -------------------------------------------------------------------------------------

function createWindow(): void {
  const { window } = prefs.current;
  mainWindow = new BrowserWindow({
    width: window.width,
    height: window.height,
    ...(window.x !== undefined && window.y !== undefined ? { x: window.x, y: window.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#101012',
    title: 'OpenPulse',
    ...(fs.existsSync(resources.iconFile) ? { icon: resources.iconFile } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (window.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (event) => {
    if (!quitting && prefs.current.minimizeToTray) {
      event.preventDefault();
      mainWindow?.hide();
      notify(
        'OpenPulse is still running',
        'Your agents keep working. Open it again from the tray.',
      );
      return;
    }
    rememberBounds();
  });

  mainWindow.on('resized', rememberBounds);
  mainWindow.on('moved', rememberBounds);
  mainWindow.on('maximize', rememberBounds);
  mainWindow.on('unmaximize', rememberBounds);

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  // Keep navigation inside the local gateway; anything else opens in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalGatewayUrl(url) && !url.startsWith('file://')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void showShell('error', {
      title: 'The window stopped responding',
      detail: `The interface crashed (${details.reason}). Reload to try again.`,
    });
  });

  Menu.setApplicationMenu(buildMenu());
}

function rememberBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  prefs.set({ window: { ...bounds, maximized } });
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    void loadCurrentView();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Show one of the shell pages (loading / error / onboarding) with a payload. */
async function showShell(
  page: 'loading' | 'error' | 'welcome',
  params: Record<string, string>,
): Promise<void> {
  if (!mainWindow) return;
  uiLoaded = false;
  const file = path.join(resources.shellDir, `${page}.html`);
  const query = new URLSearchParams(params).toString();
  await loadUrl(`file://${file.replace(/\\/g, '/')}${query ? `?${query}` : ''}`);
}

/** A navigation that tolerates being replaced by a newer one. */
async function loadUrl(url: string): Promise<void> {
  try {
    await mainWindow?.loadURL(url);
  } catch (error) {
    const code = (error as { errno?: number }).errno;
    if (code === -3) return; // ERR_ABORTED: a newer navigation replaced this one
    logLine(`load failed for ${url}: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Load whatever the current state calls for: the Control UI, or a shell page explaining why not.
 * Loads are serialised, because a navigation started while another is in flight aborts it.
 */
let pendingLoad: Promise<void> = Promise.resolve();

function loadCurrentView(): Promise<void> {
  pendingLoad = pendingLoad.catch(() => undefined).then(() => performLoad());
  return pendingLoad;
}

async function performLoad(): Promise<void> {
  const status = supervisor?.status;
  if (status && (status.state === 'ready' || status.state === 'attached') && status.url) {
    await loadUrl(status.url);
    uiLoaded = true;
    return;
  }
  if (status?.state === 'failed') {
    await showShell('error', {
      title: 'The gateway could not start',
      detail: [status.error, status.hint].filter(Boolean).join('\n'),
    });
    return;
  }
  await showShell('loading', {});
}

// ---- gateway ------------------------------------------------------------------------------------

async function startGateway(): Promise<void> {
  supervisor = new GatewaySupervisor({
    entry: resources.gatewayEntry,
    nodeBin: process.execPath,
    port: prefs.current.port,
    env: {
      OPENPULSE_CONTROL_UI_DIR: resources.controlUiDir,
      OPENPULSE_BUNDLED_SKILLS_DIR: resources.bundledSkillsDir,
    },
  });

  supervisor.on('status', (status) => {
    // Remember a port we had to fall back to, so the next launch starts there.
    logLine(
      `gateway ${status.state}${status.port ? ` on ${status.port}` : ''}${status.error ? `: ${status.error}` : ''}`,
    );
    if (status.port && status.port !== prefs.current.port) prefs.set({ port: status.port });
    mainWindow?.webContents.send('openpulse:gateway-status', status);
    updateTray(status);
    void onStatusChange(status);
  });
  supervisor.on('log', (entry) => {
    logLine(`gateway[${entry.stream}] ${entry.line}`);
    mainWindow?.webContents.send('openpulse:gateway-log', entry);
  });

  if (!prefs.current.autoStartGateway) {
    await showShell('error', {
      title: 'Gateway start is turned off',
      detail: 'Start it from the tray menu, or turn "Start gateway with OpenPulse" back on.',
    });
    return;
  }
  await supervisor.start();
  await loadCurrentView();
}

/** React to supervisor transitions: swap views, and tell the operator when something breaks. */
async function onStatusChange(status: GatewayStatus): Promise<void> {
  if ((status.state === 'ready' || status.state === 'attached') && !uiLoaded) {
    await loadCurrentView();
    return;
  }
  if (status.state === 'failed') {
    notify('OpenPulse gateway stopped', status.error ?? 'The gateway is not running.');
    if (uiLoaded) await loadCurrentView();
    return;
  }
  if (status.state === 'restarting' && uiLoaded) {
    uiLoaded = false;
    await showShell('loading', { detail: 'The gateway stopped unexpectedly. Restarting…' });
  }
}

// ---- tray ---------------------------------------------------------------------------------------

function createTray(): void {
  const icon = fs.existsSync(resources.iconFile)
    ? nativeImage.createFromPath(resources.iconFile)
    : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('OpenPulse');
  tray.on('click', () => showWindow());
  updateTray(supervisor?.status);
}

function updateTray(status: GatewayStatus | undefined): void {
  if (!tray) return;
  const state = status?.state ?? 'idle';
  const label =
    state === 'ready'
      ? 'Gateway running'
      : state === 'attached'
        ? 'Attached to a running gateway'
        : state === 'starting' || state === 'probing'
          ? 'Gateway starting…'
          : state === 'restarting'
            ? 'Gateway restarting…'
            : state === 'failed'
              ? `Gateway failed: ${status?.error ?? 'unknown error'}`
              : 'Gateway stopped';

  const template: MenuItemConstructorOptions[] = [
    { label: `OpenPulse ${app.getVersion()}`, enabled: false },
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open OpenPulse', click: () => showWindow() },
    {
      label: 'Restart gateway',
      enabled: Boolean(supervisor),
      click: () => void supervisor?.restart(),
    },
    {
      label: 'Open logs folder',
      click: () => void shell.openPath(path.join(stateDir(), 'logs')),
    },
    { type: 'separator' },
    {
      label: 'Start gateway with OpenPulse',
      type: 'checkbox',
      checked: prefs.current.autoStartGateway,
      click: (item) => prefs.set({ autoStartGateway: item.checked }),
    },
    {
      label: 'Keep running in the tray',
      type: 'checkbox',
      checked: prefs.current.minimizeToTray,
      click: (item) => prefs.set({ minimizeToTray: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit OpenPulse', click: () => void quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`OpenPulse — ${label}`);
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload interface',
          accelerator: 'CmdOrCtrl+R',
          click: () => void loadCurrentView(),
        },
        { label: 'Restart gateway', click: () => void supervisor?.restart() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => void quit() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Developer tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open logs folder',
          click: () => void shell.openPath(path.join(stateDir(), 'logs')),
        },
        { label: 'Open state folder', click: () => void shell.openPath(stateDir()) },
        { label: 'Diagnostics', click: () => void showDiagnostics() },
      ],
    },
  ]);
}

// ---- ipc ----------------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(
    'openpulse:status',
    () => supervisor?.status ?? { state: 'idle', owned: false, restarts: 0 },
  );
  ipcMain.handle('openpulse:diagnostics', () => diagnostics());
  ipcMain.handle('openpulse:restart-gateway', async () => (await supervisor?.restart()) ?? null);
  ipcMain.handle('openpulse:reload', () => void loadCurrentView());
  ipcMain.handle('openpulse:preferences', () => prefs.current);
  ipcMain.handle('openpulse:set-preferences', (_event, patch: Partial<Preferences>) =>
    prefs.set(sanitisePatch(patch)),
  );
  ipcMain.handle('openpulse:open-path', async (_event, target: string) => {
    // Only paths the app itself owns; the renderer cannot ask for arbitrary locations.
    const allowed = [stateDir(), path.join(stateDir(), 'logs'), app.getPath('userData')];
    if (!allowed.includes(path.resolve(target))) return 'not-allowed';
    return shell.openPath(target);
  });
  ipcMain.handle('openpulse:open-external', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('openpulse:gateway-log', () => supervisor?.logTail() ?? []);
}

/** The renderer may only change presentation preferences, never paths or ports it could abuse. */
function sanitisePatch(patch: Partial<Preferences>): Partial<Preferences> {
  const allowed: Partial<Preferences> = {};
  if (typeof patch.minimizeToTray === 'boolean') allowed.minimizeToTray = patch.minimizeToTray;
  if (typeof patch.notifications === 'boolean') allowed.notifications = patch.notifications;
  if (typeof patch.autoStartGateway === 'boolean')
    allowed.autoStartGateway = patch.autoStartGateway;
  if (typeof patch.onboarded === 'boolean') allowed.onboarded = patch.onboarded;
  return allowed;
}

function diagnostics(): Record<string, unknown> {
  return {
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    },
    paths: { ...resources, stateDir: stateDir(), userData: app.getPath('userData') },
    gateway: supervisor?.status ?? null,
    preferences: prefs.current,
    logTail: supervisor?.logTail(50) ?? [],
  };
}

async function showDiagnostics(): Promise<void> {
  const report = JSON.stringify(diagnostics(), null, 2);
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'OpenPulse diagnostics',
    message: 'Diagnostics',
    detail: report.slice(0, 2000),
    buttons: ['Copy to clipboard', 'Close'],
    defaultId: 1,
  });
  if (result.response === 0) {
    const { clipboard } = await import('electron');
    clipboard.writeText(report);
  }
}

// ---- lifecycle ----------------------------------------------------------------------------------

function notify(title: string, body: string): void {
  if (!prefs.current.notifications || !Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', () => showWindow());
  notification.show();
}

async function quit(): Promise<void> {
  quitting = true;
  rememberBounds();
  prefs.set({ lastVersion: app.getVersion() });
  await prefs.flush();
  await supervisor?.stop();
  app.quit();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !prefs?.current.minimizeToTray) void quit();
});

app.on('before-quit', () => {
  quitting = true;
});

/** Append a line to the desktop log, which diagnostics and support requests can quote. */
function logLine(message: string): void {
  try {
    const file = path.join(app.getPath('userData'), 'desktop.log');
    fs.appendFileSync(
      file,
      `${new Date().toISOString()} ${message}
`,
      'utf8',
    );
  } catch {
    // Logging must never break the app.
  }
}

/** Where the gateway keeps its state; mirrors the gateway's own resolution rules. */
function stateDir(): string {
  return process.env.OPENPULSE_STATE_DIR ?? path.join(os.homedir(), '.openpulse');
}

function isLocalGatewayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.port === String(supervisor?.port ?? prefs.current.port)
    );
  } catch {
    return false;
  }
}
