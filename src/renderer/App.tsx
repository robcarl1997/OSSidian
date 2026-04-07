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
import { findPathByStem } from '../../shared/linking';
import TabBar from './components/TabBar';
import FileTree from './components/FileTree';
import SettingsPanel from './components/SettingsPanel';
import MarkdownEditor from './editor/MarkdownEditor';

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

  const deferredSearch = useDeferredValue(searchQuery);
  const autosaveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogInputRef = useRef<HTMLInputElement>(null);

  const settings: AppSettings = snapshot?.settings ?? DEFAULT_SETTINGS;
  const activeTab = tabs.find(t => t.path === activePath) ?? null;

  // ─── Apply theme ────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  // ─── Initial load ────────────────────────────────────────────────────────────
  useEffect(() => {
    window.vaultApp.getInitialState().then(snap => {
      setSnapshot(snap);
    });
  }, []);

  // ─── Vault change events ──────────────────────────────────────────────────
  useEffect(() => {
    return window.vaultApp.onVaultChanged(event => {
      setSnapshot(event.snapshot);
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

  // ─── Focus dialog input ──────────────────────────────────────────────────
  useEffect(() => {
    if (dialog) {
      setTimeout(() => dialogInputRef.current?.focus(), 50);
    }
  }, [dialog]);

  // ─── Open a note ─────────────────────────────────────────────────────────
  const openNote = useCallback(async (rawTarget: string, anchor?: string, external?: boolean) => {
    if (external) {
      window.vaultApp.openExternal(rawTarget);
      return;
    }

    if (!snapshot) return;

    // Resolve wikilink target to absolute path
    let filePath = rawTarget;
    if (!rawTarget.endsWith('.md') && !rawTarget.startsWith('/')) {
      // Try to resolve as a note name
      const resolved = findPathByStem(rawTarget, snapshot.allPaths, activePath ?? snapshot.vaultPath);
      if (resolved) {
        filePath = resolved;
      } else if (snapshot.vaultPath) {
        // Note doesn't exist yet – create it
        const newEntry = await window.vaultApp.createEntry(snapshot.vaultPath, rawTarget, 'file');
        filePath = newEntry.path;
      }
    }

    // Check if already open
    const existing = tabs.find(t => t.path === filePath);
    if (existing) {
      setActivePath(filePath);
      if (anchor) setPendingAnchor(anchor);
      return;
    }

    // Load the note
    const doc = await window.vaultApp.openNote(filePath);
    setTabs(prev => {
      // Replace existing tab or add new
      if (prev.find(t => t.path === filePath)) return prev;
      return [...prev, doc];
    });
    setActivePath(filePath);
    if (anchor) setPendingAnchor(anchor);
  }, [snapshot, tabs, activePath]);

  // ─── Link click from editor ───────────────────────────────────────────────
  const handleLinkClick = useCallback((target: string, external: boolean) => {
    // Parse anchor from target (e.g. "Note#heading")
    const [note, anchor] = target.split('#');
    openNote(note, anchor, external);
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

  // ─── Tab navigation helpers ───────────────────────────────────────────────
  const switchTab = useCallback((delta: number) => {
    if (tabs.length === 0) return;
    const idx = tabs.findIndex(t => t.path === activePath);
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next) setActivePath(next.path);
  }, [tabs, activePath]);

  // ─── Global keyboard shortcuts + Vim app-event listeners ─────────────────
  useEffect(() => {
    const onTabNext  = () => switchTab(+1);
    const onTabPrev  = () => switchTab(-1);
    const onTabClose = () => { if (activePath) closeTab(activePath); };

    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && e.key === 'Tab')  { e.preventDefault(); switchTab(+1); }
      if (ctrl &&  e.shiftKey && e.key === 'Tab')  { e.preventDefault(); switchTab(-1); }
      if (ctrl && e.key === 'PageDown')            { e.preventDefault(); switchTab(+1); }
      if (ctrl && e.key === 'PageUp')              { e.preventDefault(); switchTab(-1); }
      if (ctrl && e.key === 'w' && activePath)     { e.preventDefault(); closeTab(activePath); }
    };

    window.addEventListener('obsidian:tab-next',  onTabNext  as EventListener);
    window.addEventListener('obsidian:tab-prev',  onTabPrev  as EventListener);
    window.addEventListener('obsidian:tab-close', onTabClose as EventListener);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('obsidian:tab-next',  onTabNext  as EventListener);
      window.removeEventListener('obsidian:tab-prev',  onTabPrev  as EventListener);
      window.removeEventListener('obsidian:tab-close', onTabClose as EventListener);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [switchTab, activePath, closeTab]);

  // ─── Mark tab dirty ───────────────────────────────────────────────────────
  const markDirty = useCallback((path: string, raw: string) => {
    setTabs(prev =>
      prev.map(t => t.path === path ? { ...t, raw, dirty: true } : t)
    );
  }, []);

  // ─── Save note ────────────────────────────────────────────────────────────
  const saveNote = useCallback(async (path: string, raw: string) => {
    await window.vaultApp.saveNote(path, raw);
    setTabs(prev =>
      prev.map(t => t.path === path ? { ...t, raw, dirty: false } : t)
    );
  }, []);

  // ─── Autosave on change ───────────────────────────────────────────────────
  const handleEditorChange = useCallback((raw: string) => {
    if (!activePath) return;
    markDirty(activePath, raw);

    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      saveNote(activePath, raw);
    }, AUTOSAVE_MS);
  }, [activePath, markDirty, saveNote]);

  // ─── Explicit save ────────────────────────────────────────────────────────
  const handleEditorSave = useCallback((raw: string) => {
    if (activePath) saveNote(activePath, raw);
  }, [activePath, saveNote]);

  // ─── Settings ─────────────────────────────────────────────────────────────
  const handleSettingsSave = useCallback(async (partial: Partial<AppSettings>) => {
    const updated = await window.vaultApp.updateSettings(partial);
    setSnapshot(prev => prev ? { ...prev, settings: updated } : prev);
  }, []);

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
    <div className="app">
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="sidebar">
        {/* Header */}
        <div className="sidebar-header">
          <span className={`vault-name${!snapshot?.vaultPath ? ' no-vault' : ''}`}>
            {snapshot?.vaultPath
              ? snapshot.vaultPath.replace(/\\/g, '/').split('/').pop()
              : 'Kein Vault'}
          </span>
          <button
            className="icon-btn"
            title="Neue Notiz"
            onClick={() => {
              setDialog({ kind: 'create-file', parentPath: snapshot?.vaultPath ?? '' });
              setDialogInput('');
            }}
          >＋</button>
          <button
            className="icon-btn"
            title="Einstellungen"
            onClick={() => setSettingsOpen(true)}
          >⚙</button>
        </div>

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
              tree={snapshot.tree}
              vaultPath={snapshot.vaultPath}
              activePath={activePath}
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

        {/* Footer */}
        <div className="sidebar-footer">
          <button className="sidebar-footer-btn" onClick={selectVault}>
            📂 Vault öffnen
          </button>
        </div>
      </aside>

      {/* ── Workspace ────────────────────────────────────────────────────── */}
      <main className="workspace">
        <TabBar
          tabs={tabs}
          activePath={activePath}
          onActivate={setActivePath}
          onClose={closeTab}
        />

        <div className="editor-area">
          {activeTab ? (
            <>
              {/* Editor toolbar */}
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
                <span className="note-title">{activeTab.path}</span>
                {activeTab.dirty && (
                  <span style={{ color: 'var(--accent)', fontSize: 11 }}>● Nicht gespeichert</span>
                )}
              </div>

              <MarkdownEditor
                key={activeTab.path}
                doc={activeTab}
                editorMode={settings.editorMode}
                vimMode={settings.vimMode}
                vimKeybindings={settings.vimKeybindings}
                fontFamily={settings.editorFontFamily}
                fontSize={settings.editorFontSize}
                lineHeight={settings.editorLineHeight}
                allPaths={snapshot?.allPaths ?? []}
                pendingAnchor={pendingAnchor}
                onSave={handleEditorSave}
                onChange={handleEditorChange}
                onLinkClick={handleLinkClick}
                onHeadingsChange={headings => {
                  setTabs(prev => prev.map(t =>
                    t.path === activeTab.path ? { ...t, headings } : t
                  ));
                  // Clear anchor after navigation
                  setPendingAnchor(null);
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
        </div>
      </main>

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
  );
}
