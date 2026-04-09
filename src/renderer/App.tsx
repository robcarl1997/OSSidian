import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useDeferredValue,
} from 'react';
import type {
  AppSettings,
  NoteDocument,
  VaultEntry,
  VaultSnapshot,
  SearchResult,
} from '../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../shared/ipc';

// ─── Key combo normalisation ──────────────────────────────────────────────────

function keyEventToString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  // Single printable chars → uppercase; special keys use e.key as-is
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join('+');
}
import { findPathByStem } from '../../shared/linking';
import TabBar from './components/TabBar';
import FileTree from './components/FileTree';
import SettingsPanel from './components/SettingsPanel';
import QuickOpen from './components/QuickOpen';
import MarkdownEditor, { type MarkdownEditorHandle } from './editor/MarkdownEditor';
import OutlinePanel from './components/OutlinePanel';
import GitPanel from './components/GitPanel';
import TerminalPanel from './components/TerminalPanel';
import DiffViewer from './components/DiffViewer';
import ImageViewer from './components/ImageViewer';
import PdfViewer from './components/PdfViewer';
import BacklinksPanel from './components/BacklinksPanel';
import { marked } from 'marked';

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif']);

// ─── Types ────────────────────────────────────────────────────────────────────

interface Dialog {
  kind: 'create-file' | 'create-folder' | 'rename' | 'delete';
  parentPath?: string;
  entry?: VaultEntry;
}

// ─── Autosave debounce ────────────────────────────────────────────────────────

