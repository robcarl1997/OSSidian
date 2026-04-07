import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import type {
  AppSettings,
  VaultEntry,
  VaultSnapshot,
  NoteDocument,
  SearchResult,
  RenameResult,
  VaultChangeEvent,
} from '../shared/ipc';
import { DEFAULT_SETTINGS } from '../shared/ipc';
import { extractHeadings, rewriteWikilinks } from '../shared/linking';

// ─── State ────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let vaultPath: string | null = null;
let watcher: chokidar.FSWatcher | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };

const noteCache = new Map<string, { raw: string; mtimeMs: number }>();

const IGNORED_NAMES = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.DS_Store']);
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// ─── Settings ─────────────────────────────────────────────────────────────────

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: AppSettings): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
  } catch (e) {
    console.error('[settings] Failed to save:', e);
  }
}

// ─── Vault tree ───────────────────────────────────────────────────────────────

function buildTree(dir: string): VaultEntry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries: VaultEntry[] = [];

  for (const d of dirents) {
    if (IGNORED_NAMES.has(d.name) || d.name.startsWith('.')) continue;

    const fullPath = path.join(dir, d.name);

    if (d.isDirectory()) {
      entries.push({
        path: fullPath,
        name: d.name,
        kind: 'dir',
        parentPath: dir,
        mtimeMs: 0,
        children: buildTree(fullPath),
      });
    } else if (d.isFile() && d.name.endsWith('.md')) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch { /* ignore */ }
      entries.push({ path: fullPath, name: d.name, kind: 'file', parentPath: dir, mtimeMs });
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return entries;
}

function collectPaths(tree: VaultEntry[]): string[] {
  const paths: string[] = [];
  const walk = (entries: VaultEntry[]) => {
    for (const e of entries) {
      if (e.kind === 'file') paths.push(e.path);
      if (e.children) walk(e.children);
    }
  };
  walk(tree);
  return paths;
}

function buildSnapshot(): VaultSnapshot {
  const tree = vaultPath ? buildTree(vaultPath) : [];
  return { vaultPath: vaultPath ?? '', tree, allPaths: collectPaths(tree), settings };
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

function startWatcher(dir: string): void {
  watcher?.close();

  watcher = chokidar.watch(dir, {
    ignored: (p: string) => {
      const base = path.basename(p);
      return IGNORED_NAMES.has(base) || base.startsWith('.');
    },
    ignoreInitial: true,
    depth: 50,
  });

  const emit = (kind: VaultChangeEvent['kind'], filePath: string, newPath?: string) => {
    if (!mainWindow) return;
    const snapshot = buildSnapshot();
    const event: VaultChangeEvent = { kind, path: filePath, newPath, snapshot };
    mainWindow.webContents.send('vault:changed', event);
  };

  watcher.on('add', p => { if (p.endsWith('.md')) emit('added', p); });
  watcher.on('change', p => { if (p.endsWith('.md')) emit('changed', p); });
  watcher.on('unlink', p => { if (p.endsWith('.md')) { noteCache.delete(p); emit('removed', p); } });
  watcher.on('addDir', p => emit('added', p));
  watcher.on('unlinkDir', p => emit('removed', p));
}

// ─── Note I/O ─────────────────────────────────────────────────────────────────

function readNote(filePath: string): NoteDocument {
  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(filePath); } catch { /* file not yet created */ }

  if (!stat) {
    return { path: filePath, raw: '', headings: [], dirty: false, mtimeMs: 0 };
  }

  const cached = noteCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return makeDoc(filePath, cached.raw, stat.mtimeMs);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  noteCache.set(filePath, { raw, mtimeMs: stat.mtimeMs });
  return makeDoc(filePath, raw, stat.mtimeMs);
}

