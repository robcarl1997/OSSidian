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
import { EditorState, Facet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import * as yaml from 'js-yaml';

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

    // ── YAML Frontmatter (only at document start)
    if (line.number === 1 && line.text === '---') {
      let endLineNo = -1;
      let sp = line.to + 1;
      while (sp <= state.doc.length) {
        const inner = state.doc.lineAt(sp);
        if (inner.text === '---' || inner.text === '...') { endLineNo = inner.number; break; }
        sp = inner.to + 1;
      }
      if (endLineNo !== -1) {
        const hasCursor = cursorLineNo >= 1 && cursorLineNo <= endLineNo;
        if (!hasCursor) {
          const yamlLines: string[] = [];
          for (let n = 2; n < endLineNo; n++) yamlLines.push(state.doc.line(n).text);
          try {
            const parsed = yaml.load(yamlLines.join('\n'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const endLine = state.doc.line(endLineNo);
              items.push({
                from:  line.from,
                to:    endLine.to,
                value: Decoration.replace({
                  widget: new FrontmatterWidget(parsed as Record<string, unknown>),
                  block: true,
                }),
              });
            }
          } catch { /* invalid YAML — show raw */ }
        }
        pos = state.doc.line(endLineNo).to + 1;
        continue;
      }
    }

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

        // ── Dataview query block ──────────────────────────────────────────
        if (lang === 'dataview' && !hasCursor) {
          const queryLines: string[] = [];
          for (let n = startNo + 1; n < endNo; n++) {
            queryLines.push(state.doc.line(n).text);
          }
          const queryText = queryLines.join('\n');
          const endLine = state.doc.line(endNo);
          items.push({
            from: line.from,
            to:   endLine.to,
            value: Decoration.replace({
              widget: new DataviewWidget(queryText),
              block: true,
            }),
          });
          pos = endLine.to + 1;
          continue;
        }

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
    const hasDataviewEffect = tr.effects.some(e => e.is(dataviewDataReady));
    if (tr.docChanged || cursorMoved || hasDataviewEffect) return buildBlockDecorations(tr.state);
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

  toDOM(view: EditorView): HTMLElement {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'cm-task-checkbox';
    cb.checked = this.checked;
    cb.addEventListener('mousedown', e => e.preventDefault());
    cb.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const pos  = view.posAtDOM(cb);
      const line = view.state.doc.lineAt(pos);
      const newText = line.text.replace(/\[([ xX])\]/, (_, c) =>
        c.trim() === '' ? '[x]' : '[ ]'
      );
      if (newText !== line.text) {
        view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } });
      }
    });
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

// ─── Frontmatter widget ───────────────────────────────────────────────────────

class FrontmatterWidget extends WidgetType {
  constructor(readonly data: Record<string, unknown>) { super(); }

  eq(other: FrontmatterWidget): boolean {
    return JSON.stringify(this.data) === JSON.stringify(other.data);
  }

