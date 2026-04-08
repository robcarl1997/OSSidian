// ─── Settings ────────────────────────────────────────────────────────────────

export type EditorMode = 'live-preview' | 'source';
export type LinkFormat = 'wikilink' | 'markdown';
export type Theme = 'light' | 'dark' | 'sepia';

export interface VimKeybinding {
  lhs: string;
  rhs: string;
  mode: 'insert' | 'normal' | 'visual';
}

export type AppAction =
  | 'quickOpen'
  | 'toggleSidebar'
  | 'toggleOutline'
  | 'tabNext'
  | 'tabPrev'
  | 'tabClose'
  | 'jumpBack'
  | 'newNote'
  | 'openSettings'
  | 'toggleTerminal'
  | 'focusFileTree'
  | 'focusGit';

export interface AppKeybinding {
  key: string;      // normalised combo, e.g. "Ctrl+P", "Ctrl+Shift+O"
  action: AppAction;
}

export interface AppSettings {
  lastVaultPath: string | null;
  editorMode: EditorMode;
  vimMode: boolean;
  linkFormat: LinkFormat;
  autoUpdateLinks: boolean;
  theme: Theme;
  editorFontFamily: string;
  editorFontSize: number;      // 12–28
  editorLineHeight: number;    // 1.0–2.5
  vimKeybindings: VimKeybinding[];
  vimLeader: string;
  appKeybindings: AppKeybinding[];
  attachmentFolder: string;    // vault-relative folder for pasted images
  terminalPosition: 'bottom' | 'right';
}

export const DEFAULT_SETTINGS: AppSettings = {
  lastVaultPath: null,
  editorMode: 'live-preview',
  vimMode: false,
  linkFormat: 'wikilink',
  autoUpdateLinks: true,
  theme: 'dark',
  editorFontFamily: "ui-serif, Georgia, 'Times New Roman', serif",
  editorFontSize: 17,
  editorLineHeight: 1.75,
  vimKeybindings: [],
  vimLeader: '\\',
  attachmentFolder: 'attachments',
  terminalPosition: 'right',
  appKeybindings: [
    { key: 'Ctrl+P',         action: 'quickOpen'     },
    { key: 'Ctrl+B',         action: 'toggleSidebar' },
    { key: 'Ctrl+Shift+O',   action: 'toggleOutline' },
    { key: 'Ctrl+Tab',       action: 'tabNext'        },
    { key: 'Ctrl+PageDown',  action: 'tabNext'        },
    { key: 'Ctrl+Shift+Tab', action: 'tabPrev'        },
    { key: 'Ctrl+PageUp',    action: 'tabPrev'        },
    { key: 'Ctrl+W',         action: 'tabClose'       },
    { key: 'Ctrl+`',         action: 'toggleTerminal' },
    { key: 'Ctrl+Shift+E',  action: 'focusFileTree'  },
    { key: 'Ctrl+Shift+G',  action: 'focusGit'       },
  ],
};

// ─── Vault ───────────────────────────────────────────────────────────────────

export interface VaultEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  parentPath: string;
  mtimeMs: number;
  children?: VaultEntry[];
}

export interface HeadingRef {
  slug: string;
  text: string;
  level: number;
  line: number;
}

export interface NoteDocument {
  path: string;
  raw: string;
  headings: HeadingRef[];
  dirty: boolean;
  mtimeMs: number;
}

export interface VaultSnapshot {
  vaultPath: string;
  tree: VaultEntry[];
  allPaths: string[];
  settings: AppSettings;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  name: string;
  excerpt: string;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface VaultChangeEvent {
  kind: 'added' | 'changed' | 'removed' | 'renamed';
  path: string;
  newPath?: string;
  snapshot: VaultSnapshot;
}

export interface RenameResult {
  newPath: string;
  updatedFiles: number;
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export interface GitFileStatus {
  path: string;
  index: string;      // staged:   ' ' | 'M' | 'A' | 'D' | 'R' | '?'
  workingDir: string; // unstaged: ' ' | 'M' | 'D' | '?'
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// ─── API exposed to renderer ──────────────────────────────────────────────────

export interface VaultApi {
  getInitialState(): Promise<VaultSnapshot>;
  selectVault(): Promise<VaultSnapshot | null>;
  openNote(path: string): Promise<NoteDocument>;
  saveNote(path: string, raw: string): Promise<{ mtimeMs: number }>;
  createEntry(parentPath: string, name: string, kind: 'file' | 'dir'): Promise<VaultEntry>;
  renameEntry(path: string, newName: string): Promise<RenameResult>;
  deleteEntry(path: string): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
  openExternal(url: string): Promise<void>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  saveAttachment(data: string, mimeType: string, filename: string): Promise<{ relativePath: string }>;
  onVaultChanged(cb: (event: VaultChangeEvent) => void): () => void;
  // ── Git ──────────────────────────────────────────────────────────────────
  gitStatus(): Promise<GitStatus>;
  gitInit(): Promise<void>;
  gitAdd(paths: string[]): Promise<void>;
  gitUnstage(paths: string[]): Promise<void>;
  gitCommit(message: string): Promise<GitCommit>;
  gitLog(limit?: number): Promise<GitCommit[]>;
  gitFileAtHead(filePath: string): Promise<string | null>;
  gitFileAtIndex(filePath: string): Promise<string | null>;
  gitRestore(paths: string[]): Promise<void>;
  stageHunk(relPath: string, fromLineA: number, toLineA: number, isPureInsertion: boolean, newContent: string[]): Promise<void>;
  writeContext(filePath: string | null, selection: string): Promise<string>;
}

export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
}

// ─── Terminal ─────────────────────────────────────────────────────────────────

export interface TerminalApi {
  create(cols: number, rows: number, cwd: string, env?: Record<string, string>): Promise<number>;
  write(pid: number, data: string): Promise<void>;
  resize(pid: number, cols: number, rows: number): Promise<void>;
  kill(pid: number): Promise<void>;
  onData(cb: (pid: number, data: string) => void): () => void;
  onExit(cb: (pid: number, code: number) => void): () => void;
}

declare global {
  interface Window {
    vaultApp: VaultApi;
    windowControls: WindowControls;
    terminalApp: TerminalApi;
  }
}
