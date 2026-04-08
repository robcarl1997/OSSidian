/**
 * Live-Preview Extension for CodeMirror 6
 *
 * Renders Markdown inline – headings, bold, italic, strikethrough, inline code,
 * [[wikilinks]], and [markdown](links) – without a separate preview pane.
 * Lines containing the cursor are shown as raw Markdown so the user can edit them.
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { EditorState, Facet, RangeSetBuilder, StateField } from '@codemirror/state';

// ─── Configuration facet ──────────────────────────────────────────────────────

export interface LivePreviewConfig {
  allPaths: string[];
  notePath: string;
  vaultPath: string;
}

export const livePreviewConfig = Facet.define<LivePreviewConfig, LivePreviewConfig>({
  combine: vs => vs[0] ?? { allPaths: [], notePath: '', vaultPath: '' },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stemFromPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const file = parts[parts.length - 1] ?? '';
  return file.replace(/\.md$/i, '').toLowerCase();
}

function noteExists(target: string, allPaths: string[]): boolean {
  const needle = target.toLowerCase().trim();
  return allPaths.some(p => stemFromPath(p) === needle);
}

/** Return the set of document line-numbers that contain at least one selection endpoint. */
function activeLineNumbers(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const { from, to } of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(from).number;
    const endLine   = view.state.doc.lineAt(to).number;
    for (let l = startLine; l <= endLine; l++) lines.add(l);
  }
  return lines;
}

// ─── Block decorations (StateField — required for block: true) ────────────────

