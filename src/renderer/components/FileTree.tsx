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

// ─── Tree node ────────────────────────────────────────────────────────────────

interface NodeProps {
  entry: VaultEntry;
  depth: number;
  activePath: string | null;
  onOpen: (path: string) => void;
  onCtxMenu: (e: React.MouseEvent, entry: VaultEntry) => void;
}

function TreeNode({ entry, depth, activePath, onOpen, onCtxMenu }: NodeProps) {
  const [open, setOpen] = useState(depth < 2);

  const indent = depth * 14;
  const isFile  = entry.kind === 'file';
  const isImage = isFile && isImageFile(entry.name);
  const isActive = entry.path === activePath;

  const handleClick = () => {
    if (isFile) {
      onOpen(entry.path);
    } else {
      setOpen(o => !o);
    }
  };

  return (
    <>
      <div
        className={`tree-item${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + indent }}
        onClick={handleClick}
        onContextMenu={e => { e.preventDefault(); onCtxMenu(e, entry); }}
        title={entry.path}
      >
        {/* Expand arrow for dirs */}
        {!isFile && (
          <span className={`tree-expand${open ? ' open' : ''}`}>▶</span>
        )}
        {isFile && <span style={{ width: 16, display: 'inline-block' }} />}

        {/* Icon */}
        <span className="tree-icon">
          {!isFile ? (open ? '📂' : '📁') : isImage ? '🖼️' : '📄'}
        </span>

        {/* Name */}
        <span className="tree-name">
          {isImage ? entry.name : isFile ? entry.name.replace(/\.md$/, '') : entry.name}
        </span>
      </div>

      {/* Children */}
      {!isFile && open && entry.children && entry.children.map(child => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          activePath={activePath}
          onOpen={onOpen}
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
  onOpen,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
}: FileTreeProps) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openCtxMenu = useCallback((e: React.MouseEvent, entry: VaultEntry) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

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

  return (
    <div className="file-tree">
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
          onOpen={onOpen}
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
