import { useEffect, useRef, useCallback } from 'react';
import { EditorView, keymap, highlightActiveLine, drawSelection, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment, Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, search } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { vim, Vim } from '@replit/codemirror-vim';
import { livePreviewPlugin, livePreviewBlockField, livePreviewConfig } from './livePreview';
import { wikilinkAutocomplete, autocompleteConfig } from './linkAutocomplete';
import type { NoteDocument, VimKeybinding } from '../../../shared/ipc';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MarkdownEditorProps {
  doc: NoteDocument;
  editorMode: 'live-preview' | 'source';
  vimMode: boolean;
  vimKeybindings: VimKeybinding[];
  vimLeader: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  allPaths: string[];
  pendingAnchor: string | null;
  initialCursor?: number;
  onSave: (raw: string) => void;
  onChange: (raw: string) => void;
  onLinkClick: (target: string, external: boolean) => void;
  onHeadingsChange: (headings: NoteDocument['headings']) => void;
  onCursorChange?: (pos: number) => void;
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

// Expand <leader> in a key sequence to the actual leader character using Vim notation.
function expandLeader(lhs: string, leader: string): string {
  if (!lhs.includes('<leader>') && !lhs.includes('<Leader>')) return lhs;
  // Convert the leader character to a Vim key name if needed
  const leaderKey = leader === ' ' ? '<Space>' : leader === '\t' ? '<Tab>' : leader;
  return lhs.replace(/<[Ll]eader>/g, leaderKey);
}

// Track the *expanded* LHS so we can unmap correctly when leader changes.
let appliedVimBindings: Array<VimKeybinding & { expandedLhs: string }> = [];
// Track whether we removed the default <Space>→l binding (for space-as-leader).
let spaceDefaultRemoved = false;

function applyVimBindings(bindings: VimKeybinding[], leader: string): void {
  // Unmap previously applied bindings using the expanded LHS that was registered
  for (const { expandedLhs, mode } of appliedVimBindings) {
    try { Vim.unmap(expandedLhs, mode); } catch { /* ignore */ }
  }
  appliedVimBindings = [];

  if (leader === ' ' && !spaceDefaultRemoved) {
    // codemirror-vim's matchCommand picks a FULL match over partial matches.
    // The default { keys: '<Space>', toKeys: 'l' } is a full match that fires
    // immediately, preventing any '<Space>X' partial match from ever firing.
    // Remove it so that pressing space can start a multi-key leader sequence.
    try {
      // The default mapping has no context (undefined), so pass undefined.
      (Vim.unmap as (lhs: string, ctx: string | undefined) => void)('<Space>', undefined);
      spaceDefaultRemoved = true;
    } catch { /* ignore */ }
  } else if (leader !== ' ' && spaceDefaultRemoved) {
    // Restore default space→l behaviour for normal and visual mode.
    try { Vim.map('<Space>', 'l', 'normal'); } catch { /* ignore */ }
    try { Vim.map('<Space>', 'l', 'visual'); } catch { /* ignore */ }
    spaceDefaultRemoved = false;
  }

  for (const { lhs, rhs, mode } of bindings) {
    const expandedLhs = expandLeader(lhs, leader);
    try {
      Vim.map(expandedLhs, rhs, mode);
      appliedVimBindings.push({ lhs, rhs, mode, expandedLhs });
    } catch (e) {
      console.warn(`[vim] Failed to map ${expandedLhs} → ${rhs} (${mode}):`, e);
    }
  }
}

// ─── Follow link under cursor (used by gd) ───────────────────────────────────

function followLinkAtCursor(view: EditorView): void {
  const pos  = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const col  = pos - line.from;
  const text = line.text;

  // Wikilinks: [[Note]], [[Note|Alias]], [[Note#anchor]]
  const wikilinkRe = /\[\[([^\]\r\n]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikilinkRe.exec(text)) !== null) {
    if (col >= m.index && col <= m.index + m[0].length) {
      const inner    = m[1];
      const pipeIdx  = inner.indexOf('|');
      const hashIdx  = inner.indexOf('#');
      let target: string;
      let anchor: string | undefined;
      if (pipeIdx !== -1) {
        target = inner.slice(0, pipeIdx).split('#')[0].trim();
      } else if (hashIdx !== -1) {
        target = inner.slice(0, hashIdx).trim();
        anchor = inner.slice(hashIdx + 1).trim();
      } else {
        target = inner.trim();
      }
      const fullTarget = anchor ? `${target}#${anchor}` : target;
      view.dom.dispatchEvent(new CustomEvent('obsidian:link-click', {
        bubbles: true,
        detail: { target: fullTarget, external: false },
      }));
      return;
    }
  }

  // Markdown links: [text](url)
  const mdLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = mdLinkRe.exec(text)) !== null) {
    if (col >= m.index && col <= m.index + m[0].length) {
      const href  = m[2];
      const isExt = /^https?:\/\//.test(href);
      view.dom.dispatchEvent(new CustomEvent('obsidian:link-click', {
        bubbles: true,
        detail: { target: isExt ? href : href.replace(/\.md$/, ''), external: isExt },
      }));
      return;
    }
  }
}

