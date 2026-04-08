import { contextBridge, ipcRenderer } from 'electron';
import type { VaultApi, AppSettings, VaultChangeEvent, GitCommit, TerminalApi } from '../shared/ipc';

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

  gitStatus:  ()                                    => ipcRenderer.invoke('git:status'),
  gitInit:    ()                                    => ipcRenderer.invoke('git:init'),
  gitAdd:     (paths: string[])                     => ipcRenderer.invoke('git:add', paths),
  gitUnstage: (paths: string[])                     => ipcRenderer.invoke('git:unstage', paths),
  gitCommit:  (message: string): Promise<GitCommit> => ipcRenderer.invoke('git:commit', message),
  gitLog:         (limit?: number)              => ipcRenderer.invoke('git:log', limit),
  gitFileAtHead:  (filePath: string)            => ipcRenderer.invoke('git:file-at-head', filePath),
  gitFileAtIndex: (filePath: string)            => ipcRenderer.invoke('git:file-at-index', filePath),
  gitRestore:     (paths: string[])             => ipcRenderer.invoke('git:restore', paths),
  stageHunk:      (relPath: string, fromLine: number, toLine: number) =>
    ipcRenderer.invoke('git:stage-hunk', relPath, fromLine, toLine),
  writeContext:   (filePath: string | null, selection: string) =>
    ipcRenderer.invoke('context:write', filePath, selection),
};

contextBridge.exposeInMainWorld('vaultApp', api);

contextBridge.exposeInMainWorld('windowControls', {
  minimize:       () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close:          () => ipcRenderer.invoke('window:close'),
  isMaximized:    (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
});

const terminalApi: TerminalApi = {
  create:  (cols, rows, cwd, env) => ipcRenderer.invoke('terminal:create', cols, rows, cwd, env),
  write:   (pid, data)            => ipcRenderer.invoke('terminal:write',  pid, data),
  resize:  (pid, cols, rows)      => ipcRenderer.invoke('terminal:resize', pid, cols, rows),
  kill:    (pid)                  => ipcRenderer.invoke('terminal:kill',   pid),
  onData: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, pid: number, data: string) => cb(pid, data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  onExit: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, pid: number, code: number) => cb(pid, code);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
};

contextBridge.exposeInMainWorld('terminalApp', terminalApi);