  toDOM(): HTMLElement {
    const outer = document.createElement('div');
    outer.className = 'cm-frontmatter-wrapper';

    const entries = Object.entries(this.data);
    if (entries.length > 0) {
      const card = document.createElement('div');
      card.className = 'cm-frontmatter';
      outer.appendChild(card);

      for (const [key, value] of entries) {
        const row = document.createElement('div');
        row.className = 'cm-frontmatter-row';
        card.appendChild(row);

        const keyEl = document.createElement('span');
        keyEl.className = 'cm-frontmatter-key';
        keyEl.textContent = key;
        row.appendChild(keyEl);

        const valEl = document.createElement('span');
        valEl.className = 'cm-frontmatter-value';

        const isTagKey = key === 'tags' || key === 'tag';
        const arr = Array.isArray(value) ? value : (isTagKey && typeof value === 'string' ? value.split(/[\s,]+/) : null);

        if (arr) {
          arr.forEach(item => {
            const chip = document.createElement('span');
            chip.className = isTagKey ? 'cm-frontmatter-tag' : 'cm-frontmatter-chip';
            chip.textContent = String(item).replace(/^#/, '');
            valEl.appendChild(chip);
          });
        } else if (value instanceof Date) {
          valEl.textContent = value.toLocaleDateString('de');
        } else if (value !== null && value !== undefined) {
          valEl.textContent = String(value);
        }

        row.appendChild(valEl);
      }
    }

    return outer;
  }

  ignoreEvent() { return false; }
}

// ─── Dataview query parser + widget ──────────────────────────────────────────

interface DataviewQuery {
  from: string;
  where: Array<{ field: string; op: string; value: string }>;
  sort: { field: string; dir: 'ASC' | 'DESC' } | null;
  fields: string[];
  limit: number;
}

function parseDataviewQuery(text: string): DataviewQuery {
  const query: DataviewQuery = {
    from: '',
    where: [],
    sort: null,
    fields: ['file.name'],
    limit: 100,
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const directive = line.slice(0, colonIdx).trim().toUpperCase();
    const rest = line.slice(colonIdx + 1).trim();

    switch (directive) {
      case 'FROM':
        query.from = rest.replace(/^"(.*)"$/, '$1').trim();
        break;
      case 'WHERE': {
        // Split on ' AND ' (case-insensitive)
        const conditions = rest.split(/\s+AND\s+/i);
        for (const cond of conditions) {
          const m = cond.trim().match(/^(\S+)\s+(=|!=|>|<|>=|<=|CONTAINS)\s+(.+)$/i);
          if (m) {
            query.where.push({
              field: m[1],
              op: m[2].toUpperCase(),
              value: m[3].replace(/^"(.*)"$/, '$1'),
            });
          }
        }
        break;
      }
      case 'SORT': {
        const sm = rest.match(/^(\S+)\s+(ASC|DESC)$/i);
        if (sm) {
          query.sort = { field: sm[1], dir: sm[2].toUpperCase() as 'ASC' | 'DESC' };
        } else {
          query.sort = { field: rest.trim(), dir: 'ASC' };
        }
        break;
      }
      case 'FIELDS':
        query.fields = rest.split(',').map(f => f.trim()).filter(Boolean);
        break;
      case 'LIMIT': {
        const n = parseInt(rest, 10);
        if (!isNaN(n) && n > 0) query.limit = n;
        break;
      }
    }
  }

  return query;
}

function getFieldValue(entry: { path: string; name: string; frontmatter: Record<string, unknown> }, field: string): unknown {
  if (field === 'file.name') return entry.name;
  if (field === 'file.path') return entry.path;
  return entry.frontmatter[field];
}

function matchesCondition(
  entry: { path: string; name: string; frontmatter: Record<string, unknown> },
  cond: { field: string; op: string; value: string },
): boolean {
  const val = getFieldValue(entry, cond.field);
  if (val === undefined || val === null) return false;

  const condVal = cond.value;

  switch (cond.op) {
    case '=':
      return String(val) === condVal;
    case '!=':
      return String(val) !== condVal;
    case '>': {
      const n1 = Number(val), n2 = Number(condVal);
      if (!isNaN(n1) && !isNaN(n2)) return n1 > n2;
      return String(val) > condVal;
    }
    case '<': {
      const n1 = Number(val), n2 = Number(condVal);
      if (!isNaN(n1) && !isNaN(n2)) return n1 < n2;
      return String(val) < condVal;
    }
    case '>=': {
      const n1 = Number(val), n2 = Number(condVal);
      if (!isNaN(n1) && !isNaN(n2)) return n1 >= n2;
      return String(val) >= condVal;
    }
    case '<=': {
      const n1 = Number(val), n2 = Number(condVal);
      if (!isNaN(n1) && !isNaN(n2)) return n1 <= n2;
      return String(val) <= condVal;
    }
    case 'CONTAINS': {
      if (Array.isArray(val)) return val.some(v => String(v) === condVal);
      return String(val).includes(condVal);
    }
    default:
      return false;
  }
}

function formatCellValue(val: unknown): string {
  if (val === undefined || val === null) return '';
  if (val instanceof Date) return val.toLocaleDateString('de');
  if (Array.isArray(val)) return val.map(v => String(v)).join(', ');
  return String(val);
}

// Store pending dataview queries — fetched asynchronously, then trigger editor update
const dataviewResultsCache = new Map<string, Array<{ path: string; name: string; frontmatter: Record<string, unknown> }>>();
let dataviewFetchPending = false;

/** State effect used to signal that dataview data has arrived and decorations need rebuilding. */
const dataviewDataReady = StateEffect.define<null>();

function ensureDataviewData(): void {
  if (dataviewFetchPending) return;
  if (typeof window === 'undefined' || !window.vaultApp) return;

  dataviewFetchPending = true;
  window.vaultApp.queryFrontmatter().then(entries => {
    dataviewResultsCache.set('__all__', entries);
    dataviewFetchPending = false;

    // Force re-render of any active editor view
    const cm = (window as unknown as { __cm?: EditorView }).__cm;
    if (cm) {
      cm.dispatch({ effects: dataviewDataReady.of(null) });
    }
  }).catch(() => {
    dataviewFetchPending = false;
  });
}

class DataviewWidget extends WidgetType {
  readonly dataLoaded: boolean;
  constructor(readonly queryText: string) {
    super();
    this.dataLoaded = dataviewResultsCache.has('__all__');
  }