const AUTOSAVE_MS = 700;

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [snapshot, setSnapshot]         = useState<VaultSnapshot | null>(null);
  const [tabs, setTabs]                 = useState<NoteDocument[]>([]);
  const [activePath, setActivePath]     = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog]             = useState<Dialog | null>(null);
  const [dialogInput, setDialogInput]   = useState('');
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const [navHistory, setNavHistory]     = useState<{ path: string; cursor: number }[]>([]);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen]   = useState(true);
  const [sidebarTab, setSidebarTab]     = useState<'files' | 'git' | 'backlinks'>('files');
  const [outlineOpen, setOutlineOpen]   = useState(false);
  const [headContent, setHeadContent] = useState<string | null | undefined>(undefined);
  const [activeDiff, setActiveDiff]   = useState<{ path: string; head: string | null; current: string; readOnly?: boolean; aLabel?: string } | null>(null);
  const [activeImage, setActiveImage] = useState<string | null>(null);
  const [activePdf, setActivePdf]     = useState<string | null>(null);
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const [focusFileTreeReq, setFocusFileTreeReq] = useState<number | undefined>(undefined);
  const [terminalOpen, setTerminalOpen]         = useState(false);
  const [terminalMounted, setTerminalMounted]   = useState(false);
  const [terminalPosition, setTerminalPosition] = useState<'bottom' | 'right'>('right');
  const [splitEnabled, setSplitEnabled]         = useState(false);
  const [splitPath, setSplitPath]               = useState<string | null>(null);
  const [splitTabs, setSplitTabs]               = useState<NoteDocument[]>([]);
  const [activePaneIdx, setActivePaneIdx]       = useState<0 | 1>(0);
  const [splitHeadContent, setSplitHeadContent] = useState<string | null | undefined>(undefined);
  const [terminalSize, setTerminalSize]         = useState(260);
  const [editorSelection, setEditorSelection]   = useState<string>('');
  const splitRatioRef = useRef<number>(0.5);
  const activeCursorRef    = useRef<number>(0);
  const pendingCursors     = useRef(new Map<string, number>());
  const editorRef          = useRef<MarkdownEditorHandle>(null);
  const splitEditorRef     = useRef<MarkdownEditorHandle>(null);
  const activePaneIdxRef   = useRef<0 | 1>(0);
  const splitEnabledRef    = useRef(false);
  const splitPathRef       = useRef<string | null>(null);
  const snapshotRef        = useRef(snapshot);
  const activePathRef      = useRef(activePath);
  const editorSelectionRef = useRef(editorSelection);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  useEffect(() => { editorSelectionRef.current = editorSelection; }, [editorSelection]);
  useEffect(() => { activePaneIdxRef.current = activePaneIdx; }, [activePaneIdx]);
  useEffect(() => { splitEnabledRef.current = splitEnabled; }, [splitEnabled]);
  useEffect(() => { splitPathRef.current = splitPath; }, [splitPath]);

  const deferredSearch = useDeferredValue(searchQuery);
  const autosaveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);

  const settings: AppSettings = snapshot?.settings ?? DEFAULT_SETTINGS;
  const activeTab = tabs.find(t => t.path === activePath) ?? null;
  const splitTab  = splitTabs.find(t => t.path === splitPath) ?? null;
  // Single source of truth for which note is "active" — used by the editor toolbar.
  const focusedTab = activePaneIdx === 1 ? splitTab : activeTab;
  // Effective split ratio (clamped 0.1..0.9)
  const splitRatio = Math.max(0.1, Math.min(0.9, settings.splitPaneRatio ?? 0.5));
  useEffect(() => { splitRatioRef.current = splitRatio; }, [splitRatio]);

  // ─── Apply theme ────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  // ─── Initial load ────────────────────────────────────────────────────────────
  useEffect(() => {
    window.vaultApp.getInitialState().then(snap => {
      setSnapshot(snap);
      // Apply persisted terminal position on startup
      if (snap.settings.terminalPosition) {
        setTerminalPosition(snap.settings.terminalPosition);
      }
    });
  }, []);

  // ─── Vault change events ──────────────────────────────────────────────────
  useEffect(() => {
    return window.vaultApp.onVaultChanged(event => {
      setSnapshot(event.snapshot);

      // Reload open tab when file changes externally (unless user has unsaved edits)
      if (event.kind === 'changed' && event.path) {
        const changedPath = event.path;
        setTabs(prev => {
          const tab = prev.find(t => t.path === changedPath);
          if (!tab || tab.dirty) return prev;
          window.vaultApp.openNote(changedPath).then(doc => {
            setTabs(curr =>
              curr.map(t => t.path === changedPath ? { ...doc, dirty: false } : t)
            );
          });
          return prev;
        });
        // Also sync split pane if it has the same file open and isn't dirty
        setSplitTabs(prev => {
          const tab = prev.find(t => t.path === changedPath);
          if (!tab || tab.dirty) return prev;
          window.vaultApp.openNote(changedPath).then(doc => {
            setSplitTabs(curr =>
              curr.map(t => t.path === changedPath ? { ...doc, dirty: false } : t)
            );
          });
          return prev;
        });
      }
    });
  }, []);

  // ─── Clear pendingAnchor after navigation has occurred ───────────────────
  useEffect(() => {
    if (!pendingAnchor) return;
    const t = setTimeout(() => setPendingAnchor(null), 350);
    return () => clearTimeout(t);
  }, [pendingAnchor]);

  // ─── Search ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!deferredSearch.trim()) {
      setSearchResults([]);
      return;
    }
    window.vaultApp.search(deferredSearch).then(setSearchResults);
  }, [deferredSearch]);

  // ─── Auto-focus file tree when sidebar opens on files tab ───────────────
  useEffect(() => {
    if (sidebarOpen && sidebarTab === 'files') {
      setFocusFileTreeReq(v => (v ?? 0) + 1);
    } else {
      setTimeout(() => editorRef.current?.focus(), 0);
    }
  }, [sidebarOpen, sidebarTab]);

  // ─── Focus dialog input ──────────────────────────────────────────────────
  useEffect(() => {
    if (dialog) {
      setTimeout(() => dialogInputRef.current?.focus(), 50);
    }
  }, [dialog]);

  // ─── Open a note ─────────────────────────────────────────────────────────
  const openNote = useCallback(async (rawTarget: string, anchor?: string, external?: boolean, fromLink?: boolean, paneOverride?: 0 | 1) => {
    if (external) {
      window.vaultApp.openExternal(rawTarget);
      return;
    }

    // Image files → ImageViewer; PDFs → PdfViewer
    const ext = rawTarget.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTS.has(ext)) {
      setActiveImage(rawTarget);
      setActiveDiff(null);
      setActivePdf(null);
      return;
    }
    if (ext === 'pdf') {
      setActivePdf(rawTarget);
      setActiveDiff(null);
      setActiveImage(null);
      return;
    }

    if (!snapshot) return;

    // Resolve wikilink target to absolute path
    let filePath = rawTarget;
    if (!rawTarget.endsWith('.md') && !rawTarget.startsWith('/')) {
      const resolved = findPathByStem(rawTarget, snapshot.allPaths, activePath ?? snapshot.vaultPath);
      if (resolved) {
        filePath = resolved;
      } else if (snapshot.vaultPath) {
        const newEntry = await window.vaultApp.createEntry(snapshot.vaultPath, rawTarget, 'file');
        filePath = newEntry.path;
      }
    }

    const pane = paneOverride ?? activePaneIdx;

    if (pane === 1 && splitEnabled) {
      // Open in right pane
      const existing = splitTabs.find(t => t.path === filePath);
      if (existing) { setSplitPath(filePath); return; }
      const doc = await window.vaultApp.openNote(filePath);
      setSplitTabs(prev => prev.find(t => t.path === filePath) ? prev : [...prev, doc]);
      setSplitPath(filePath);
      return;
    }

    // Push current position to history before navigating via a link
    if (fromLink && activePath && activePath !== filePath) {
      setNavHistory(prev => [...prev, { path: activePath, cursor: activeCursorRef.current }]);
    }

    // Check if already open in left pane
    const existing = tabs.find(t => t.path === filePath);
    if (existing) {
      setActivePath(filePath);
      if (anchor) setPendingAnchor(anchor);
      return;
    }

    // Load the note
    const doc = await window.vaultApp.openNote(filePath);
    setTabs(prev => {
      if (prev.find(t => t.path === filePath)) return prev;
      return [...prev, doc];
    });
    setActivePath(filePath);
    if (anchor) setPendingAnchor(anchor);
  }, [snapshot, tabs, activePath, activePaneIdx, splitEnabled, splitTabs]);

  // ─── Export note ─────────────────────────────────────────────────────────
  const exportNote = useCallback(async (format: 'html' | 'pdf') => {
    if (!activeTab) return;
    const html = await marked(activeTab.raw);
    if (format === 'html') {
      await window.vaultApp.exportHtml(activeTab.path, html);
    } else {
      await window.vaultApp.exportPdf(activeTab.path, html);
    }
  }, [activeTab]);

  // ─── Link click from editor ───────────────────────────────────────────────
  const handleLinkClick = useCallback((target: string, external: boolean) => {
    // Parse anchor from target (e.g. "Note#heading")
    const [note, anchor] = target.split('#');
    openNote(note, anchor, external, true);
  }, [openNote]);

  // ─── Close a tab ─────────────────────────────────────────────────────────
  const closeTab = useCallback((path: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.path === path);
      if (idx === -1) return prev;
      const next = prev.filter(t => t.path !== path);
      if (activePath === path) {
        const newActive = next[Math.min(idx, next.length - 1)]?.path ?? null;
        setActivePath(newActive);
      }
      return next;
    });
  }, [activePath]);

  // ─── Jump back in navigation history ─────────────────────────────────────
  const jumpBack = useCallback(() => {
    if (navHistory.length === 0) return;
    const entry = navHistory[navHistory.length - 1];
    setNavHistory(h => h.slice(0, -1));
    pendingCursors.current.set(entry.path, entry.cursor);
    openNote(entry.path);
  }, [navHistory, openNote]);

  // ─── Tab navigation helpers ───────────────────────────────────────────────
  const switchTab = useCallback((delta: number) => {
    if (activePaneIdxRef.current === 1) {
      setSplitTabs(prev => {
        if (prev.length === 0) return prev;
        const idx = prev.findIndex(t => t.path === splitPathRef.current);
        const next = prev[(idx + delta + prev.length) % prev.length];
        if (next) setSplitPath(next.path);
        return prev;
      });
      return;
    }
    if (tabs.length === 0) return;
    const idx = tabs.findIndex(t => t.path === activePath);
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next) setActivePath(next.path);
  }, [tabs, activePath]);

  // ─── Open vertical split (VS Code style) ─────────────────────────────────
  const openSplit = useCallback(async (filePath?: string | null) => {
    const targetPath = filePath ?? activePathRef.current;
    if (!targetPath) return;
    if (!splitEnabledRef.current) {
      // Enable split first, then open the file in the right pane
      const doc = await window.vaultApp.openNote(targetPath);
      setSplitTabs([doc]);
      setSplitPath(targetPath);
      setSplitEnabled(true);
      setActivePaneIdx(1);
      setTimeout(() => splitEditorRef.current?.focus(), 50);
    } else {
      // Split already open — open/switch to the file in the right pane
      if (filePath) {
        const existing = splitTabs.find(t => t.path === filePath);
        if (existing) {
          setSplitPath(filePath);
        } else {
          const doc = await window.vaultApp.openNote(filePath);
          setSplitTabs(prev => [...prev, doc]);
          setSplitPath(filePath);
        }
      }
      setActivePaneIdx(1);
      setTimeout(() => splitEditorRef.current?.focus(), 50);
    }
  }, [splitTabs]);

  // ─── Close right pane ─────────────────────────────────────────────────────
  const closeSplitPane = useCallback(() => {
    setSplitEnabled(false);
    setSplitTabs([]);
    setSplitPath(null);
    setActivePaneIdx(0);
    setTimeout(() => editorRef.current?.focus(), 50);
  }, []);

  // ─── Focus pane by index ──────────────────────────────────────────────────
  const focusPane = useCallback((idx: 0 | 1) => {
    setActivePaneIdx(idx);
    setTimeout(() => {
      if (idx === 0) editorRef.current?.focus();
      else splitEditorRef.current?.focus();
    }, 30);
  }, []);

  // ─── Global keyboard shortcuts + Vim app-event listeners ─────────────────
  useEffect(() => {
    const onTabNext       = () => switchTab(+1);
    const onTabPrev       = () => switchTab(-1);
    const onTabClose      = () => { if (activePath) closeTab(activePath); };
    const onJumpBack      = () => jumpBack();
    const onQuickOpen     = () => setQuickOpenOpen(true);
    const onToggleSidebar = () => setSidebarOpen(v => !v);
    const onToggleOutline = () => setOutlineOpen(v => !v);

    const onKeyDown = (e: KeyboardEvent) => {
      const combo = keyEventToString(e);
      const bindings = settings.appKeybindings ?? DEFAULT_SETTINGS.appKeybindings;
      const binding = bindings.find(kb => kb.key === combo);
      if (!binding) return;
      // Capture-phase handler runs before CodeMirror/Vim — stop propagation so
      // the editor never sees this keystroke.
      e.preventDefault();
      e.stopPropagation();
      switch (binding.action) {
        case 'quickOpen':     setQuickOpenOpen(true); break;
        case 'toggleSidebar': setSidebarOpen(v => !v); break;
        case 'toggleOutline': setOutlineOpen(v => !v); break;
        case 'tabNext':       switchTab(+1); break;
        case 'tabPrev':       switchTab(-1); break;
        case 'tabClose':      if (activePath) closeTab(activePath); break;
        case 'jumpBack':      jumpBack(); break;
        case 'newNote':
          setDialog({ kind: 'create-file', parentPath: snapshot?.vaultPath ?? '' });
          setDialogInput('');
          break;
        case 'openSettings':   setSettingsOpen(true); break;
        case 'focusFileTree':
          if (sidebarOpen && sidebarTab === 'files') {
            setSidebarOpen(false);
          } else {
            setSidebarOpen(true);
            setSidebarTab('files');
            setFocusFileTreeReq(v => (v ?? 0) + 1);
          }
          break;
        case 'focusGit':
          if (sidebarOpen && sidebarTab === 'git') {
            setSidebarOpen(false);
          } else {
            setSidebarOpen(true);
            setSidebarTab('git');
          }
          break;
        case 'focusBacklinks':
          if (sidebarOpen && sidebarTab === 'backlinks') {
            setSidebarOpen(false);
          } else {
            setSidebarOpen(true);
            setSidebarTab('backlinks');
          }
          break;
        case 'splitPane':
          if (!splitEnabledRef.current) {
            openSplit();
          } else {
            // Cycle between panes (like Ctrl+W w)
            focusPane(activePaneIdxRef.current === 0 ? 1 : 0);
          }
          break;
        case 'paneShrink':
          if (splitEnabledRef.current) {
            const next = Math.max(0.1, +(splitRatioRef.current - 0.05).toFixed(3));
            window.vaultApp.updateSettings({ splitPaneRatio: next }).then(updated =>
              setSnapshot(p => p ? { ...p, settings: updated } : p));
          }
          break;
        case 'paneGrow':
          if (splitEnabledRef.current) {
            const next = Math.min(0.9, +(splitRatioRef.current + 0.05).toFixed(3));
            window.vaultApp.updateSettings({ splitPaneRatio: next }).then(updated =>
              setSnapshot(p => p ? { ...p, settings: updated } : p));
          }
          break;
        case 'paneReset':
          if (splitEnabledRef.current) {
            window.vaultApp.updateSettings({ splitPaneRatio: 0.5 }).then(updated =>
              setSnapshot(p => p ? { ...p, settings: updated } : p));
          }
          break;
        case 'toggleTerminal':
          setTerminalOpen(v => {
            if (!v) {
              setTerminalMounted(true);
              // Write context when opening — selection/path read from refs below
              setTimeout(() => window.vaultApp.writeContext(activePathRef.current, editorSelectionRef.current), 0);
            } else {
              setTimeout(() => editorRef.current?.focus(), 0);
            }
            return !v;
          });
          break;
      }
    };

    const onVsplit = (e: CustomEvent<{ filePath: string | null }>) => {
      openSplit(e.detail?.filePath);
    };
    const onWincmd = (e: CustomEvent<{ cmd: string }>) => {
      const cmd = e.detail?.cmd ?? '';
      switch (cmd) {
        case 'v': openSplit(); break;
        case 'w': case '\x17': focusPane(activePaneIdxRef.current === 0 ? 1 : 0); break;
        case 'h': focusPane(0); break;
        case 'l': focusPane(1); break;
        case 'c': case 'q':
          if (activePaneIdxRef.current === 1) closeSplitPane();
          else if (activePathRef.current) closeTab(activePathRef.current);
          break;
      }
    };

    window.addEventListener('obsidian:tab-next',       onTabNext       as EventListener);
    window.addEventListener('obsidian:tab-prev',       onTabPrev       as EventListener);
    window.addEventListener('obsidian:tab-close',      onTabClose      as EventListener);
    window.addEventListener('obsidian:jump-back',      onJumpBack      as EventListener);
    window.addEventListener('obsidian:quick-open',     onQuickOpen     as EventListener);
    window.addEventListener('obsidian:toggle-sidebar', onToggleSidebar as EventListener);
    window.addEventListener('obsidian:toggle-outline', onToggleOutline as EventListener);
    window.addEventListener('obsidian:vsplit',         onVsplit        as EventListener);
    window.addEventListener('obsidian:wincmd',         onWincmd        as EventListener);
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('obsidian:tab-next',       onTabNext       as EventListener);
      window.removeEventListener('obsidian:tab-prev',       onTabPrev       as EventListener);
      window.removeEventListener('obsidian:tab-close',      onTabClose      as EventListener);
      window.removeEventListener('obsidian:jump-back',      onJumpBack      as EventListener);
      window.removeEventListener('obsidian:quick-open',     onQuickOpen     as EventListener);
      window.removeEventListener('obsidian:toggle-sidebar', onToggleSidebar as EventListener);
      window.removeEventListener('obsidian:toggle-outline', onToggleOutline as EventListener);
      window.removeEventListener('obsidian:vsplit',         onVsplit        as EventListener);
      window.removeEventListener('obsidian:wincmd',         onWincmd        as EventListener);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [switchTab, activePath, closeTab, jumpBack, settings.appKeybindings, snapshot, sidebarOpen, sidebarTab, openSplit, closeSplitPane, focusPane]);

  // ─── Mark tab dirty (in BOTH panes if same path is open) ─────────────────
  const markDirty = useCallback((path: string, raw: string) => {
    setTabs(prev =>
      prev.map(t => t.path === path ? { ...t, raw, dirty: true } : t)
    );
    setSplitTabs(prev =>
      prev.map(t => t.path === path ? { ...t, raw, dirty: true } : t)
    );
  }, []);

  // ─── Save note ────────────────────────────────────────────────────────────
  const saveNote = useCallback(async (path: string, raw: string) => {
    await window.vaultApp.saveNote(path, raw);
    setTabs(prev =>
      prev.map(t => t.path === path ? { ...t, raw, dirty: false } : t)
    );
    setSplitTabs(prev =>
      prev.map(t => t.path === path ? { ...t, raw, dirty: false } : t)
    );
  }, []);

  // ─── Per-pane autosave timers (so concurrent edits in both panes don't fight) ─
  const splitAutosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Autosave on change (left pane) ──────────────────────────────────────
  const handleEditorChange = useCallback((raw: string) => {
    if (!activePath) return;
    markDirty(activePath, raw);

    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      saveNote(activePath, raw);
    }, AUTOSAVE_MS);
  }, [activePath, markDirty, saveNote]);

  // ─── Explicit save (left pane) ────────────────────────────────────────────
  const handleEditorSave = useCallback((raw: string) => {
    if (activePath) saveNote(activePath, raw);
  }, [activePath, saveNote]);

  // ─── Autosave on change (right pane) ─────────────────────────────────────
  const handleSplitEditorChange = useCallback((raw: string) => {
    if (!splitPath) return;
    markDirty(splitPath, raw);

    if (splitAutosaveTimer.current) clearTimeout(splitAutosaveTimer.current);
    splitAutosaveTimer.current = setTimeout(() => {
      saveNote(splitPath, raw);
    }, AUTOSAVE_MS);
  }, [splitPath, markDirty, saveNote]);

  // ─── Explicit save (right pane) ───────────────────────────────────────────
  const handleSplitEditorSave = useCallback((raw: string) => {
    if (splitPath) saveNote(splitPath, raw);
  }, [splitPath, saveNote]);

  // ─── Settings ─────────────────────────────────────────────────────────────
  const handleSettingsSave = useCallback(async (partial: Partial<AppSettings>) => {
    const updated = await window.vaultApp.updateSettings(partial);
    setSnapshot(prev => prev ? { ...prev, settings: updated } : prev);
    if (partial.terminalPosition) setTerminalPosition(partial.terminalPosition);
  }, []);

  // ─── Reload open tabs after git restore ──────────────────────────────────
  const handleRestoreComplete = useCallback(async (vaultRelPaths: string[]) => {
    const vaultRoot = snapshotRef.current?.vaultPath;
    if (!vaultRoot) return;
    for (const rel of vaultRelPaths) {
      const fullPath = `${vaultRoot}/${rel}`;
      // Use functional setState to avoid stale closure over `tabs`
      setTabs(prev => {
        if (!prev.find(t => t.path === fullPath)) return prev;
        window.vaultApp.openNote(fullPath).then(doc => {
          setTabs(curr => curr.map(t => t.path === fullPath ? { ...doc, dirty: false } : t));
          if (activePathRef.current === fullPath) {
            window.vaultApp.gitFileAtHead(fullPath).then(setHeadContent);
          }
        });
        return prev; // unchanged until async resolves
      });
    }
  }, []);

  // ─── Open diff view (index vs working tree — shows only unstaged changes) ──
  const openDiff = useCallback(async (vaultRelPath: string) => {
    if (!snapshot?.vaultPath) return;
    const fullPath = `${snapshot.vaultPath}/${vaultRelPath}`;
    const [indexed, note] = await Promise.all([
      window.vaultApp.gitFileAtIndex(fullPath),
      window.vaultApp.openNote(fullPath).catch(() => null),
    ]);
    const current = tabs.find(t => t.path === fullPath)?.raw ?? note?.raw ?? '';
    setActiveDiff({ path: fullPath, head: indexed, current, aLabel: 'Index' });
  }, [snapshot?.vaultPath, tabs]);

  // ─── Open staged diff view (index vs HEAD) ───────────────────────────────
  const openStagedDiff = useCallback(async (vaultRelPath: string) => {
    if (!snapshot?.vaultPath) return;
    const fullPath = `${snapshot.vaultPath}/${vaultRelPath}`;
    const [head, indexed] = await Promise.all([
      window.vaultApp.gitFileAtHead(fullPath),
      window.vaultApp.gitFileAtIndex(fullPath),
    ]);
    setActiveDiff({ path: fullPath, head, current: indexed ?? '', readOnly: true });
  }, [snapshot?.vaultPath]);

  // ─── Fetch HEAD content for git gutter ───────────────────────────────────
  useEffect(() => {
    if (!activePath) { setHeadContent(undefined); return; }
    setHeadContent(undefined);
    window.vaultApp.gitFileAtHead(activePath).then(setHeadContent);
  }, [activePath]);

  // ─── Fetch HEAD content for right-pane git gutter ────────────────────────
  useEffect(() => {
    if (!splitPath) { setSplitHeadContent(undefined); return; }
    setSplitHeadContent(undefined);
    window.vaultApp.gitFileAtHead(splitPath).then(setSplitHeadContent);
  }, [splitPath]);

  // ─── Paste attachment ─────────────────────────────────────────────────────
  const handlePasteAttachment = useCallback(async (data: string, mimeType: string, filename: string): Promise<string> => {
    const result = await window.vaultApp.saveAttachment(data, mimeType, filename);
    return result.relativePath;
  }, []);

  // ─── Zoom (Ctrl+/Ctrl-/Ctrl+0) ───────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        handleSettingsSave({ editorFontSize: Math.min(28, settings.editorFontSize + 1) });
      } else if (e.key === '-') {
        e.preventDefault();
        handleSettingsSave({ editorFontSize: Math.max(12, settings.editorFontSize - 1) });
      } else if (e.key === '0') {
        e.preventDefault();
        handleSettingsSave({ editorFontSize: 17 });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [settings.editorFontSize, handleSettingsSave]);

  // ─── Vault select ─────────────────────────────────────────────────────────
  const selectVault = useCallback(async () => {
    const snap = await window.vaultApp.selectVault();
    if (snap) {
      setSnapshot(snap);
      setTabs([]);
      setActivePath(null);
    }
  }, []);

  // ─── Create entry ─────────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!dialog || !dialogInput.trim()) return;
    const parentPath = dialog.parentPath ?? snapshot?.vaultPath ?? '';
    const kind = dialog.kind === 'create-folder' ? 'dir' : 'file';
    await window.vaultApp.createEntry(parentPath, dialogInput.trim(), kind);
    setDialog(null);
    setDialogInput('');
  }, [dialog, dialogInput, snapshot]);

  // ─── Rename entry ─────────────────────────────────────────────────────────
  const handleRename = useCallback(async () => {
    if (!dialog?.entry || !dialogInput.trim()) return;
    const { newPath } = await window.vaultApp.renameEntry(dialog.entry.path, dialogInput.trim());

    // Update tabs if the renamed note is open
    setTabs(prev =>
      prev.map(t =>
        t.path === dialog.entry!.path ? { ...t, path: newPath } : t
      )
    );
    if (activePath === dialog.entry.path) setActivePath(newPath);

    setDialog(null);
    setDialogInput('');
  }, [dialog, dialogInput, activePath]);

  // ─── Delete entry ─────────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (!dialog?.entry) return;
    await window.vaultApp.deleteEntry(dialog.entry.path);

    // Close any open tabs for this entry (or children)
    setTabs(prev => {
      const toClose = prev.filter(t => t.path === dialog.entry!.path || t.path.startsWith(dialog.entry!.path + '/'));
      for (const t of toClose) closeTab(t.path);
      return prev.filter(t => !toClose.includes(t));
    });

    setDialog(null);
    setDialogInput('');
  }, [dialog, closeTab]);

  // ─── Dialog key handler ───────────────────────────────────────────────────
  const handleDialogKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter')  e.preventDefault(), dialog?.kind === 'delete' ? handleDelete() : (dialog?.kind === 'rename' ? handleRename() : handleCreate());
    if (e.key === 'Escape') setDialog(null);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app-root">
    <div className="app-titlebar">
      <span className="app-titlebar-drag" />
      <div className="titlebar-controls">
        <button className="titlebar-btn minimize" title="Minimieren"
          onClick={() => window.windowControls.minimize()} />
        <button className="titlebar-btn maximize" title="Maximieren"
          onClick={() => window.windowControls.toggleMaximize()} />
        <button className="titlebar-btn close" title="Schließen"
          onClick={() => window.windowControls.close()} />
      </div>
    </div>
    <div className={`app${sidebarOpen ? '' : ' sidebar-hidden'}`}>
      {/* ── Activity bar ─────────────────────────────────────────────────── */}
      <nav className="activity-bar">
        <div className="activity-bar-items">
          <button
            className={`activity-btn${sidebarTab === 'files' && sidebarOpen ? ' active' : ''}`}
            title="Dateien"
            onClick={() => sidebarTab === 'files' ? setSidebarOpen(v => !v) : (setSidebarTab('files'), setSidebarOpen(true))}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <rect x="2" y="1" width="9" height="12" rx="1.2"/>
              <path d="M11 1l3 3v9a1.2 1.2 0 01-1.2 1.2" opacity=".5"/>
              <line x1="4" y1="5" x2="9" y2="5"/>
              <line x1="4" y1="8" x2="9" y2="8"/>
              <line x1="4" y1="11" x2="7" y2="11"/>
            </svg>
          </button>
          <button
            className={`activity-btn${sidebarTab === 'git' && sidebarOpen ? ' active' : ''}`}
            title="Git"
            onClick={() => sidebarTab === 'git' ? setSidebarOpen(v => !v) : (setSidebarTab('git'), setSidebarOpen(true))}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="5" cy="3" r="1.5" fill="currentColor" stroke="none"/>
              <circle cx="5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
              <circle cx="11" cy="6" r="1.5" fill="currentColor" stroke="none"/>
              <line x1="5" y1="4.5" x2="5" y2="11.5"/>
              <path d="M5 4.5 C5 7.5 11 5.5 11 7.5"/>
            </svg>
          </button>
          <button
            className={`activity-btn${sidebarTab === 'backlinks' && sidebarOpen ? ' active' : ''}`}
            title="Rückverknüpfungen (Ctrl+Shift+B)"
            onClick={() => sidebarTab === 'backlinks' ? setSidebarOpen(v => !v) : (setSidebarTab('backlinks'), setSidebarOpen(true))}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M7 4H4a2 2 0 00-2 2v4a2 2 0 002 2h3"/>
              <path d="M9 4h3a2 2 0 012 2v4a2 2 0 01-2 2H9"/>
              <line x1="5" y1="8" x2="11" y2="8"/>
              <polyline points="8 5 11 8 8 11"/>
            </svg>
          </button>
        </div>
        <div className="activity-bar-bottom">
          <button className="activity-btn" title="Einstellungen" onClick={() => setSettingsOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="8" cy="8" r="2.2"/>
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4" strokeWidth="1.3"/>
            </svg>
          </button>
          <button className="activity-btn" title="Vault öffnen" onClick={selectVault}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M1 4.5C1 3.7 1.7 3 2.5 3H6l1.5 2H13.5C14.3 5 15 5.7 15 6.5v6c0 .8-.7 1.5-1.5 1.5h-11C1.7 14 1 13.3 1 12.5v-8z"/>
            </svg>
          </button>
        </div>
      </nav>

      {/* ── Side panel ───────────────────────────────────────────────────── */}
      <aside className="sidebar">
        {/* Header */}
        <div className="sidebar-header">
          <span className={`vault-name${!snapshot?.vaultPath ? ' no-vault' : ''}`}>
            {sidebarTab === 'files'
              ? (snapshot?.vaultPath?.replace(/\\/g, '/').split('/').pop() ?? 'Kein Vault')
              : sidebarTab === 'git' ? 'Git'
              : 'Rückverknüpfungen'}
          </span>
          {sidebarTab === 'files' && (
            <button
              className="icon-btn"
              title="Neue Notiz"
              onClick={() => {
                setDialog({ kind: 'create-file', parentPath: snapshot?.vaultPath ?? '' });
                setDialogInput('');
              }}
            >＋</button>
          )}
          <button className="icon-btn" title="Einstellungen" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>

        {sidebarTab === 'files' ? (
          <>
            {/* Search bar */}
            <div className="search-bar">
              <input
                className="search-input"
                placeholder="🔍 Suchen…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Content: search results or file tree */}
            {searchQuery.trim() ? (
              <div className="search-results">
                {searchResults.length === 0 ? (
                  <div style={{ padding: '12px', color: 'var(--text-faint)', fontSize: 12 }}>
                    Keine Treffer für „{searchQuery}"
                  </div>
                ) : searchResults.map(r => (
                  <div
                    key={r.path}
                    className="search-result"
                    onClick={() => { openNote(r.path); setSearchQuery(''); }}
                  >
                    <div className="search-result-name">{r.name}</div>
                    <div className="search-result-excerpt">{r.excerpt}</div>
                  </div>
                ))}
              </div>
            ) : (
              snapshot?.vaultPath ? (
                <FileTree
                  key={snapshot.vaultPath}
                  tree={snapshot.tree}
                  vaultPath={snapshot.vaultPath}
                  activePath={activePath}
                  vimMode={settings.vimMode}
                  focusRequest={focusFileTreeReq}
                  onOpen={openNote}
                  onCreateFile={path => { setDialog({ kind: 'create-file', parentPath: path }); setDialogInput(''); }}
                  onCreateFolder={path => { setDialog({ kind: 'create-folder', parentPath: path }); setDialogInput(''); }}
                  onRename={entry => { setDialog({ kind: 'rename', entry }); setDialogInput(entry.name.replace(/\.md$/, '')); }}
                  onDelete={entry => { setDialog({ kind: 'delete', entry }); }}
                />
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
                  <div style={{ color: 'var(--text-faint)', fontSize: 13, textAlign: 'center', padding: '0 16px' }}>
                    Kein Vault geöffnet
                  </div>
                </div>
              )
            )}
          </>
        ) : sidebarTab === 'git' ? (
          <GitPanel
            vaultPath={snapshot?.vaultPath ?? null}
            onFileOpen={openNote}
            onOpenDiff={openDiff}
            onOpenStagedDiff={openStagedDiff}
            refreshKey={gitRefreshKey}
            onStagedReset={() => setActiveDiff(d => d?.readOnly ? null : d)}
            onCommit={() => {
              if (activePath) window.vaultApp.gitFileAtHead(activePath).then(setHeadContent);
            }}
            onRestoreComplete={handleRestoreComplete}
          />
        ) : (
          <BacklinksPanel
            targetPath={activePath}
            onOpen={openNote}
          />
        )}
      </aside>

      {/* ── Workspace ────────────────────────────────────────────────────── */}
      <main className="workspace">
        <div className={`workspace-body workspace-body--${terminalOpen ? terminalPosition : 'bottom'}`}>
        {/* Editor toolbar applies to whichever pane is active */}
        {focusedTab && !activeImage && !activePdf && !activeDiff && (
          <div className="editor-toolbar">
            <button
              className={`editor-mode-btn${settings.editorMode === 'live-preview' ? ' active' : ''}`}
              onClick={() => handleSettingsSave({ editorMode: 'live-preview' })}
            >
              Live Preview
            </button>
            <button
              className={`editor-mode-btn${settings.editorMode === 'source' ? ' active' : ''}`}
              onClick={() => handleSettingsSave({ editorMode: 'source' })}
            >
              Quelltext
            </button>
            <div className="editor-toolbar-sep" />
            <button
              className={`editor-mode-btn${settings.vimMode ? ' active' : ''}`}
              onClick={() => handleSettingsSave({ vimMode: !settings.vimMode })}
            >
              VIM
            </button>
            <div className="editor-toolbar-sep" />
            <button
              className={`editor-mode-btn${outlineOpen ? ' active' : ''}`}
              onClick={() => setOutlineOpen(v => !v)}
              title="Gliederung (Ctrl+Shift+O)"
            >
              Gliederung
            </button>
            <div className="editor-toolbar-sep" />
            <button
              className={`editor-mode-btn${splitEnabled ? ' active' : ''}`}
              onClick={() => splitEnabled ? closeSplitPane() : openSplit()}
              title="Split-Ansicht (Ctrl+\ | :vsplit | Ctrl+W v)"
            >
              Split
            </button>
            <div className="editor-toolbar-sep" />
            <button className="editor-mode-btn" onClick={() => exportNote('html')} title="Als HTML exportieren">
              HTML
            </button>
            <button className="editor-mode-btn" onClick={() => exportNote('pdf')} title="Als PDF exportieren">
              PDF
            </button>
            <div className="editor-toolbar-sep" />
            <span className="note-title">{focusedTab.path}</span>
            {focusedTab.dirty && (
              <span style={{ color: 'var(--accent)', fontSize: 11 }}>● Nicht gespeichert</span>
            )}
          </div>
        )}
        <div className={`panes-container${splitEnabled ? ' panes-container--split' : ''}`}>
        <div
          className={`editor-area${splitEnabled ? (activePaneIdx === 0 ? ' pane-active' : '') : ''}`}
          style={splitEnabled ? { flex: `${splitRatio} 1 0` } : undefined}
          onClick={splitEnabled ? () => setActivePaneIdx(0) : undefined}
        >
          <TabBar
            tabs={tabs}
            activePath={activePath}
            onActivate={p => { setActivePath(p); setActiveDiff(null); setActiveImage(null); setActivePdf(null); }}
            onClose={closeTab}
          />
          {activeImage && snapshot?.vaultPath ? (
            <ImageViewer
              path={activeImage}
              vaultPath={snapshot.vaultPath}
              onClose={() => setActiveImage(null)}
            />
          ) : activePdf && snapshot?.vaultPath ? (
            <PdfViewer
              path={activePdf}
              vaultPath={snapshot.vaultPath}
              onClose={() => setActivePdf(null)}
            />
          ) : activeDiff ? (
            <DiffViewer
              path={activeDiff.path}
              vaultPath={snapshot?.vaultPath ?? ''}
              headContent={activeDiff.head}
              currentContent={activeDiff.current}
              readOnly={activeDiff.readOnly}
              aLabel={activeDiff.aLabel}
              theme={settings.theme}
              fontFamily={settings.editorFontFamily}
              fontSize={settings.editorFontSize}
              lineHeight={settings.editorLineHeight}
              onSave={newContent => {
                setTabs(prev => prev.map(t =>
                  t.path === activeDiff.path ? { ...t, raw: newContent, dirty: false } : t
                ));
                setActiveDiff(d => d ? { ...d, current: newContent } : d);
              }}
              onClose={() => setActiveDiff(null)}
              onHunkStaged={async () => {
                setGitRefreshKey(k => k + 1);
                // Re-fetch the index side so the diff shows remaining unstaged changes
                if (activeDiff && !activeDiff.readOnly) {
                  const newIndexed = await window.vaultApp.gitFileAtIndex(activeDiff.path);
                  setActiveDiff(d => d ? { ...d, head: newIndexed } : d);
                }
              }}
            />
          ) : activeTab ? (
            <>
              <MarkdownEditor
                ref={editorRef}
                key={activeTab.path}
                doc={activeTab}
                editorMode={settings.editorMode}
                vimMode={settings.vimMode}
                vimKeybindings={settings.vimKeybindings}
                vimLeader={settings.vimLeader ?? '\\'}
                fontFamily={settings.editorFontFamily}
                fontSize={settings.editorFontSize}
                lineHeight={settings.editorLineHeight}
                linkFormat={settings.linkFormat}
                vaultPath={snapshot?.vaultPath ?? ''}
                allPaths={snapshot?.allPaths ?? []}
                pendingAnchor={pendingAnchor}
                initialCursor={pendingCursors.current.get(activeTab.path)}
                onSave={handleEditorSave}
                onChange={handleEditorChange}
                onLinkClick={handleLinkClick}
                headContent={headContent}
                onPasteAttachment={handlePasteAttachment}
                onCursorChange={(pos) => {
                  activeCursorRef.current = pos;
                  if (activePath) pendingCursors.current.set(activePath, pos);
                }}
                onSelectionChange={setEditorSelection}
                onHeadingsChange={headings => {
                  setTabs(prev => prev.map(t =>
                    t.path === activeTab.path ? { ...t, headings } : t
                  ));
                }}
              />
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📝</div>
              <div className="empty-state-title">Obsidian Clone</div>
              <div className="empty-state-sub">
                {snapshot?.vaultPath
                  ? 'Wähle eine Notiz aus dem Dateibaum'
                  : 'Öffne einen Vault-Ordner um zu starten'}
              </div>
              {!snapshot?.vaultPath && (
                <button className="empty-state-btn" onClick={selectVault}>
                  Vault öffnen
                </button>
              )}
            </div>
          )}
        </div>{/* editor-area (left pane) */}

        {/* ── Resize handle (drag) ────────────────────────────────────── */}
        {splitEnabled && (
          <div
            className="pane-resize-handle"
            onMouseDown={e => {
              e.preventDefault();
              const container = (e.currentTarget.parentElement as HTMLElement);
              const startX = e.clientX;
              const startRatio = splitRatioRef.current;
              const totalWidth = container.getBoundingClientRect().width;
              const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const next = Math.max(0.1, Math.min(0.9, startRatio + dx / totalWidth));
                // Update via settings so it persists
                window.vaultApp.updateSettings({ splitPaneRatio: +next.toFixed(3) }).then(updated =>
                  setSnapshot(p => p ? { ...p, settings: updated } : p));
              };
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          />
        )}

        {/* ── Right split pane ────────────────────────────────────────── */}
        {splitEnabled && (
          <div
            className={`editor-area split-pane-right${activePaneIdx === 1 ? ' pane-active' : ''}`}
            style={{ flex: `${1 - splitRatio} 1 0` }}
            onClick={() => setActivePaneIdx(1)}
          >
            <TabBar
              tabs={splitTabs}
              activePath={splitPath}
              onActivate={p => setSplitPath(p)}
              onClose={p => {
                setSplitTabs(prev => {
                  const next = prev.filter(t => t.path !== p);
                  if (next.length === 0) {
                    // Last tab closed → close the split pane
                    setSplitEnabled(false);
                    setSplitPath(null);
                    setActivePaneIdx(0);
                    setTimeout(() => editorRef.current?.focus(), 50);
                  } else {
                    if (splitPath === p) setSplitPath(next[next.length - 1]?.path ?? null);
                  }
                  return next;
                });
              }}
            />
            {splitTab ? (
              <MarkdownEditor
                ref={splitEditorRef}
                key={splitTab.path + '-split'}
                doc={splitTab}
                editorMode={settings.editorMode}
                vimMode={settings.vimMode}
                vimKeybindings={settings.vimKeybindings}
                vimLeader={settings.vimLeader ?? '\\'}
                fontFamily={settings.editorFontFamily}
                fontSize={settings.editorFontSize}
                lineHeight={settings.editorLineHeight}
                linkFormat={settings.linkFormat}
                vaultPath={snapshot?.vaultPath ?? ''}
                allPaths={snapshot?.allPaths ?? []}
                pendingAnchor={null}
                onSave={handleSplitEditorSave}
                onChange={handleSplitEditorChange}
                onLinkClick={(target, external) => {
                  const [note, anchor] = target.split('#');
                  openNote(note, anchor, external, true, 1);
                }}
                headContent={splitHeadContent}
                onPasteAttachment={handlePasteAttachment}
                onHeadingsChange={headings => {
                  setSplitTabs(prev => prev.map(t =>
                    t.path === splitTab.path ? { ...t, headings } : t
                  ));
                }}
              />
            ) : (
              <div className="empty-state">
                <div className="empty-state-sub">Keine Notiz geöffnet</div>
              </div>
            )}
          </div>
        )}
        </div>{/* panes-container */}

        {/* ── Terminal panel ──────────────────────────────────────────── */}
        {terminalMounted && (
          <TerminalPanel
            key="terminal"
            vaultPath={snapshot?.vaultPath ?? null}
            activeFile={activePath}
            selection={editorSelection}
            theme={settings.theme}
            position={terminalPosition}
            visible={terminalOpen}
            size={terminalSize}
            onSizeChange={setTerminalSize}
            onPositionToggle={() => setTerminalPosition(p => {
              const next = p === 'bottom' ? 'right' : 'bottom';
              handleSettingsSave({ terminalPosition: next });
              return next;
            })}
            onContextUpdate={() => window.vaultApp.writeContext(activePathRef.current, editorSelectionRef.current)}
            onClose={() => { setTerminalOpen(false); setTimeout(() => editorRef.current?.focus(), 0); }}
          />
        )}
        </div>{/* workspace-body */}
      </main>

      {/* ── Outline panel ───────────────────────────────────────────────── */}
      {outlineOpen && activeTab && (
        <OutlinePanel
          headings={activeTab.headings}
          onJumpTo={(slug) => setPendingAnchor(slug)}
        />
      )}

      {/* ── Quick Open ──────────────────────────────────────────────────── */}
      {quickOpenOpen && (
        <QuickOpen
          allPaths={snapshot?.allPaths ?? []}
          onOpen={path => openNote(path)}
          onClose={() => { setQuickOpenOpen(false); setTimeout(() => editorRef.current?.focus(), 0); }}
        />
      )}

      {/* ── Settings panel ──────────────────────────────────────────────── */}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onSave={handleSettingsSave}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      {dialog && dialog.kind !== 'delete' && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">
              {dialog.kind === 'create-file'   && '📄 Neue Notiz erstellen'}
              {dialog.kind === 'create-folder' && '📁 Neuen Ordner erstellen'}
              {dialog.kind === 'rename'        && `✏️ Umbenennen: ${dialog.entry?.name}`}
            </div>
            <input
              ref={dialogInputRef}
              className="modal-input"
              placeholder={dialog.kind === 'create-folder' ? 'Ordnername' : 'Notizname'}
              value={dialogInput}
              onChange={e => setDialogInput(e.target.value)}
              onKeyDown={handleDialogKey}
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDialog(null)}>Abbrechen</button>
              <button
                className="btn btn-primary"
                onClick={() => dialog.kind === 'rename' ? handleRename() : handleCreate()}
              >
                {dialog.kind === 'rename' ? 'Umbenennen' : 'Erstellen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog?.kind === 'delete' && dialog.entry && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">🗑️ Löschen bestätigen</div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
              „<strong>{dialog.entry.name}</strong>" wirklich löschen?
              {dialog.entry.kind === 'dir' && ' (inklusive aller Unterordner und Notizen)'}
            </p>
            <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
              Diese Aktion kann nicht rückgängig gemacht werden.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDialog(null)}>Abbrechen</button>
              <button className="btn btn-danger" onClick={handleDelete}>Löschen</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