function buildBlockDecorations(state: EditorState): DecorationSet {
  const cursorLineNo = state.doc.lineAt(state.selection.main.head).number;
  const items: { from: number; to: number; value: Decoration }[] = [];

  let pos = 0;
  while (pos <= state.doc.length) {
    const line = state.doc.lineAt(pos);

    // ── Fenced code block: ``` or ~~~
    // Uses per-line Decoration.line (no block:true) so cursor can navigate into
    // fence lines and trigger un-render without atomic-range skip issues.
    const fenceM = line.text.match(/^(`{3,}|~{3,})(\S*)/);
    if (fenceM) {
      const fence     = fenceM[1] ?? '```';
      const lang      = fenceM[2] ?? '';
      const startNo   = line.number;
      let   endNo     = -1;
      let   searchPos = line.to + 1;

      while (searchPos <= state.doc.length) {
        const inner = state.doc.lineAt(searchPos);
        if (inner.text.startsWith(fence)) { endNo = inner.number; break; }
        searchPos = inner.to + 1;
      }

      if (endNo !== -1) {
        const hasCursor = cursorLineNo >= startNo && cursorLineNo <= endNo;
        if (!hasCursor) {
          // Hide opening fence
          items.push({ from: line.from, to: line.from,
            value: Decoration.line({ class: 'cm-fence-line' }) });
          // Style each code content line
          for (let n = startNo + 1; n < endNo; n++) {
            const cl      = state.doc.line(n);
            const isFirst = n === startNo + 1;
            const isLast  = n === endNo - 1;
            const cls = ['cm-code-preview',
              isFirst ? 'cm-code-preview-first' : '',
              isLast  ? 'cm-code-preview-last'  : '',
            ].filter(Boolean).join(' ');
            const deco = (lang && isFirst)
              ? Decoration.line({ class: cls, attributes: { 'data-lang': lang } })
              : Decoration.line({ class: cls });
            items.push({ from: cl.from, to: cl.from, value: deco });
          }
          // Hide closing fence
          const closeLine = state.doc.line(endNo);
          items.push({ from: closeLine.from, to: closeLine.from,
            value: Decoration.line({ class: 'cm-fence-line' }) });
        }
        pos = state.doc.line(endNo).to + 1;
        continue;
      }
    }

    // ── Horizontal rule: ---, ***, or ___ (3+, optional spaces between)
    if (/^(\s*)([-*_])(\s*\2){2,}\s*$/.test(line.text)) {
      const hasCursor = cursorLineNo === line.number;
      if (!hasCursor) {
        items.push({ from: line.from, to: line.from,
          value: Decoration.line({ class: 'cm-hr-line' }) });
      }
      pos = line.to + 1;
      continue;
    }

    // ── Markdown table: consecutive lines matching /^\|.*\|/
    // Keeps block widget but uses cursorLineNo <= tableEndNo + 1 to handle
    // column-preserving ArrowDown that jumps to the line after the table.
    if (/^\|.*\|/.test(line.text)) {
      const tableStartNo = line.number;
      const tableLines   = [line.text];
      let   searchPos    = line.to + 1;

      while (searchPos <= state.doc.length) {
        const inner = state.doc.lineAt(searchPos);
        if (!/^\|.*\|/.test(inner.text)) break;
        tableLines.push(inner.text);
        searchPos = inner.to + 1;
      }
      const tableEndNo = tableStartNo + tableLines.length - 1;

      if (tableLines.length >= 2) {
        const hasCursor = cursorLineNo >= tableStartNo && cursorLineNo <= tableEndNo + 1;
        if (!hasCursor) {
          const rows: string[][] = [];
          for (const tl of tableLines) {
            const cells = tl.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            if (!cells.every(c => /^[-: ]+$/.test(c))) rows.push(cells);
          }
          if (rows.length >= 1) {
            items.push({
              from:  line.from,
              to:    state.doc.line(tableEndNo).to,
              value: Decoration.replace({ widget: new TableWidget(rows), block: true }),
            });
            pos = state.doc.line(tableEndNo).to + 1;
            continue;
          }
        }
      }
    }

    pos = line.to + 1;
  }

  items.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let end = -1;
  for (const { from, to, value } of items) {
    if (from < end) continue;
    try { builder.add(from, to, value); end = Math.max(end, to); } catch { /* skip */ }
  }
  return builder.finish();
}

export const livePreviewBlockField = StateField.define<DecorationSet>({
  create: (state) => buildBlockDecorations(state),
  update: (value, tr) => {
    // tr.selectionSet may not be set by all Vim-mode movements; also compare
    // cursor positions directly so we never miss a cursor change.
    const cursorMoved = tr.state.selection.main.head !== tr.startState.selection.main.head;
    if (tr.docChanged || cursorMoved) return buildBlockDecorations(tr.state);
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

// ─── Widgets ──────────────────────────────────────────────────────────────────

class TableWidget extends WidgetType {
  constructor(readonly rows: string[][]) { super(); }
  eq(other: TableWidget) { return JSON.stringify(this.rows) === JSON.stringify(other.rows); }
  ignoreEvent() { return false; }
  toDOM(): HTMLElement {
    const table = document.createElement('table');
    table.className = 'cm-md-table';
    this.rows.forEach((cells, i) => {
      const tr = table.insertRow();
      cells.forEach(cell => {
        const el = document.createElement(i === 0 ? 'th' : 'td');
        el.textContent = cell;
        tr.appendChild(el);
      });
    });
    return table;
  }
}

class WikiLinkWidget extends WidgetType {
  constructor(
    readonly display: string,
    readonly target: string,
    readonly exists: boolean,
  ) { super(); }

  eq(other: WikiLinkWidget) {
    return this.display === other.display && this.target === other.target && this.exists === other.exists;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = this.exists ? 'cm-wiki-link' : 'cm-wiki-link cm-wiki-link-broken';
    span.textContent = this.display;
    span.title = this.exists ? this.target : `Notiz "${this.target}" existiert noch nicht`;
    span.addEventListener('mousedown', e => {
      e.preventDefault();
      view.dom.dispatchEvent(new CustomEvent('obsidian:link-click', {
        bubbles: true,
        detail: { target: this.target, external: false },
      }));
    });
    return span;
  }
}

class ExtLinkWidget extends WidgetType {
  constructor(readonly text: string, readonly href: string) { super(); }

  eq(other: ExtLinkWidget) {
    return this.text === other.text && this.href === other.href;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ext-link';
    span.textContent = this.text;
    span.title = this.href;
    span.addEventListener('mousedown', e => {
      e.preventDefault();
      view.dom.dispatchEvent(new CustomEvent('obsidian:link-click', {
        bubbles: true,
        detail: { target: this.href, external: true },
      }));
    });
    return span;
  }
}

class BulletWidget extends WidgetType {
  eq(_o: BulletWidget) { return true; }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-bullet-marker';
    s.textContent = '•';
    return s;
  }
  ignoreEvent() { return true; }
}

class NumberWidget extends WidgetType {
  constructor(readonly num: string) { super(); }
  eq(o: NumberWidget) { return this.num === o.num; }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-list-number';
    s.textContent = this.num + '.';
    return s;
  }
  ignoreEvent() { return true; }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }

  eq(other: CheckboxWidget) { return this.checked === other.checked; }

  toDOM(): HTMLElement {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'cm-task-checkbox';
    cb.checked = this.checked;
    cb.addEventListener('mousedown', e => e.preventDefault()); // handled by click
    return cb;
  }

  ignoreEvent(e: Event) {
    return e.type !== 'mousedown' && e.type !== 'click';
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly alt: string, readonly src: string, readonly vaultPath: string) { super(); }

  eq(other: ImageWidget) {
    return this.alt === other.alt && this.src === other.src && this.vaultPath === other.vaultPath;
  }

  toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.alt = this.alt;
    img.className = 'cm-image-widget';
    // vault:// is a custom Electron protocol that resolves vault-relative paths.
    // External images use their URL directly.
    img.src = /^https?:\/\//.test(this.src)
      ? this.src
      : `vault://${this.src}`;
    return img;
  }

  ignoreEvent() { return true; }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

function isImagePath(src: string): boolean {
  const ext = src.split('.').pop()?.toLowerCase().split('?')[0] ?? '';
  return IMAGE_EXTS.has(ext);
}

// ─── Decoration builder ───────────────────────────────────────────────────────

interface Deco { from: number; to: number; value: Decoration }

/**
 * Applies lightweight decorations to the line under the cursor:
 * - Headings keep their size/weight (the # prefix stays visible as raw text)
 * - Markdown links [text](url) get link-colour marks so the syntax is highlighted
 */
function processActiveLine(lineFrom: number, text: string, out: Deco[], config: LivePreviewConfig): void {
  // Headings: style the whole line (including # sigils) while editing
  const headingM = text.match(/^(#{1,6})\s+/);
  if (headingM) {
    const level = headingM[1].length;
    pushMark(out, lineFrom, lineFrom + text.length, `cm-h${level}`);
    return;
  }

  // Wikilinks [[note]] / [[note|alias]] / [[note#anchor]]
  const wikiRe = /!\[\[([^\]\r\n]+?)\]\]|\[\[([^\]\r\n]+?)\]\]/g;
  let wm: RegExpExecArray | null;
  while ((wm = wikiRe.exec(text)) !== null) {
    if (wm[0].startsWith('!')) continue; // skip image wikilinks
    const inner = wm[2];
    const pipeIdx = inner.indexOf('|');
    const hashIdx = inner.indexOf('#');
    let target = inner;
    if (pipeIdx !== -1)      target = inner.slice(0, pipeIdx).split('#')[0].trim();
    else if (hashIdx !== -1) target = inner.slice(0, hashIdx).trim();
    const exists = noteExists(target, config.allPaths);
    const innerStart = lineFrom + wm.index + 2;                      // skip '[['
    const innerEnd   = lineFrom + wm.index + wm[0].length - 2;       // before ']]'
    pushMark(out, innerStart, innerEnd, exists ? 'cm-wiki-link' : 'cm-wiki-link-broken');
  }

  // Markdown links [text](url): colour the syntax components
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(text)) !== null) {
    const bracketOpen  = lineFrom + lm.index;
    const bracketClose = bracketOpen + 1 + lm[1].length;
    const parenOpen    = bracketClose + 1;
    const parenClose   = parenOpen + lm[2].length;
    pushMark(out, bracketOpen + 1, bracketClose, 'cm-link-text');
    if (parenOpen < parenClose)
      pushMark(out, parenOpen, parenClose, 'cm-link-url');
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const config      = view.state.facet(livePreviewConfig);
  const activeLines = activeLineNumbers(view);
  const raw: Deco[] = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (!activeLines.has(line.number)) {
        processLine(line.from, line.text, raw, config);
      } else {
        processActiveLine(line.from, line.text, raw, config);
      }
      pos = line.to + 1;
    }
  }

  raw.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  let replaceEnd = -1;

  for (const { from, to, value } of raw) {
    const spec = value.spec as { widget?: WidgetType; replace?: boolean };
    const isReplace = spec.widget !== undefined || spec.replace === true;
    if (isReplace && from < replaceEnd) continue;
    if (from > to) continue;
    try {
      builder.add(from, to, value);
      if (isReplace) replaceEnd = to;
    } catch { /* skip */ }
  }

  return builder.finish();
}