// ─── App-level Vim ex-commands (registered once; Vim is a global singleton) ──

let appVimCommandsRegistered = false;

function registerAppVimCommands(): void {
  if (appVimCommandsRegistered) return;
  appVimCommandsRegistered = true;

  Vim.defineEx('tabnext', 'tabn', () => {
    window.dispatchEvent(new CustomEvent('obsidian:tab-next'));
  });
  Vim.defineEx('tabprev', 'tabp', () => {
    window.dispatchEvent(new CustomEvent('obsidian:tab-prev'));
  });
  Vim.defineEx('tabclose', 'tabc', () => {
    window.dispatchEvent(new CustomEvent('obsidian:tab-close'));
  });
  Vim.defineEx('followlink', '', (cm: { cm6: EditorView }) => {
    followLinkAtCursor(cm.cm6);
  });
  Vim.defineEx('jumpback', 'ju', () => {
    window.dispatchEvent(new CustomEvent('obsidian:jump-back'));
  });
  Vim.defineEx('quickopen', 'qu', () => {
    window.dispatchEvent(new CustomEvent('obsidian:quick-open'));
  });
  Vim.defineEx('sidebar', 'si', () => {
    window.dispatchEvent(new CustomEvent('obsidian:toggle-sidebar'));
  });
  Vim.defineEx('outline', 'ou', () => {
    window.dispatchEvent(new CustomEvent('obsidian:toggle-outline'));
  });

  // Default normal-mode mappings (can be overridden via vimKeybindings settings)
  Vim.map('gt', ':tabnext<CR>', 'normal');
  Vim.map('gT', ':tabprev<CR>', 'normal');
}

// ─── Relative line numbers ────────────────────────────────────────────────────

class RelLineNumberMarker extends GutterMarker {
  constructor(readonly label: string, readonly isCurrent: boolean) { super(); }
  get elementClass() { return this.isCurrent ? 'cm-rln-current' : ''; }
  toDOM() { return document.createTextNode(this.label); }
  eq(other: RelLineNumberMarker) {
    return this.label === other.label && this.isCurrent === other.isCurrent;
  }
}

const relativeLineNumbers = gutter({
  class: 'cm-lineNumbers',
  lineMarker(view, line) {
    const lineNo     = view.state.doc.lineAt(line.from).number;
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
    const isCurrent  = lineNo === cursorLine;
    const label      = isCurrent ? String(lineNo) : String(Math.abs(lineNo - cursorLine));
    return new RelLineNumberMarker(label, isCurrent);
  },
  lineMarkerChange: (update) => update.selectionSet || update.docChanged,
  renderEmptyElements: false,
});

// ─── Static base extensions ───────────────────────────────────────────────────

const BASE_EXTENSIONS: Extension[] = [
  history(),
  search({ top: false }),
  highlightActiveLine(),
  drawSelection(),
  relativeLineNumbers,
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
  vimLeader,
  fontFamily,
  fontSize,
  lineHeight,
  allPaths,
  pendingAnchor,
  initialCursor,
  onSave,
  onChange,
  onLinkClick,
  onHeadingsChange: _onHeadingsChange,
  onCursorChange,
}: MarkdownEditorProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const viewRef       = useRef<EditorView | null>(null);
  const pathRef       = useRef(doc.path);
  const onSaveRef     = useRef(onSave);
  const onChangeRef   = useRef(onChange);
  const onLinkClickRef = useRef(onLinkClick);
  const onCursorChangeRef = useRef(onCursorChange);

  // Keep refs current
  useEffect(() => { onSaveRef.current = onSave; });
  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => { onLinkClickRef.current = onLinkClick; });
  useEffect(() => { onCursorChangeRef.current = onCursorChange; });

  // ── Create editor on mount ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) {
        const raw = update.state.doc.toString();
        onChangeRef.current(raw);
      }
      if (update.selectionSet) {
        onCursorChangeRef.current?.(update.state.selection.main.head);
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
            ? [livePreviewPlugin, livePreviewBlockField, livePreviewConfig.of({ allPaths, notePath: doc.path })]
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
    view.focus();

    if (initialCursor) {
      const pos = Math.min(initialCursor, state.doc.length);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    }

    // Apply vim keybindings and register app ex-commands
    if (vimMode) {
      registerAppVimCommands();
      applyVimBindings(vimKeybindings, vimLeader ?? '\\');
    }

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
    if (vimMode) {
      registerAppVimCommands();
      applyVimBindings(vimKeybindings, vimLeader ?? '\\');
    } else {
      applyVimBindings([], vimLeader ?? '\\');
    }
  }, [vimMode, vimKeybindings, vimLeader]);

  // ── Reconfigure: live-preview / source mode ────────────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartment.reconfigure(
        editorMode === 'live-preview'
          ? [livePreviewPlugin, livePreviewBlockField, livePreviewConfig.of({ allPaths, notePath: doc.path })]
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
