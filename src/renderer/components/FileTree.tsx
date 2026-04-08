import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { VaultEntry } from '../../../shared/ipc';

// ─── Context menu ─────────────────────────────────────────────────────────────

interface CtxMenu {
  x: number;
  y: number;
  entry: VaultEntry;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface FileTreeProps {
  tree: VaultEntry[];
  vaultPath: string;
  activePath: string | null;
  vimMode?: boolean;
  focusRequest?: number;
  onOpen: (path: string) => void;
  onCreateFile: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onRename: (entry: VaultEntry) => void;
  onDelete: (entry: VaultEntry) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif']);
function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has((name.split('.').pop() ?? '').toLowerCase());
}
function isPdfFile(name: string): boolean {
  return (name.split('.').pop() ?? '').toLowerCase() === 'pdf';
}

function getInitialOpenPaths(entries: VaultEntry[], depth = 0): Set<string> {
  const result = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'dir' && depth < 2) {
      result.add(e.path);
      if (e.children) {
        getInitialOpenPaths(e.children, depth + 1).forEach(p => result.add(p));
      }
    }
  }
  return result;
}

function flatVisible(entries: VaultEntry[], openPaths: Set<string>): VaultEntry[] {
  const result: VaultEntry[] = [];
  for (const entry of entries) {
    result.push(entry);
    if (entry.kind === 'dir' && openPaths.has(entry.path) && entry.children) {
      result.push(...flatVisible(entry.children, openPaths));
    }
  }
  return result;
}

// ─── Tree node ────────────────────────────────────────────────────────────────

interface NodeProps {
  entry: VaultEntry;
  depth: number;
  activePath: string | null;
  focusedPath: string | null;
  openPaths: Set<string>;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onFocusItem: (path: string) => void;
  onCtxMenu: (e: React.MouseEvent, entry: VaultEntry) => void;
}

function TreeNode({ entry, depth, activePath, focusedPath, openPaths, onOpen, onToggle, onFocusItem, onCtxMenu }: NodeProps) {
  const open      = entry.kind === 'dir' && openPaths.has(entry.path);
  const isFocused = entry.path === focusedPath;
  const indent    = depth * 14;
  const isFile    = entry.kind === 'file';
  const isImage   = isFile && isImageFile(entry.name);
  const isPdf     = isFile && isPdfFile(entry.name);
  const isActive  = entry.path === activePath;

  const handleClick = () => {
    onFocusItem(entry.path);
    if (isFile) onOpen(entry.path);
    else        onToggle(entry.path);
  };

  return (
    <>
      <div
        className={`tree-item${isActive ? ' active' : ''}${isFocused ? ' vim-focused' : ''}`}
        data-focused={isFocused ? 'true' : undefined}
        style={{ paddingLeft: 8 + indent }}
        onClick={handleClick}
        onContextMenu={e => { e.preventDefault(); onCtxMenu(e, entry); }}
        title={entry.path}
      >
        {!isFile && (
          <span className={`tree-expand${open ? ' open' : ''}`}>▶</span>
        )}
        {isFile && <span style={{ width: 16, display: 'inline-block' }} />}

        <span className="tree-icon">
          {!isFile ? (open ? '📂' : '📁') : isImage ? '🖼️' : isPdf ? '📋' : '📄'}
        </span>

        <span className="tree-name">
          {(isImage || isPdf) ? entry.name : isFile ? entry.name.replace(/\.md$/, '') : entry.name}
        </span>
      </div>

      {!isFile && open && entry.children && entry.children.map(child => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          activePath={activePath}
          focusedPath={focusedPath}
          openPaths={openPaths}
          onOpen={onOpen}
          onToggle={onToggle}
          onFocusItem={onFocusItem}
          onCtxMenu={onCtxMenu}
        />
      ))}
    </>
  );
}

// ─── FileTree component ───────────────────────────────────────────────────────

