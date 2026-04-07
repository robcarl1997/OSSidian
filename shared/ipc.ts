// ─── Settings ────────────────────────────────────────────────────────────────

export type EditorMode = 'live-preview' | 'source';
export type LinkFormat = 'wikilink' | 'markdown';
export type Theme = 'light' | 'dark' | 'sepia';

export interface VimKeybinding {
  lhs: string;
  rhs: string;
  mode: 'insert' | 'normal' | 'visual';
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
  onVaultChanged(cb: (event: VaultChangeEvent) => void): () => void;
}

declare global {
  interface Window {
    vaultApp: VaultApi;
  }
}
