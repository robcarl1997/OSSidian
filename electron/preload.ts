import { contextBridge, ipcRenderer } from 'electron';
import type { VaultApi, AppSettings, VaultChangeEvent } from '../shared/ipc';

const api: VaultApi = {
  getInitialState: () =>
    ipcRenderer.invoke('vault:get-initial-state'),

  selectVault: () =>
    ipcRenderer.invoke('vault:select'),

  openNote: (path: string) =>
    ipcRenderer.invoke('note:open', path),

  saveNote: (path: string, raw: string) =>
    ipcRenderer.invoke('note:save', path, raw),

  createEntry: (parentPath: string, name: string, kind: 'file' | 'dir') =>
    ipcRenderer.invoke('vault:create-entry', parentPath, name, kind),

  renameEntry: (path: string, newName: string) =>
    ipcRenderer.invoke('vault:rename-entry', path, newName),

  deleteEntry: (path: string) =>
    ipcRenderer.invoke('vault:delete-entry', path),

  search: (query: string) =>
    ipcRenderer.invoke('vault:search', query),

  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', url),

  updateSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('settings:update', settings),

  saveAttachment: (data: string, mimeType: string, filename: string) =>
    ipcRenderer.invoke('attachment:save', data, mimeType, filename),

  onVaultChanged: (cb: (event: VaultChangeEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: VaultChangeEvent) => cb(event);
    ipcRenderer.on('vault:changed', handler);
    return () => ipcRenderer.removeListener('vault:changed', handler);
  },
};

contextBridge.exposeInMainWorld('vaultApp', api);

contextBridge.exposeInMainWorld('windowControls', {
  minimize:       () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close:          () => ipcRenderer.invoke('window:close'),
  isMaximized:    (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
});
