import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar from 'chokidar';
import simpleGit from 'simple-git';
import * as pty from 'node-pty';
import type {
  AppSettings,
  VaultEntry,
  VaultSnapshot,
  NoteDocument,
  SearchResult,
  RenameResult,
  VaultChangeEvent,
  GitStatus,
  GitCommit,
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
const IMAGE_EXTS    = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.pdf']);
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
    } else if (d.isFile() && (d.name.endsWith('.md') || IMAGE_EXTS.has(path.extname(d.name).toLowerCase()))) {
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

  const isTracked = (p: string) =>
    p.endsWith('.md') || IMAGE_EXTS.has(path.extname(p).toLowerCase());

  watcher.on('add',    p => { if (isTracked(p)) emit('added', p); });
  watcher.on('change', p => { if (p.endsWith('.md')) emit('changed', p); });
  watcher.on('unlink', p => {
    if (p.endsWith('.md')) { noteCache.delete(p); }
    if (isTracked(p)) emit('removed', p);
  });
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

  // ── attachment:save ──────────────────────────────────────────────────────
  ipcMain.handle('attachment:save', (_e, data: string, _mimeType: string, filename: string) => {
    if (!vaultPath) throw new Error('Kein Vault geöffnet');

    const folderName = settings.attachmentFolder?.trim() || 'attachments';
    const attachmentDir = path.join(vaultPath, folderName);
    fs.mkdirSync(attachmentDir, { recursive: true });

    // Deduplicate: "Pasted image 2024-01-01.png" → "Pasted image 2024-01-01 1.png"
    const ext  = path.extname(filename);
    const base = path.basename(filename, ext);
    let finalPath = path.join(attachmentDir, filename);
    let counter = 1;
    while (fs.existsSync(finalPath)) {
      finalPath = path.join(attachmentDir, `${base} ${counter}${ext}`);
      counter++;
    }

    fs.writeFileSync(finalPath, Buffer.from(data, 'base64'));

    const relativePath = path.relative(vaultPath, finalPath).replace(/\\/g, '/');
    return { relativePath };
  });

  // ── git:status ───────────────────────────────────────────────────────────
  ipcMain.handle('git:status', async (): Promise<GitStatus> => {
    if (!vaultPath) return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [] };
    const git = simpleGit(vaultPath);
    try {
      const isRepo = await git.checkIsRepo();
      if (!isRepo) return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [] };
      const status = await git.status();
      return {
        isRepo: true,
        branch: status.current ?? '',
        ahead:  status.ahead,
        behind: status.behind,
        files: status.files.map(f => ({ path: f.path, index: f.index, workingDir: f.working_dir })),
      };
    } catch {
      return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [] };
    }
  });

  // ── git:init ─────────────────────────────────────────────────────────────
  ipcMain.handle('git:init', async () => {
    if (!vaultPath) throw new Error('Kein Vault geöffnet');
    await simpleGit(vaultPath).init();
  });

  // ── git:add ──────────────────────────────────────────────────────────────
  ipcMain.handle('git:add', async (_e, paths: string[]) => {
    if (!vaultPath) throw new Error('Kein Vault geöffnet');
    await simpleGit(vaultPath).add(paths);
  });

  // ── git:unstage ──────────────────────────────────────────────────────────
  ipcMain.handle('git:unstage', async (_e, paths: string[]) => {
    if (!vaultPath) throw new Error('Kein Vault geöffnet');
    await simpleGit(vaultPath).reset(['HEAD', '--', ...paths]);
  });

  // ── git:commit ───────────────────────────────────────────────────────────
  ipcMain.handle('git:commit', async (_e, message: string): Promise<GitCommit> => {
    if (!vaultPath) throw new Error('Kein Vault geöffnet');
    const git = simpleGit(vaultPath);
    await git.commit(message);
    const log = await git.log({ maxCount: 1 });
    const latest = log.latest;
    return {
      hash:    latest?.hash    ?? '',
      message: latest?.message ?? message,
      author:  latest?.author_name ?? '',
      date:    latest?.date    ?? new Date().toISOString(),
    };
  });

  // ── git:log ──────────────────────────────────────────────────────────────
  ipcMain.handle('git:log', async (_e, limit = 20): Promise<GitCommit[]> => {
    if (!vaultPath) return [];
    try {
      const log = await simpleGit(vaultPath).log({ maxCount: limit });
      return log.all.map(c => ({
        hash:    c.hash,
        message: c.message,
        author:  c.author_name,
        date:    c.date,
      }));
    } catch {
      return [];
    }
  });

  // ── git:restore ──────────────────────────────────────────────────────────
  ipcMain.handle('git:restore', async (_e, paths: string[]) => {
    if (!vaultPath) throw new Error('Kein Vault geöffnet');
    const git = simpleGit(vaultPath);
    const status = await git.status();
    const untracked = new Set(status.not_added);

    const tracked   = paths.filter(p => !untracked.has(p));
    const toDelete  = paths.filter(p => untracked.has(p));

    if (tracked.length > 0) {
      await git.checkout(['HEAD', '--', ...tracked]);
    }
    for (const p of toDelete) {
      try { fs.unlinkSync(path.join(vaultPath, p)); } catch { /* ignore */ }
    }
  });

  // ── git:stage-hunk ───────────────────────────────────────────────────────
  // Accepts a vault-relative path and the A-side (HEAD) first line of the chunk.
  // Uses -U0 so every discrete change is its own hunk (no context merging nearby
  // changes together). Matches the hunk by exact A-side start line and applies
  // it with -C0 so no context lines need to match.
  ipcMain.handle('git:stage-hunk', async (_e, relPath: string, fromLine: number, _toLine: number) => {
    if (!vaultPath) throw new Error('Kein Vault geöffnet');
    const git = simpleGit(vaultPath);

    // -U0 = zero context lines → each discrete change is a separate @@ hunk
    const diffOutput = await git.diff(['-U0', 'HEAD', '--', relPath]);
    if (!diffOutput) return; // no changes

    const lines = diffOutput.split('\n');

    // Collect file header (everything before the first @@)
    let headerEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) { headerEnd = i; break; }
    }
    const fileHeader = lines.slice(0, headerEnd).join('\n');

    // Find all hunk starts
    const hunkStarts: number[] = [];
    lines.forEach((l, i) => { if (l.startsWith('@@')) hunkStarts.push(i); });

    // Find the hunk whose A-side start line covers fromLine
    for (let idx = 0; idx < hunkStarts.length; idx++) {
      const start = hunkStarts[idx];
      const end   = hunkStarts[idx + 1] ?? lines.length;

      const m = /^@@ -(\d+)(?:,(\d+))? /.exec(lines[start]);
      if (!m) continue;

      const hunkAStart = parseInt(m[1]);
      const hunkACount = m[2] !== undefined ? parseInt(m[2]) : 1;
      // For pure insertions hunkACount=0; the insertion is "after" hunkAStart.
      // fromLine is the line AT which CM shows the insertion → hunkAStart or hunkAStart+1.
      const hunkAEnd = hunkAStart + Math.max(hunkACount - 1, 0);

      if (fromLine >= hunkAStart && fromLine <= hunkAEnd + 1) {
        const hunkContent = lines.slice(start, end).join('\n');
        const patch = `${fileHeader}\n${hunkContent}\n`;

        const tmpFile = path.join(os.tmpdir(), 'obsidian-hunk.patch');
        fs.writeFileSync(tmpFile, patch, 'utf-8');
        try {
          // -C0: require 0 context lines to match (safe because -U0 has no context)
          await git.raw(['apply', '--cached', '-C0', '--unidiff-zero', '--whitespace=nowarn', tmpFile]);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
        return;
      }
    }

    throw new Error(`Kein Hunk gefunden für ${relPath} Zeile ${fromLine}–${_toLine}`);
  });

  // ── git:file-at-head ─────────────────────────────────────────────────────
  ipcMain.handle('git:file-at-head', async (_e, filePath: string): Promise<string | null> => {
    if (!vaultPath) return null;
    try {
      const git = simpleGit(vaultPath);
      if (!await git.checkIsRepo()) return null;
      const relative = path.relative(vaultPath, filePath).replace(/\\/g, '/');
      return await git.show([`HEAD:${relative}`]);
    } catch {
      return null; // new file not yet in HEAD
    }
  });

  // ── git:file-at-index ────────────────────────────────────────────────────
  // Returns the content of a file from the staging area (index).
  // `:relPath` (colon prefix) is git's syntax for "from the index".
  ipcMain.handle('git:file-at-index', async (_e, filePath: string): Promise<string | null> => {
    if (!vaultPath) return null;
    try {
      const git = simpleGit(vaultPath);
      if (!await git.checkIsRepo()) return null;
      const relative = path.relative(vaultPath, filePath).replace(/\\/g, '/');
      return await git.show([`:${relative}`]);
    } catch {
      return null;
    }
  });

  // ── context:write ────────────────────────────────────────────────────────
  const CONTEXT_FILE = path.join(os.tmpdir(), 'obsidian-context.md');
  ipcMain.handle('context:write', async (_e, filePath: string | null, selection: string): Promise<string> => {
    const lines: string[] = ['# Obsidian Clone – Editor Context', ''];
    if (filePath) {
      lines.push(`**File:** ${filePath}`, '');
    }
    if (selection.trim()) {
      lines.push('**Selection:**', '', '```', selection, '```', '');
    } else {
      lines.push('*(No selection)*', '');
    }
    fs.writeFileSync(CONTEXT_FILE, lines.join('\n'), 'utf-8');
    return CONTEXT_FILE;
  });

  // ── Terminal (node-pty) ──────────────────────────────────────────────────
  const ptys = new Map<number, pty.IPty>();
  const userShell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');

  ipcMain.handle('terminal:create', async (_e, cols: number, rows: number, cwd: string, env?: Record<string, string>) => {
    const ptyProcess = pty.spawn(userShell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || (vaultPath ?? process.env.HOME ?? '/'),
      env: { ...process.env, OBSIDIAN_CONTEXT_FILE: CONTEXT_FILE, ...env } as Record<string, string>,
    });
    ptys.set(ptyProcess.pid, ptyProcess);
    ptyProcess.onData(data => {
      mainWindow?.webContents.send('terminal:data', ptyProcess.pid, data);
    });
    ptyProcess.onExit(({ exitCode }) => {
      mainWindow?.webContents.send('terminal:exit', ptyProcess.pid, exitCode ?? 0);
      ptys.delete(ptyProcess.pid);
    });
    return ptyProcess.pid;
  });

  ipcMain.handle('terminal:write', async (_e, pid: number, data: string) => {
    ptys.get(pid)?.write(data);
  });

  ipcMain.handle('terminal:resize', async (_e, pid: number, cols: number, rows: number) => {
    ptys.get(pid)?.resize(cols, rows);
  });

  ipcMain.handle('terminal:kill', async (_e, pid: number) => {
    ptys.get(pid)?.kill();
    ptys.delete(pid);
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

// Must be called before app.whenReady() so Electron registers the scheme
// before any renderer session is created.
protocol.registerSchemesAsPrivileged([
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.whenReady().then(() => {
  settings = loadSettings();

  // Serve vault-relative asset paths via vault://host/path so the renderer can
  // load local images without hitting Electron's file:// cross-origin block.
  // URL parsing: vault://attachments/image.png → host="attachments", pathname="/image.png"
  // → vault-relative path = host + pathname = "attachments/image.png"
  const MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    pdf: 'application/pdf',
  };
  const vaultProtocolHandler = (request: Request): Response => {
    try {
      // Avoid new URL() hostname/pathname split: just strip the scheme prefix
      const rawPath = request.url.slice('vault://'.length);   // "attachments/Pasted%20image.png"
      const relative = decodeURIComponent(rawPath);            // "attachments/Pasted image.png"
      const absolute = path.join(vaultPath ?? '', relative);
      const data = fs.readFileSync(absolute);
      const ext  = path.extname(absolute).toLowerCase().slice(1);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' },
      });
    } catch (err) {
      console.error('[vault://]', err);
      return new Response('Not found', { status: 404 });
    }
  };
  protocol.handle('vault', vaultProtocolHandler);

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
