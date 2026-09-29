import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only surface the renderer gets. It exposes desktop shell facilities — gateway status,
 * diagnostics, presentation preferences — and deliberately no gateway credentials: the Control UI
 * authenticates the same way a browser does, over loopback against /control-config.
 */
const api = {
  isDesktop: true as const,
  status: () => ipcRenderer.invoke('openpulse:status'),
  diagnostics: () => ipcRenderer.invoke('openpulse:diagnostics'),
  restartGateway: () => ipcRenderer.invoke('openpulse:restart-gateway'),
  reload: () => ipcRenderer.invoke('openpulse:reload'),
  preferences: () => ipcRenderer.invoke('openpulse:preferences'),
  setPreferences: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('openpulse:set-preferences', patch),
  openPath: (target: string) => ipcRenderer.invoke('openpulse:open-path', target),
  openExternal: (url: string) => ipcRenderer.invoke('openpulse:open-external', url),
  gatewayLog: () => ipcRenderer.invoke('openpulse:gateway-log'),
  onGatewayStatus: (handler: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => handler(status);
    ipcRenderer.on('openpulse:gateway-status', listener);
    return () => ipcRenderer.removeListener('openpulse:gateway-status', listener);
  },
  onGatewayLog: (handler: (entry: unknown) => void) => {
    const listener = (_event: unknown, entry: unknown) => handler(entry);
    ipcRenderer.on('openpulse:gateway-log', listener);
    return () => ipcRenderer.removeListener('openpulse:gateway-log', listener);
  },
};

contextBridge.exposeInMainWorld('openpulseDesktop', api);

export type OpenPulseDesktopApi = typeof api;