export default function FileTree({
  tree,
  vaultPath: _vaultPath,
  activePath,
  vimMode = false,
  focusRequest,
  onOpen,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
}: FileTreeProps) {
  const [ctxMenu,      setCtxMenu]      = useState<CtxMenu | null>(null);
  const [openPaths,    setOpenPaths]    = useState<Set<string>>(() => getInitialOpenPaths(tree));
  const [focusedPath,  setFocusedPath]  = useState<string | null>(null);
  const menuRef      = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastKeyRef   = useRef<string | null>(null);
  const lastKeyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll focused item into view
  useEffect(() => {
    if (!focusedPath) return;
    const el = containerRef.current?.querySelector('[data-focused="true"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedPath]);

  // Focus the tree when an external focusRequest comes in
  useEffect(() => {
    if (focusRequest === undefined) return;
    containerRef.current?.focus();
    setFocusedPath(prev => {
      if (prev) return prev;
      return flatVisible(tree, openPaths)[0]?.path ?? null;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctxMenu]);

  const openCtxMenu = useCallback((e: React.MouseEvent, entry: VaultEntry) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const toggleOpen = useCallback((path: string) => {
    setOpenPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Ignore when context menu or a button inside the tree has focus
    const target = e.target as HTMLElement;
    if (target.closest('.context-menu') || (target !== containerRef.current && target.tagName === 'BUTTON')) return;

    const flat = flatVisible(tree, openPaths);
    if (flat.length === 0) return;
    const idx = focusedPath ? flat.findIndex(f => f.path === focusedPath) : -1;

    const vim = vimMode && !e.ctrlKey && !e.metaKey && !e.altKey;

    // gg sequence
    if (vim && e.key === 'g') {
      if (lastKeyRef.current === 'g') {
        e.preventDefault();
        setFocusedPath(flat[0].path);
        lastKeyRef.current = null;
        if (lastKeyTimer.current) clearTimeout(lastKeyTimer.current);
      } else {
        lastKeyRef.current = 'g';
        if (lastKeyTimer.current) clearTimeout(lastKeyTimer.current);
        lastKeyTimer.current = setTimeout(() => { lastKeyRef.current = null; }, 400);
      }
      return;
    }
    lastKeyRef.current = null;
    if (lastKeyTimer.current) { clearTimeout(lastKeyTimer.current); lastKeyTimer.current = null; }

    const isDown  = e.key === 'ArrowDown'  || (vim && e.key === 'j');
    const isUp    = e.key === 'ArrowUp'    || (vim && e.key === 'k');
    const isRight = e.key === 'ArrowRight' || (vim && e.key === 'l');
    const isLeft  = e.key === 'ArrowLeft'  || (vim && e.key === 'h');
    const isEnter = e.key === 'Enter';
    const isCapG  = vim && e.key === 'G';

    if (!isDown && !isUp && !isRight && !isLeft && !isEnter && !isCapG) return;
    e.preventDefault();

    if (isDown) {
      setFocusedPath(flat[idx < 0 ? 0 : Math.min(idx + 1, flat.length - 1)].path);
    } else if (isUp) {
      setFocusedPath(flat[idx < 0 ? 0 : Math.max(idx - 1, 0)].path);
    } else if (isCapG) {
      setFocusedPath(flat[flat.length - 1].path);
    } else if (isRight) {
      const entry = flat[idx];
      if (!entry) { setFocusedPath(flat[0].path); return; }
      if (entry.kind === 'dir') {
        if (!openPaths.has(entry.path)) {
          setOpenPaths(prev => new Set([...prev, entry.path]));
        } else if (idx + 1 < flat.length) {
          setFocusedPath(flat[idx + 1].path); // step into first child
        }
      } else {
        onOpen(entry.path);
      }
    } else if (isLeft) {
      const entry = flat[idx];
      if (!entry) return;
      if (entry.kind === 'dir' && openPaths.has(entry.path)) {
        setOpenPaths(prev => { const n = new Set(prev); n.delete(entry.path); return n; });
      } else if (entry.parentPath) {
        const parentIdx = flat.findIndex(f => f.path === entry.parentPath);
        if (parentIdx >= 0) setFocusedPath(flat[parentIdx].path);
      }
    } else if (isEnter) {
      const entry = flat[idx];
      if (!entry) return;
      if (entry.kind === 'file') onOpen(entry.path);
      else toggleOpen(entry.path);
    }
  }, [tree, openPaths, focusedPath, vimMode, onOpen, toggleOpen]);

  return (
    <div
      ref={containerRef}
      className="file-tree"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {tree.length === 0 && (
        <div style={{ padding: '16px 12px', color: 'var(--text-faint)', fontSize: 12 }}>
          Keine Notizen vorhanden.<br />
          Klicke + um eine neue Notiz zu erstellen.
        </div>
      )}

      {tree.map(entry => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          activePath={activePath}
          focusedPath={focusedPath}
          openPaths={openPaths}
          onOpen={onOpen}
          onToggle={toggleOpen}
          onFocusItem={setFocusedPath}
          onCtxMenu={openCtxMenu}
        />
      ))}

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={e => e.stopPropagation()}
        >
          {ctxMenu.entry.kind === 'dir' && (
            <>
              <button
                className="context-menu-item"
                onClick={() => { onCreateFile(ctxMenu.entry.path); setCtxMenu(null); }}
              >
                📄 Neue Notiz
              </button>
              <button
                className="context-menu-item"
                onClick={() => { onCreateFolder(ctxMenu.entry.path); setCtxMenu(null); }}
              >
                📁 Neuer Ordner
              </button>
              <div className="context-menu-sep" />
            </>
          )}
          {ctxMenu.entry.kind === 'file' && (
            <button
              className="context-menu-item"
              onClick={() => { onOpen(ctxMenu.entry.path); setCtxMenu(null); }}
            >
              📄 Öffnen
            </button>
          )}
          <button
            className="context-menu-item"
            onClick={() => { onRename(ctxMenu.entry); setCtxMenu(null); }}
          >
            ✏️ Umbenennen
          </button>
          <div className="context-menu-sep" />
          <button
            className="context-menu-item danger"
            onClick={() => { onDelete(ctxMenu.entry); setCtxMenu(null); }}
          >
            🗑️ Löschen
          </button>
        </div>
      )}
    </div>
  );
}