function makeDoc(filePath: string, raw: string, mtimeMs: number): NoteDocument {
  return { path: filePath, raw, headings: extractHeadings(raw), dirty: false, mtimeMs };
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function setupIPC(): void {
  // ── vault:get-initial-state ──────────────────────────────────────────────
  ipcMain.handle('vault:get-initial-state', async () => {
    const lastPath = settings.lastVaultPath;
    if (lastPath && fs.existsSync(lastPath)) {
      vaultPath = lastPath;
      startWatcher(vaultPath);
    }
    return buildSnapshot();
  });

  // ── vault:select ────────────────────────────────────────────────────────
  ipcMain.handle('vault:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Vault-Ordner auswählen',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    vaultPath = result.filePaths[0];
    settings = { ...settings, lastVaultPath: vaultPath };
    saveSettings(settings);
    noteCache.clear();
    startWatcher(vaultPath);
    return buildSnapshot();
  });

  // ── note:open ────────────────────────────────────────────────────────────
  ipcMain.handle('note:open', (_e, filePath: string) => readNote(filePath));

  // ── note:save ────────────────────────────────────────────────────────────
  ipcMain.handle('note:save', (_e, filePath: string, raw: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, raw, 'utf-8');
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    noteCache.set(filePath, { raw, mtimeMs });
    return { mtimeMs };
  });

  // ── vault:create-entry ───────────────────────────────────────────────────
  ipcMain.handle('vault:create-entry', (_e, parentPath: string, name: string, kind: 'file' | 'dir') => {
    if (kind === 'dir') {
      const fullPath = path.join(parentPath, name);
      fs.mkdirSync(fullPath, { recursive: true });
      return { path: fullPath, name, kind: 'dir', parentPath, mtimeMs: 0, children: [] } satisfies VaultEntry;
    } else {
      const finalName = name.endsWith('.md') ? name : `${name}.md`;
      const fullPath = path.join(parentPath, finalName);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, '', 'utf-8');
      const mtimeMs = fs.statSync(fullPath).mtimeMs;
      return { path: fullPath, name: finalName, kind: 'file', parentPath, mtimeMs } satisfies VaultEntry;
    }
  });

  // ── vault:rename-entry ───────────────────────────────────────────────────
  ipcMain.handle('vault:rename-entry', async (_e, oldPath: string, newName: string): Promise<RenameResult> => {
    const parentDir = path.dirname(oldPath);
    const isFile = fs.statSync(oldPath).isFile();
    const finalName = isFile && !newName.endsWith('.md') ? `${newName}.md` : newName;
    const newPath = path.join(parentDir, finalName);

    fs.renameSync(oldPath, newPath);
    noteCache.delete(oldPath);

    let updatedFiles = 0;
    if (settings.autoUpdateLinks && isFile) {
      const oldStem = path.basename(oldPath, '.md');
      const newStem = path.basename(newPath, '.md');
      updatedFiles = rewriteLinksInVault(oldStem, newStem, buildSnapshot().allPaths, newPath);
    }

    return { newPath, updatedFiles };
  });

  // ── vault:delete-entry ───────────────────────────────────────────────────
  ipcMain.handle('vault:delete-entry', (_e, filePath: string) => {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
      noteCache.delete(filePath);
    }
  });

  // ── vault:search ─────────────────────────────────────────────────────────
  ipcMain.handle('vault:search', (_e, query: string): SearchResult[] => {
    if (!vaultPath || !query.trim()) return [];

    const snapshot = buildSnapshot();
    const results: SearchResult[] = [];
    const q = query.toLowerCase();

    for (const filePath of snapshot.allPaths) {
      try {
        const name = path.basename(filePath, '.md');
        const cached = noteCache.get(filePath);
        const raw = cached?.raw ?? fs.readFileSync(filePath, 'utf-8');

        if (name.toLowerCase().includes(q) || raw.toLowerCase().includes(q)) {
          const idx = raw.toLowerCase().indexOf(q);
          const excerpt = idx !== -1
            ? '…' + raw.slice(Math.max(0, idx - 30), idx + 60).replace(/\n/g, ' ') + '…'
            : raw.slice(0, 80).replace(/\n/g, ' ');
          results.push({ path: filePath, name, excerpt });
          if (results.length >= 50) break;
        }
      } catch { /* skip unreadable files */ }
    }

    return results;
  });

  // ── shell:open-external ──────────────────────────────────────────────────
  ipcMain.handle('shell:open-external', (_e, url: string) => shell.openExternal(url));

  // ── settings:update ──────────────────────────────────────────────────────
  ipcMain.handle('settings:update', (_e, partial: Partial<AppSettings>) => {
    settings = { ...settings, ...partial };
    saveSettings(settings);
    return settings;
  });

  // ── Window controls ──────────────────────────────────────────────────────
  ipcMain.handle('window:minimize',        () => mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window:close',           () => mainWindow?.close());
  ipcMain.handle('window:is-maximized',    () => mainWindow?.isMaximized() ?? false);
}

// ─── Link rewriting ───────────────────────────────────────────────────────────

function rewriteLinksInVault(
  oldStem: string,
  newStem: string,
  allPaths: string[],
  skipPath: string,
): number {
  if (oldStem === newStem) return 0;
  let count = 0;

  for (const filePath of allPaths) {
    if (filePath === skipPath) continue;
    try {
      const cached = noteCache.get(filePath);
      const raw = cached?.raw ?? fs.readFileSync(filePath, 'utf-8');
      const updated = rewriteWikilinks(raw, oldStem, newStem);
      if (updated !== raw) {
        fs.writeFileSync(filePath, updated, 'utf-8');
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        noteCache.set(filePath, { raw: updated, mtimeMs });
        count++;
      }
    } catch { /* skip */ }
  }

  return count;
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1e1e2e',
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  settings = loadSettings();
  setupIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('quit', () => { watcher?.close(); });
