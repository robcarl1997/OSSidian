import { useEffect, useRef, useCallback } from 'react';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment, Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, search } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { vim, Vim } from '@replit/codemirror-vim';
import { livePreviewPlugin, livePreviewConfig } from './livePreview';
import { wikilinkAutocomplete, autocompleteConfig } from './linkAutocomplete';
import type { NoteDocument, VimKeybinding } from '../../../shared/ipc';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MarkdownEditorProps {
  doc: NoteDocument;
  editorMode: 'live-preview' | 'source';
  vimMode: boolean;
  vimKeybindings: VimKeybinding[];
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  allPaths: string[];
  pendingAnchor: string | null;
  onSave: (raw: string) => void;
  onChange: (raw: string) => void;
  onLinkClick: (target: string, external: boolean) => void;
  onHeadingsChange: (headings: NoteDocument['headings']) => void;
}

// ─── Theme ───────────────────────────────────────────────────────────────────

const editorTheme = EditorView.theme({
  '&': { height: '100%', background: 'transparent' },
  '.cm-scroller': { overflow: 'auto', padding: '32px 10%', flex: '1' },
  '.cm-content': { maxWidth: '760px', margin: '0 auto', padding: '0 0 200px' },
  '.cm-line': { padding: '0', lineHeight: 'inherit', fontFamily: 'inherit', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
});

// ─── Compartments (for dynamic reconfiguration) ───────────────────────────────

const vimCompartment       = new Compartment();
const livePreviewCompartment = new Compartment();
const autocompleteCompartment = new Compartment();

// ─── Vim keybinding helpers ───────────────────────────────────────────────────

let appliedVimBindings: VimKeybinding[] = [];

function applyVimBindings(bindings: VimKeybinding[]): void {
  // Remove previously applied bindings
  for (const { lhs, mode } of appliedVimBindings) {
    try { Vim.unmap(lhs, mode); } catch { /* ignore */ }
  }
  appliedVimBindings = [...bindings];
  for (const { lhs, rhs, mode } of bindings) {
    try { Vim.map(lhs, rhs, mode); } catch (e) {
      console.warn(`[vim] Failed to map ${lhs} → ${rhs} (${mode}):`, e);
    }
  }
}

// ─── Static base extensions ───────────────────────────────────────────────────

const BASE_EXTENSIONS: Extension[] = [
  history(),
  search({ top: false }),
  highlightActiveLine(),
  EditorView.lineWrapping,
  markdown({ base: markdownLanguage }),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  editorTheme,
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function MarkdownEditor({
  doc,
  editorMode,
  vimMode,
  vimKeybindings,
  fontFamily,
  fontSize,
  lineHeight,
  allPaths,
  pendingAnchor,
  onSave,
  onChange,
  onLinkClick,
  onHeadingsChange: _onHeadingsChange,
}: MarkdownEditorProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const viewRef       = useRef<EditorView | null>(null);
  const pathRef       = useRef(doc.path);
  const onSaveRef     = useRef(onSave);
  const onChangeRef   = useRef(onChange);
  const onLinkClickRef = useRef(onLinkClick);

  // Keep refs current
  useEffect(() => { onSaveRef.current = onSave; });
  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => { onLinkClickRef.current = onLinkClick; });

  // ── Create editor on mount ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) {
        const raw = update.state.doc.toString();
        onChangeRef.current(raw);
      }
    });

    const saveKeymap = keymap.of([{
      key: 'Ctrl-s',
      mac: 'Cmd-s',
      run: (view) => {
        onSaveRef.current(view.state.doc.toString());
        return true;
      },
    }]);

    const state = EditorState.create({
      doc: doc.raw,
      extensions: [
        ...BASE_EXTENSIONS,
        saveKeymap,
        updateListener,
        vimCompartment.of(vimMode ? vim() : []),
        livePreviewCompartment.of(
          editorMode === 'live-preview'
            ? [livePreviewPlugin, livePreviewConfig.of({ allPaths, notePath: doc.path })]
            : [],
        ),
        autocompleteCompartment.of([
          wikilinkAutocomplete(),
          autocompleteConfig.of({ allPaths, notePath: doc.path }),
        ]),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    pathRef.current = doc.path;

    // Apply vim keybindings
    if (vimMode) applyVimBindings(vimKeybindings);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // only on mount

  // ── Swap document when the note path changes ───────────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (doc.path !== pathRef.current || view.state.doc.toString() !== doc.raw) {
      pathRef.current = doc.path;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc.raw },
        selection: { anchor: 0 },
      });
    }
  }, [doc.path, doc.raw]);

  // ── Reconfigure: vim mode ──────────────────────────────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: vimCompartment.reconfigure(vimMode ? vim() : []) });
    if (vimMode) applyVimBindings(vimKeybindings);
    else applyVimBindings([]);
  }, [vimMode, vimKeybindings]);

  // ── Reconfigure: live-preview / source mode ────────────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartment.reconfigure(
        editorMode === 'live-preview'
          ? [livePreviewPlugin, livePreviewConfig.of({ allPaths, notePath: doc.path })]
          : [],
      ),
    });
  }, [editorMode, allPaths, doc.path]);

  // ── Reconfigure: autocomplete config when allPaths changes ────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: autocompleteCompartment.reconfigure([
        wikilinkAutocomplete(),
        autocompleteConfig.of({ allPaths, notePath: doc.path }),
      ]),
    });
  }, [allPaths, doc.path]);

  // ── Navigate to anchor ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!pendingAnchor || !viewRef.current) return;
    const view = viewRef.current;
    const content = view.state.doc.toString();
    const lines = content.split('\n');
    const slug = pendingAnchor.toLowerCase().replace(/\s+/g, '-');

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
      if (m) {
        const headingSlug = m[2].trim().toLowerCase()
          .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
        if (headingSlug === slug) {
          const lineStart = view.state.doc.line(i + 1).from;
          view.dispatch({ selection: { anchor: lineStart }, scrollIntoView: true });
          view.focus();
          break;
        }
      }
    }
  }, [pendingAnchor]);

  // ── Link click events ──────────────────────────────────────────────────────
  const handleLinkClick = useCallback((e: Event) => {
    const { target, external } = (e as CustomEvent<{ target: string; external: boolean }>).detail;
    onLinkClickRef.current(target, external);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('obsidian:link-click', handleLinkClick);
    return () => el.removeEventListener('obsidian:link-click', handleLinkClick);
  }, [handleLinkClick]);

  return (
    <div
      ref={containerRef}
      className="editor-wrap"
      style={{
        fontFamily,
        fontSize: `${fontSize}px`,
        lineHeight,
      }}
    />
  );
}