// ─── Per-line processing ──────────────────────────────────────────────────────

function processLine(
  lineFrom: number,
  text: string,
  out: Deco[],
  config: LivePreviewConfig,
): void {
  // ── ATX Heading: # … ######
  const headingM = text.match(/^(#{1,6})\s+(.+?)\s*(?:#{1,6}\s*)?$/);
  if (headingM) {
    const level = headingM[1].length;
    const prefixLen = headingM[1].length + 1; // '# '
    const contentStart = lineFrom + prefixLen;
    const contentEnd   = lineFrom + text.length;

    // Replace the '#…' prefix
    pushReplace(out, lineFrom, lineFrom + prefixLen);
    // Style the heading content
    if (contentStart < contentEnd)
      pushMark(out, contentStart, contentEnd, `cm-h${level}`);

    return; // don't process inline patterns in headings
  }

  // ── Blockquote: > …
  if (text.match(/^>\s?/)) {
    const markEnd = lineFrom + (text.match(/^>\s?/)![0].length);
    pushReplace(out, lineFrom, markEnd);
    pushMark(out, markEnd, lineFrom + text.length, 'cm-blockquote');
    return;
  }

  // ── Task list: - [ ] / - [x]  (check before regular bullets)
  const taskM = text.match(/^(\s*)([-*+])(\s+)\[([ xX])\]/);
  if (taskM) {
    const markerStart = lineFrom + taskM[1].length;
    const markerEnd   = markerStart + taskM[2].length + taskM[3].length; // "-" + " "
    pushReplace(out, markerStart, markerEnd); // hide "- "
    const cbStart = markerEnd;
    const cbEnd   = cbStart + 3;             // "[ ]" = 3 chars
    out.push({ from: cbStart, to: cbEnd,
      value: Decoration.replace({ widget: new CheckboxWidget(taskM[4].toLowerCase() === 'x') }) });
    processInline(lineFrom, text, out, config);
    return;
  }

  // ── Unordered bullet: - item  * item  + item
  const bulletM = text.match(/^(\s*)([-*+]) /);
  if (bulletM) {
    const markerStart = lineFrom + bulletM[1].length;
    out.push({ from: markerStart, to: markerStart + 2,   // "- "
      value: Decoration.replace({ widget: new BulletWidget() }) });
    processInline(lineFrom, text, out, config);
    return;
  }

  // ── Ordered list: 1. item
  const numberedM = text.match(/^(\s*)(\d+)\. /);
  if (numberedM) {
    const markerStart = lineFrom + numberedM[1].length;
    const markerEnd   = lineFrom + numberedM[0].length;  // after "1. "
    out.push({ from: markerStart, to: markerEnd,
      value: Decoration.replace({ widget: new NumberWidget(numberedM[2]) }) });
    processInline(lineFrom, text, out, config);
    return;
  }

  // ── Inline patterns (no heading context)
  processInline(lineFrom, text, out, config);
}

// Inline patterns – ordered from most-specific to least-specific
const INLINE_PATTERNS: Array<{
  re: RegExp;
  handle: (m: RegExpExecArray, lineFrom: number, out: Deco[], config: LivePreviewConfig) => void;
}> = [
  // Bold + italic: ***text***
  {
    re: /\*{3}(.+?)\*{3}|_{3}(.+?)_{3}/g,
    handle(m, lineFrom, out) {
      const markerLen = 3;
      pushReplace(out, lineFrom + m.index, lineFrom + m.index + markerLen);
      const contentFrom = lineFrom + m.index + markerLen;
      const contentTo   = lineFrom + m.index + m[0].length - markerLen;
      if (contentFrom < contentTo) pushMark(out, contentFrom, contentTo, 'cm-strong cm-em');
      pushReplace(out, contentTo, lineFrom + m.index + m[0].length);
    },
  },
  // Bold: **text**
  {
    re: /\*{2}(.+?)\*{2}|_{2}(.+?)_{2}/g,
    handle(m, lineFrom, out) {
      const ml = 2;
      pushReplace(out, lineFrom + m.index, lineFrom + m.index + ml);
      const cf = lineFrom + m.index + ml;
      const ct = lineFrom + m.index + m[0].length - ml;
      if (cf < ct) pushMark(out, cf, ct, 'cm-strong');
      pushReplace(out, ct, lineFrom + m.index + m[0].length);
    },
  },
  // Italic: *text* or _text_ (not preceded/followed by another * or _)
  {
    re: /(?<!\*)\*(?!\*|s)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
    handle(m, lineFrom, out) {
      pushReplace(out, lineFrom + m.index, lineFrom + m.index + 1);
      const cf = lineFrom + m.index + 1;
      const ct = lineFrom + m.index + m[0].length - 1;
      if (cf < ct) pushMark(out, cf, ct, 'cm-em');
      pushReplace(out, ct, lineFrom + m.index + m[0].length);
    },
  },
  // Strikethrough: ~~text~~
  {
    re: /~~(.+?)~~/g,
    handle(m, lineFrom, out) {
      pushReplace(out, lineFrom + m.index, lineFrom + m.index + 2);
      const cf = lineFrom + m.index + 2;
      const ct = lineFrom + m.index + m[0].length - 2;
      if (cf < ct) pushMark(out, cf, ct, 'cm-strikethrough');
      pushReplace(out, ct, lineFrom + m.index + m[0].length);
    },
  },
  // Inline code: `code`
  {
    re: /`([^`]+)`/g,
    handle(m, lineFrom, out) {
      pushReplace(out, lineFrom + m.index, lineFrom + m.index + 1);
      const cf = lineFrom + m.index + 1;
      const ct = lineFrom + m.index + m[0].length - 1;
      if (cf < ct) pushMark(out, cf, ct, 'cm-inline-code');
      pushReplace(out, ct, lineFrom + m.index + m[0].length);
    },
  },
  // Image wikilinks: ![[image.png]]
  {
    re: /!\[\[([^\]\r\n]+?)\]\]/g,
    handle(m, lineFrom, out, config) {
      const src = m[1].trim();
      if (!isImagePath(src)) return;
      out.push({
        from:  lineFrom + m.index,
        to:    lineFrom + m.index + m[0].length,
        value: Decoration.replace({ widget: new ImageWidget(src, src, config.vaultPath) }),
      });
    },
  },
  // Image markdown links: ![alt](path)
  {
    re: /!\[([^\]]*)\]\(([^)]+)\)/g,
    handle(m, lineFrom, out, config) {
      const alt = m[1];
      const src = m[2].trim();
      if (!isImagePath(src) && !/^https?:\/\//.test(src)) return;
      out.push({
        from:  lineFrom + m.index,
        to:    lineFrom + m.index + m[0].length,
        value: Decoration.replace({ widget: new ImageWidget(alt || src, src, config.vaultPath) }),
      });
    },
  },
  // Wikilinks: [[Note]] or [[Note|Alias]] or [[Note#anchor]]
  {
    re: /\[\[([^\]\r\n]+?)\]\]/g,
    handle(m, lineFrom, out, config) {
      const inner = m[1];
      let target: string = inner;
      let display: string = inner;

      const pipeIdx = inner.indexOf('|');
      const hashIdx = inner.indexOf('#');

      if (pipeIdx !== -1) {
        target  = inner.slice(0, pipeIdx).split('#')[0].trim();
        display = inner.slice(pipeIdx + 1).trim();
      } else if (hashIdx !== -1) {
        target  = inner.slice(0, hashIdx).trim();
        display = inner.trim();
      } else {
        target = display = inner.trim();
      }

      const exists = noteExists(target, config.allPaths);
      out.push({
        from:  lineFrom + m.index,
        to:    lineFrom + m.index + m[0].length,
        value: Decoration.replace({ widget: new WikiLinkWidget(display, target, exists) }),
      });
    },
  },
  // Markdown links: [text](url)
  {
    re: /\[([^\]]+)\]\(([^)]+)\)/g,
    handle(m, lineFrom, out) {
      const text = m[1];
      const href = m[2];
      const isExt = /^https?:\/\//.test(href);

      out.push({
        from:  lineFrom + m.index,
        to:    lineFrom + m.index + m[0].length,
        value: Decoration.replace({
          widget: isExt
            ? new ExtLinkWidget(text, href)
            : new WikiLinkWidget(text, href.replace(/\.md$/, ''), true),
        }),
      });
    },
  },
];

function processInline(
  lineFrom: number,
  text: string,
  out: Deco[],
  config: LivePreviewConfig,
): void {
  // Track covered ranges to skip patterns that were already consumed
  const covered: [number, number][] = [];

  const overlaps = (from: number, to: number) =>
    covered.some(([cf, ct]) => from < ct && to > cf);

  for (const { re, handle } of INLINE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
      const from = m.index;
      const to   = m.index + m[0].length;

      if (!overlaps(from, to)) {
        handle(m, lineFrom, out, config);
        covered.push([from, to]);
      }
    }
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function pushMark(out: Deco[], from: number, to: number, cls: string): void {
  if (from >= to) return;
  out.push({ from, to, value: Decoration.mark({ class: cls }) });
}

function pushReplace(out: Deco[], from: number, to: number): void {
  if (from >= to) return;
  out.push({ from, to, value: Decoration.replace({}) });
}

// ─── ViewPlugin ───────────────────────────────────────────────────────────────

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.startState.facet(livePreviewConfig) !== u.state.facet(livePreviewConfig)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: v => v.decorations },
);
