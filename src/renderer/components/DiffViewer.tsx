import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Theme } from '../../../shared/ipc';

const SAVE_DEBOUNCE_MS = 600;

// ─── Theme definitions ────────────────────────────────────────────────────────

function makeEditorTheme(theme: Theme, fontFamily: string, fontSize: number, lineHeight: number): Extension {
  const isDark = theme === 'dark';
  const bg   = theme === 'dark' ? '#1e1e2e' : theme === 'light' ? '#f8f8f8' : '#f5ede1';
  const fg   = theme === 'dark' ? '#cdd6f4' : theme === 'light' ? '#2c2c2c' : '#3d2b1f';
  const gutter = theme === 'dark' ? '#181825' : theme === 'light' ? '#efefef' : '#ede0d0';
  const gutterFg = theme === 'dark' ? '#585b70' : theme === 'light' ? '#aaaaaa' : '#a08070';
  const sel  = theme === 'dark' ? '#313244' : theme === 'light' ? '#d8d8d8' : '#ddd0bc';
  const cursor = theme === 'dark' ? '#cba6f7' : theme === 'light' ? '#7c3aed' : '#c66115';

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
    // Merge-view change highlighting — adapt to theme
    '.cm-changedLine': { background: isDark ? '#2a2d45' : theme === 'sepia' ? '#e8d9c5' : '#e8f0fe' },
    '.cm-deletedLine': { background: isDark ? '#3d1f2a' : theme === 'sepia' ? '#f0cfc0' : '#fce8e8' },
    '.cm-changedText': { background: isDark ? '#4a4070' : theme === 'sepia' ? '#d0b090' : '#c5d8ff' },
    '.cm-deletedText': { background: isDark ? '#7a2540' : theme === 'sepia' ? '#c09080' : '#f5b8b8' },
    '.cm-insertedLine': { background: isDark ? '#1e3a2a' : theme === 'sepia' ? '#d0e0c0' : '#e6f4ea' },
    '.cm-insertedText': { background: isDark ? '#2a6040' : theme === 'sepia' ? '#a0c080' : '#a8d5b5' },
  }, { dark: isDark });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface DiffViewerProps {
  path: string;
  headContent: string | null;   // null = new/untracked file
  currentContent: string;
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
  headContent,
  currentContent,
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
  useEffect(() => { onSaveRef.current = onSave; });

  const name = path.split('/').pop() ?? path;

  // ─── Create / destroy MergeView ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const baseExtensions: Extension[] = [
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      lineNumbers(),
      EditorView.lineWrapping,
      makeEditorTheme(theme, fontFamily, fontSize, lineHeight),
    ];

    // b (current) is writable so revert controls can apply changes
    const bExtensions: Extension[] = [
      ...baseExtensions,
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        const content = update.state.doc.toString();
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          window.vaultApp.saveNote(path, content);
          onSaveRef.current(content);
        }, SAVE_DEBOUNCE_MS);
      }),
    ];

    const mv = new MergeView({
      parent: containerRef.current,
      a: {
        doc: headContent ?? '',
        extensions: [...baseExtensions, EditorState.readOnly.of(true)],
      },
      b: {
        doc: currentContent,
        extensions: bExtensions,
      },
      revertControls: 'a-to-b',
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
    // Recreate when content or display settings change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headContent, currentContent, theme, fontFamily, fontSize, lineHeight]);

  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <div className="diff-labels">
          <span className="diff-label diff-label--a">HEAD</span>
          <span className="diff-filename">{name}</span>
          <span className="diff-label diff-label--b">Arbeitskopie</span>
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
