import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useState, useMemo } from 'react';
import { EditorView, keymap, highlightActiveLine, drawSelection, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment, Extension, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, search } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { vim, Vim } from '@replit/codemirror-vim';
import { livePreviewPlugin, livePreviewBlockField, livePreviewConfig } from './livePreview';
import { wikilinkAutocomplete, autocompleteConfig } from './linkAutocomplete';
import { gitGutterExtension, setGitHunks, computeHunks, type GitHunk } from './gitGutter';
import type { NoteDocument, VimKeybinding } from '../../../shared/ipc';
import { extractHeadings } from '../../../shared/linking';
import SlashCommandMenu from './SlashCommandMenu';
import { filterCommands } from './slashCommands';
import type { SlashCommand } from './slashCommands';

// ─── Handle (for parent to call focus()) ─────────────────────────────────────

export interface MarkdownEditorHandle {
  focus(): void;
}

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
  linkFormat: 'wikilink' | 'markdown';
  vaultPath: string;
  allPaths: string[];
  pendingAnchor: string | null;
  initialCursor?: number;
  onSave: (raw: string) => void;
  onChange: (raw: string) => void;
  onLinkClick: (target: string, external: boolean) => void;
  onHeadingsChange: (headings: NoteDocument['headings']) => void;
  onCursorChange?: (pos: number) => void;
  onSelectionChange?: (text: string) => void;
  onPasteAttachment: (data: string, mimeType: string, filename: string) => Promise<string>;
  headContent?: string | null;
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

const vimCompartment          = new Compartment();
const livePreviewCompartment  = new Compartment();
const autocompleteCompartment = new Compartment();
const fontCompartment         = new Compartment();

// Font theme — reconfiguring via dispatch() makes CM6 remeasure line heights.
// Setting fonts via CSS inheritance on an outer element does NOT trigger CM6's
// internal remeasure, which causes stale cursor/line positions after zoom.
function makeFontTheme(fontFamily: string, fontSize: number, lineHeight: number): Extension {
  return EditorView.theme({
    '.cm-content': {
      fontFamily,
      fontSize: `${fontSize}px`,
      lineHeight: String(lineHeight),
    },
  });
}

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
  elementClass: string;
  constructor(readonly label: string, readonly isCurrent: boolean) {
    super();
    this.elementClass = isCurrent ? 'cm-rln-current' : '';
  }
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

// ─── List continuation (Prec.highest so it runs before markdownKeymap) ───────

const listContinuationKeymap = Prec.highest(keymap.of([{
  key: 'Enter',
  run(view) {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const line = view.state.doc.lineAt(sel.from);
    const text = line.text;

    // Frontmatter: Enter on first line "---" → insert closing --- and place cursor inside
    if (line.number === 1 && text === '---') {
      view.dispatch({
        changes: { from: sel.from, insert: '\n\n---' },
        selection: { anchor: sel.from + 1 },
      });
      return true;
    }

    // Task list: - [ ] text  (check before bullet so "- [ ]" isn't treated as bullet)
    const taskM = text.match(/^(\s*)([-*+])(\s+)\[([ xX])\]\s*/);
    if (taskM) {
      const prefix = taskM[1] + taskM[2] + taskM[3]; // e.g. "- "
      const contentStart = line.from + prefix.length + 4; // after "[ ] "
      if (sel.from <= contentStart) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: '' },
          selection: { anchor: line.from } });
      } else {
        const cont = prefix + '[ ] ';
        view.dispatch({ changes: { from: sel.from, insert: '\n' + cont },
          selection: { anchor: sel.from + 1 + cont.length } });
      }
      return true;
    }

    // Unordered bullet: - item  * item  + item
    const bulletM = text.match(/^(\s*)([-*+]) /);
    if (bulletM) {
      const prefix = bulletM[1] + bulletM[2] + ' ';
      const contentStart = line.from + prefix.length;
      if (sel.from <= contentStart) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: '' },
          selection: { anchor: line.from } });
      } else {
        view.dispatch({ changes: { from: sel.from, insert: '\n' + prefix },
          selection: { anchor: sel.from + 1 + prefix.length } });
      }
      return true;
    }

    // Ordered list: 1. item
    const numberedM = text.match(/^(\s*)(\d+)\. /);
    if (numberedM) {
      const prefix = numberedM[1] + (parseInt(numberedM[2]) + 1) + '. ';
      const contentStart = line.from + numberedM[0].length;
      if (sel.from <= contentStart) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: '' },
          selection: { anchor: line.from } });
      } else {
        view.dispatch({ changes: { from: sel.from, insert: '\n' + prefix },
          selection: { anchor: sel.from + 1 + prefix.length } });
      }
      return true;
    }

    return false;
  },
}]));

