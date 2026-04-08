import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Theme } from '../../../shared/ipc';

const SAVE_DEBOUNCE_MS = 600;

// ─── Theme ───────────────────────────────────────────────────────────────────

function makeEditorTheme(theme: Theme, fontFamily: string, fontSize: number, lineHeight: number): Extension {
  const isDark  = theme === 'dark';
  const bg      = theme === 'dark' ? '#1e1e2e' : theme === 'light' ? '#f8f8f8' : '#f5ede1';
  const fg      = theme === 'dark' ? '#cdd6f4' : theme === 'light' ? '#2c2c2c' : '#3d2b1f';
  const gutter  = theme === 'dark' ? '#181825' : theme === 'light' ? '#efefef' : '#ede0d0';
  const gutterFg = theme === 'dark' ? '#585b70' : theme === 'light' ? '#aaaaaa' : '#a08070';
  const sel     = theme === 'dark' ? '#313244' : theme === 'light' ? '#d8d8d8' : '#ddd0bc';
  const cursor  = theme === 'dark' ? '#cba6f7' : theme === 'light' ? '#7c3aed' : '#c66115';
  return EditorView.theme({
    '&': { height: '100%', background: bg, color: fg, fontSize: `${fontSize}px` },
    '.cm-scroller': { overflow: 'auto', fontFamily, lineHeight: String(lineHeight) },
    '.cm-content': { padding: '12px 16px', caretColor: cursor },
    '.cm-line': { padding: '0' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, ::selection': { background: sel },
    '.cm-gutters': { background: gutter, color: gutterFg, border: 'none', paddingRight: '4px' },
    '.cm-activeLineGutter': { background: 'transparent' },
    '.cm-cursor': { borderLeftColor: cursor },
    '.cm-changedLine':  { background: isDark ? '#2a2d45' : theme === 'sepia' ? '#e8d9c5' : '#e8f0fe' },
    '.cm-deletedLine':  { background: isDark ? '#3d1f2a' : theme === 'sepia' ? '#f0cfc0' : '#fce8e8' },
    '.cm-changedText':  { background: isDark ? '#4a4070' : theme === 'sepia' ? '#d0b090' : '#c5d8ff' },
    '.cm-deletedText':  { background: isDark ? '#7a2540' : theme === 'sepia' ? '#c09080' : '#f5b8b8' },
    '.cm-insertedLine': { background: isDark ? '#1e3a2a' : theme === 'sepia' ? '#d0e0c0' : '#e6f4ea' },
    '.cm-insertedText': { background: isDark ? '#2a6040' : theme === 'sepia' ? '#a0c080' : '#a8d5b5' },
    // Deleted chunk widget — make removed lines legible
    '.cm-deletedChunk': {
      background: isDark ? '#3d1f2a' : theme === 'sepia' ? '#f0cfc0' : '#fce8e8',
      padding: '2px 0',
    },
    '.cm-deletedChunk .cm-deletedLine': {
      display: 'block',
      minHeight: `${lineHeight}em`,
      padding: '0 16px',
      lineHeight: String(lineHeight),
      color: isDark ? '#f38ba8' : theme === 'sepia' ? '#c05030' : '#c0392b',
    },
    '.cm-deletedChunk del': { textDecoration: 'none' },
  }, { dark: isDark });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface DiffViewerProps {
  path: string;
  vaultPath: string;
  headContent: string | null;
  currentContent: string;
  readOnly?: boolean;
  theme: Theme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  onSave: (newContent: string) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DiffViewer({
  path,
  vaultPath,
  headContent,
  currentContent,
  readOnly = false,
  theme,
  fontFamily,
  fontSize,
  lineHeight,
  onSave,
  onClose,
}: DiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeRef     = useRef<MergeView | null>(null);
  const onSaveRef    = useRef(onSave);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const relPath = path.startsWith(vaultPath + '/') ? path.slice(vaultPath.length + 1) : path;
  const name    = path.split('/').pop() ?? path;

  useEffect(() => { onSaveRef.current = onSave; });

  // ─── Create / destroy MergeView ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const base: Extension[] = [
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      lineNumbers(),
      EditorView.lineWrapping,
      makeEditorTheme(theme, fontFamily, fontSize, lineHeight),
    ];

    const bExts: Extension[] = readOnly
      ? [...base, EditorState.readOnly.of(true)]
      : [
          ...base,
          EditorView.updateListener.of(update => {
            if (!update.docChanged) return;
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
              const content = update.state.doc.toString();
              window.vaultApp.saveNote(path, content);
              onSaveRef.current(content);
            }, SAVE_DEBOUNCE_MS);
          }),
        ];

    // Capture relPath for use inside the closure (stable for lifetime of this effect)
    const stableRelPath = relPath;

    const mv = new MergeView({
      parent: containerRef.current,
      a: { doc: headContent ?? '', extensions: [...base, EditorState.readOnly.of(true)] },
      b: { doc: currentContent, extensions: bExts },
      revertControls: readOnly ? undefined : 'a-to-b',
      renderRevertControl: readOnly ? undefined : () => {
        // CM will call this factory for each chunk, then set data-chunk on the returned element.
        // We return a wrapper div (not button) so CM's ".cm-merge-revert button" CSS
        // (which sets position:absolute) doesn't apply to our inner elements.
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-revert-wrapper';

        // Revert span — mousedown bubbles to CM's revertDOM listener → reverts chunk
        const revertBtn = document.createElement('span');
        revertBtn.className = 'cm-revert-btn';
        revertBtn.textContent = '←';
        revertBtn.title = 'Änderung zurücksetzen';
        revertBtn.setAttribute('role', 'button');
        revertBtn.setAttribute('tabindex', '0');

        // Stage span — stopPropagation prevents CM from treating it as a revert click
        const stageBtn = document.createElement('span');
        stageBtn.className = 'cm-stage-btn';
        stageBtn.textContent = '+';
        stageBtn.title = 'Hunk stagen';
        stageBtn.setAttribute('role', 'button');
        stageBtn.setAttribute('tabindex', '0');
        stageBtn.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const chunkIdx = parseInt(wrapper.dataset.chunk ?? '-1');
          const mv2 = mergeRef.current;
          if (chunkIdx < 0 || !mv2) return;
          const chunk = mv2.chunks[chunkIdx];
          if (!chunk) return;
          // Pass the A-side (HEAD) line range to main — it generates the patch via git diff
          const aDoc = mv2.a.state.doc;
          const fromLine = aDoc.lineAt(chunk.fromA).number;
          const toLine   = chunk.fromA < chunk.toA
            ? aDoc.lineAt(Math.min(chunk.toA - 1, aDoc.length > 0 ? aDoc.length - 1 : 0)).number
            : fromLine;
          window.vaultApp.stageHunk(stableRelPath, fromLine, toLine).catch(console.error);
        });

        wrapper.appendChild(revertBtn);
        wrapper.appendChild(stageBtn);
        return wrapper;
      },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { minSize: 4, margin: 1 },
    });

    mergeRef.current = mv;

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      mv.destroy();
      mergeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headContent, currentContent, readOnly, theme, fontFamily, fontSize, lineHeight]);

  return (
    <div className="diff-viewer">
      {/* Header */}
      <div className="diff-header">
        <div className="diff-labels">
          <span className="diff-label diff-label--a">HEAD</span>
          <span className="diff-filename">{name}</span>
          <span className="diff-label diff-label--b">{readOnly ? 'Index' : 'Arbeitskopie'}</span>
        </div>
        <button className="diff-close-btn" title="Diff schließen" onClick={onClose}>✕</button>
      </div>

      {headContent === null && (
        <div className="diff-notice">Neue Datei — kein HEAD-Stand vorhanden</div>
      )}

      <div ref={containerRef} className="diff-container" />
    </div>
  );
}