  eq(other: DataviewWidget) {
    return this.queryText === other.queryText && this.dataLoaded === other.dataLoaded;
  }
  ignoreEvent() { return false; }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'dataview-wrapper';

    const allEntries = dataviewResultsCache.get('__all__');

    if (!allEntries) {
      // Data not loaded yet — show loading state and trigger fetch
      const loading = document.createElement('div');
      loading.className = 'dataview-loading';
      loading.textContent = 'Dataview: Lade Daten...';
      wrapper.appendChild(loading);
      ensureDataviewData();
      return wrapper;
    }

    const query = parseDataviewQuery(this.queryText);

    // Filter by FROM (subfolder)
    let entries = allEntries;
    if (query.from) {
      const folder = query.from.replace(/\\/g, '/');
      entries = entries.filter(e => {
        const rel = e.path.replace(/\\/g, '/');
        return rel.includes('/' + folder + '/') || rel.includes('/' + folder);
      });
    }

    // Filter by WHERE conditions
    for (const cond of query.where) {
      entries = entries.filter(e => matchesCondition(e, cond));
    }

    // Sort
    if (query.sort) {
      const { field, dir } = query.sort;
      entries = [...entries].sort((a, b) => {
        const va = getFieldValue(a, field);
        const vb = getFieldValue(b, field);
        if (va === undefined || va === null) return 1;
        if (vb === undefined || vb === null) return -1;
        const na = Number(va), nb = Number(vb);
        let cmp: number;
        if (!isNaN(na) && !isNaN(nb)) {
          cmp = na - nb;
        } else {
          cmp = String(va).localeCompare(String(vb));
        }
        return dir === 'DESC' ? -cmp : cmp;
      });
    }

    // Limit
    entries = entries.slice(0, query.limit);

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dataview-empty';
      empty.textContent = 'Keine Ergebnisse gefunden.';
      wrapper.appendChild(empty);
      return wrapper;
    }

    // Build table
    const table = document.createElement('table');
    table.className = 'dataview-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const field of query.fields) {
      const th = document.createElement('th');
      th.textContent = field === 'file.name' ? 'Datei' : field === 'file.path' ? 'Pfad' : field;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const entry of entries) {
      const tr = document.createElement('tr');
      tr.className = 'dataview-row';

      for (const field of query.fields) {
        const td = document.createElement('td');

        if (field === 'file.name') {
          const link = document.createElement('span');
          link.className = 'dataview-link';
          link.textContent = entry.name;
          link.addEventListener('mousedown', e => {
            e.preventDefault();
            view.dom.dispatchEvent(new CustomEvent('obsidian:link-click', {
              bubbles: true,
              detail: { target: entry.name, external: false },
            }));
          });
          td.appendChild(link);
        } else if (field === 'file.path') {
          const link = document.createElement('span');
          link.className = 'dataview-link';
          link.textContent = entry.path;
          link.addEventListener('mousedown', e => {
            e.preventDefault();
            view.dom.dispatchEvent(new CustomEvent('obsidian:link-click', {
              bubbles: true,
              detail: { target: entry.name, external: false },
            }));
          });
          td.appendChild(link);
        } else {
          const val = getFieldValue(entry, field);
          if (Array.isArray(val)) {
            for (const item of val) {
              const chip = document.createElement('span');
              chip.className = 'dataview-chip';
              chip.textContent = String(item);
              td.appendChild(chip);
            }
          } else {
            td.textContent = formatCellValue(val);
          }
        }

        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);

    // Footer with count
    const footer = document.createElement('div');
    footer.className = 'dataview-footer';
    footer.textContent = `${entries.length} Ergebnis${entries.length !== 1 ? 'se' : ''}`;
    wrapper.appendChild(footer);

    return wrapper;
  }
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