// ─── Static base extensions ───────────────────────────────────────────────────

const BASE_EXTENSIONS: Extension[] = [
  listContinuationKeymap,
  history(),
  search({ top: false }),
  highlightActiveLine(),
  drawSelection(),
  gitGutterExtension(),
  relativeLineNumbers,
  EditorView.lineWrapping,
  markdown({ base: markdownLanguage }),
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  editorTheme,
];

// ─── Component ────────────────────────────────────────────────────────────────

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  doc,
  editorMode,
  vimMode,
  vimKeybindings,
  vimLeader,
  fontFamily,
  fontSize,
  lineHeight,
  linkFormat,
  vaultPath,
  allPaths,
  pendingAnchor,
  initialCursor,
  onSave,
  onChange,
  onLinkClick,
  onHeadingsChange,
  onCursorChange,
  onSelectionChange,
  onPasteAttachment,
  headContent,
}: MarkdownEditorProps, ref) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const viewRef       = useRef<EditorView | null>(null);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
  }));
  const pathRef                  = useRef(doc.path);
  const onSaveRef                = useRef(onSave);
  const onChangeRef              = useRef(onChange);
  const onLinkClickRef           = useRef(onLinkClick);
  const onCursorChangeRef        = useRef(onCursorChange);
  const onSelectionChangeRef     = useRef(onSelectionChange);
  const onHeadingsChangeRef      = useRef(onHeadingsChange);
  const onPasteAttachmentRef     = useRef(onPasteAttachment);
  const linkFormatRef            = useRef(linkFormat);
  const headContentRef           = useRef(headContent);
  const diffTimerRef             = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hunk popup state
  const [hunkPopup, setHunkPopup] = useState<{ x: number; y: number; hunk: GitHunk } | null>(null);

  // Keep refs current
  useEffect(() => { onSaveRef.current = onSave; });
  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => { onLinkClickRef.current = onLinkClick; });
  useEffect(() => { onCursorChangeRef.current = onCursorChange; });
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; });
  useEffect(() => { onHeadingsChangeRef.current = onHeadingsChange; });
  useEffect(() => { onPasteAttachmentRef.current = onPasteAttachment; });
  useEffect(() => { linkFormatRef.current = linkFormat; }, [linkFormat]);
  useEffect(() => { headContentRef.current = headContent; }, [headContent]);

  // ── Slash command menu state ───────────────────────────────────────────────
  const [slashMenu, setSlashMenu] = useState<{ x: number; y: number; from: number; query: string } | null>(null);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const filteredCmds = useMemo(
    () => (slashMenu ? filterCommands(slashMenu.query) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slashMenu?.query],
  );
  useEffect(() => { setSlashSelectedIdx(0); }, [filteredCmds]);

  // ── Create editor on mount ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) {
        const raw = update.state.doc.toString();
        onChangeRef.current(raw);
        onHeadingsChangeRef.current(extractHeadings(raw));

        // Debounced git diff recomputation
        if (diffTimerRef.current) clearTimeout(diffTimerRef.current);
        diffTimerRef.current = setTimeout(() => {
          const hc = headContentRef.current;
          if (hc === undefined) return;
          const hunks = computeHunks(hc, update.view.state.doc.toString());
          update.view.dispatch({ effects: setGitHunks.of(hunks) });
        }, 250);
      }
      if (update.selectionSet) {
        onCursorChangeRef.current?.(update.state.selection.main.head);
        const sel = update.state.selection.main;
        if (!sel.empty) {
          onSelectionChangeRef.current?.(update.state.sliceDoc(sel.from, sel.to));
        } else {
          onSelectionChangeRef.current?.('');
        }
      }
      // ── Slash command menu detection ──────────────────────────────────────
      if (update.docChanged || update.selectionSet) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        const textBefore = line.text.slice(0, head - line.from);
        const m = /\/([^\n ]*)$/.exec(textBefore);
        if (m !== null) {
          const slashPos = head - m[0].length;
          const coords = update.view.coordsAtPos(slashPos);
          if (coords) {
            setSlashMenu(prev => {
              const next = { x: coords.left, y: coords.bottom, from: slashPos, query: m[1] };
              if (prev && prev.from === next.from && prev.query === next.query) return prev;
              return next;
            });
          }
        } else {
          setSlashMenu(prev => prev !== null ? null : prev);
        }
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
            ? [livePreviewPlugin, livePreviewBlockField, livePreviewConfig.of({ allPaths, notePath: doc.path, vaultPath })]
            : [],
        ),
        autocompleteCompartment.of([
          wikilinkAutocomplete(),
          autocompleteConfig.of({ allPaths, notePath: doc.path }),
        ]),
        fontCompartment.of(makeFontTheme(fontFamily, fontSize, lineHeight)),
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
          ? [livePreviewPlugin, livePreviewBlockField, livePreviewConfig.of({ allPaths, notePath: doc.path, vaultPath })]
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

  // ── Reconfigure font (dispatch triggers CM6's internal remeasure) ──────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: fontCompartment.reconfigure(makeFontTheme(fontFamily, fontSize, lineHeight)) });
  }, [fontFamily, fontSize, lineHeight]);

  // ── Recompute git hunks when headContent changes ───────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const hunks = computeHunks(headContent ?? null, view.state.doc.toString());
    view.dispatch({ effects: setGitHunks.of(hunks) });
  }, [headContent]);

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

  // ── Slash command: execute ─────────────────────────────────────────────────
  const executeSlashCommand = useCallback((cmd: SlashCommand) => {
    const view = viewRef.current;
    if (!view || !slashMenu) return;
    const to = view.state.selection.main.head;
    view.dispatch({
      changes: { from: slashMenu.from, to, insert: cmd.insert },
      selection: { anchor: slashMenu.from + cmd.cursorOffset },
    });
    setSlashMenu(null);
    view.focus();
  }, [slashMenu]);

  // ── Slash command: keyboard navigation (capture phase beats CM6) ───────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !slashMenu) return;
    const cmds = filteredCmds;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSlashMenu(null);
      } else if (e.key === 'ArrowDown') {
        setSlashSelectedIdx(i => Math.min(i + 1, cmds.length - 1));
      } else if (e.key === 'ArrowUp') {
        setSlashSelectedIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const cmd = cmds[slashSelectedIdx];
        if (cmd) executeSlashCommand(cmd);
      } else {
        return; // don't swallow other keys
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    el.addEventListener('keydown', handler, true); // capture before CM6
    return () => el.removeEventListener('keydown', handler, true);
  }, [slashMenu, filteredCmds, slashSelectedIdx, executeSlashCommand]);

  // ── Git hunk click → revert popup ─────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const { x, y, hunk } = (e as CustomEvent<{ x: number; y: number; hunk: GitHunk }>).detail;
      setHunkPopup(prev => (prev?.hunk === hunk ? null : { x, y, hunk }));
    };
    el.addEventListener('git:hunk-click', handler);
    return () => el.removeEventListener('git:hunk-click', handler);
  }, []);

  // Close popup when clicking outside
  useEffect(() => {
    if (!hunkPopup) return;
    const handler = () => setHunkPopup(null);
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [hunkPopup]);

  const revertHunk = useCallback((hunk: GitHunk) => {
    const view = viewRef.current;
    if (!view) return;
    const state = view.state;

    if (hunk.type === 'added') {
      const fromLine = state.doc.line(hunk.currentFrom);
      const toLine   = state.doc.line(Math.min(hunk.currentTo, state.doc.lines));
      // Include the newline after the last added line, if present
      const to = toLine.to < state.doc.length ? toLine.to + 1 : toLine.to;
      view.dispatch({ changes: { from: fromLine.from, to, insert: '' } });
    } else if (hunk.type === 'modified') {
      const fromLine = state.doc.line(hunk.currentFrom);
      const toLine   = state.doc.line(Math.min(hunk.currentTo, state.doc.lines));
      const insert   = hunk.headContent.endsWith('\n') ? hunk.headContent.slice(0, -1) : hunk.headContent;
      view.dispatch({ changes: { from: fromLine.from, to: toLine.to, insert } });
    } else if (hunk.type === 'deleted') {
      const insertAt = hunk.currentFrom <= state.doc.lines
        ? state.doc.line(hunk.currentFrom).from
        : state.doc.length;
      view.dispatch({ changes: { from: insertAt, insert: hunk.headContent } });
    }

    setHunkPopup(null);
    const raw = view.state.doc.toString();
    onChangeRef.current(raw);
    onSaveRef.current(raw);
  }, []);

  // ── Clipboard paste: images & files ───────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ALLOWED_TYPES: Record<string, { prefix: string; ext: string }> = {
      'image/png':               { prefix: 'Pasted image', ext: 'png' },
      'image/jpeg':              { prefix: 'Pasted image', ext: 'jpg' },
      'image/gif':               { prefix: 'Pasted image', ext: 'gif' },
      'image/webp':              { prefix: 'Pasted image', ext: 'webp' },
      'image/svg+xml':           { prefix: 'Pasted image', ext: 'svg' },
      'application/pdf':         { prefix: 'Pasted file',  ext: 'pdf' },
    };

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        const info = ALLOWED_TYPES[item.type];
        if (!info) continue;

        const file = item.getAsFile();
        if (!file) continue;

        e.preventDefault();

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const filename = `${info.prefix} ${dateStr}.${info.ext}`;

        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',')[1];
          if (!base64) return;

          try {
            const relPath = await onPasteAttachmentRef.current(base64, item.type, filename);
            const view = viewRef.current;
            if (!view) return;
            const pos = view.state.selection.main.head;
            const isImage = item.type.startsWith('image/');
            const insert = linkFormatRef.current === 'wikilink'
              ? (isImage ? `![[${relPath}]]` : `[[${relPath}]]`)
              : (isImage ? `![${filename}](${relPath})` : `[${filename}](${relPath})`);
            view.dispatch({
              changes: { from: pos, insert },
              selection: { anchor: pos + insert.length },
            });
            onChangeRef.current(view.state.doc.toString());
          } catch (err) {
            console.error('[attachment] Einfügen fehlgeschlagen:', err);
          }
        };
        reader.readAsDataURL(file);
        return; // handle only first item
      }
    };

    el.addEventListener('paste', handlePaste);
    return () => el.removeEventListener('paste', handlePaste);
  }, []);

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
    <>
      <div ref={containerRef} className="editor-wrap" />

      {slashMenu && filteredCmds.length > 0 && (
        <SlashCommandMenu
          x={slashMenu.x}
          y={slashMenu.y}
          commands={filteredCmds}
          selectedIdx={slashSelectedIdx}
          onSelect={executeSlashCommand}
        />
      )}

      {hunkPopup && (
        <div
          className="git-hunk-popup"
          style={{ left: hunkPopup.x + 8, top: hunkPopup.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="git-hunk-popup-type">
            {hunkPopup.hunk.type === 'added'    && 'Hinzugefügt'}
            {hunkPopup.hunk.type === 'modified' && 'Geändert'}
            {hunkPopup.hunk.type === 'deleted'  && 'Gelöscht'}
          </div>
          {hunkPopup.hunk.headContent && (
            <pre className="git-hunk-popup-diff">{hunkPopup.hunk.headContent}</pre>
          )}
          <button
            className="btn btn-danger git-hunk-popup-btn"
            onClick={() => revertHunk(hunkPopup.hunk)}
          >
            Zurücksetzen
          </button>
        </div>
      )}
    </>
  );
});

export default MarkdownEditor;
