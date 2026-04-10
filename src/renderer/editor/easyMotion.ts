/**
 * EasyMotion / Hop-style jump mode for CodeMirror 6 + Vim.
 *
 * Activation: Vim ex-command `:easymotion` or leader+leader in normal mode.
 * Labels every visible word start with 1-2 character codes; typing a label
 * jumps the cursor there.
 */

import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
} from '@codemirror/view';
import {
  StateField,
  StateEffect,
  type Extension,
  type EditorState,
  type Range,
  Prec,
} from '@codemirror/state';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EasyMotionLabel {
  /** Absolute document position (start of word). */
  pos: number;
  /** The 1-2 character label string. */
  label: string;
}

interface EasyMotionState {
  active: boolean;
  labels: EasyMotionLabel[];
  /** Characters typed so far (for multi-char label matching). */
  typed: string;
}

const INACTIVE: EasyMotionState = { active: false, labels: [], typed: '' };

// ─── StateEffects ───────────────────────────────────────────────────────────

/** Activate EasyMotion with a set of computed labels. */
const activateEasyMotion = StateEffect.define<EasyMotionLabel[]>();
/** Deactivate / cancel EasyMotion. */
const deactivateEasyMotion = StateEffect.define<void>();
/** Append a typed character for multi-char label narrowing. */
const typeEasyMotionChar = StateEffect.define<string>();

// ─── Label characters ───────────────────────────────────────────────────────

// Home-row first, then expanding outward — optimised for QWERTY.
const LABEL_CHARS = 'asdfghjklewruiopqtynmcvbxz';

/**
 * Generate labels for `count` targets.
 * Uses single characters when possible; falls back to two-character combos.
 */
function generateLabels(count: number): string[] {
  const chars = LABEL_CHARS;
  if (count <= chars.length) {
    return Array.from(chars.slice(0, count));
  }

  // Need two-char labels. Compute how many single-char prefixes produce
  // enough combos: each prefix yields `chars.length` combos.
  const labels: string[] = [];
  const prefixCount = Math.ceil(count / chars.length);
  for (let p = 0; p < prefixCount && labels.length < count; p++) {
    for (let s = 0; s < chars.length && labels.length < count; s++) {
      labels.push(chars[p] + chars[s]);
    }
  }
  return labels;
}

// ─── Viewport scanning ─────────────────────────────────────────────────────

/**
 * Find all word-boundary positions within the visible viewport.
 * Returns sorted absolute document positions.
 */
function findWordStarts(state: EditorState, viewport: { from: number; to: number }): number[] {
  const positions: number[] = [];
  const wordBoundary = /\b\w/g;

  // Iterate through visible lines
  let lineNo = state.doc.lineAt(viewport.from).number;
  const lastLineNo = state.doc.lineAt(viewport.to).number;

  while (lineNo <= lastLineNo) {
    const line = state.doc.line(lineNo);
    wordBoundary.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordBoundary.exec(line.text)) !== null) {
      const absPos = line.from + m.index;
      if (absPos >= viewport.from && absPos <= viewport.to) {
        positions.push(absPos);
      }
    }
    lineNo++;
  }

  return positions;
}

// ─── Label widget ───────────────────────────────────────────────────────────

class EasyMotionWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: EasyMotionWidget) {
    return this.label === other.label;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-easymotion-label';
    span.textContent = this.label;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

// ─── StateField ─────────────────────────────────────────────────────────────

const easyMotionField = StateField.define<EasyMotionState>({
  create() {
    return INACTIVE;
  },
  update(state, tr) {
    for (const e of tr.effects) {
      if (e.is(activateEasyMotion)) {
        return { active: true, labels: e.value, typed: '' };
      }
      if (e.is(deactivateEasyMotion)) {
        return INACTIVE;
      }
      if (e.is(typeEasyMotionChar)) {
        return { ...state, typed: state.typed + e.value };
      }
    }
    // Any doc change while active → cancel (safety)
    if (state.active && tr.docChanged) {
      return INACTIVE;
    }
    return state;
  },
});

// ─── Decoration provider ────────────────────────────────────────────────────

function buildDecorations(state: EditorState): DecorationSet {
  const em = state.field(easyMotionField);
  if (!em.active || em.labels.length === 0) return Decoration.none;

  const decos: Range<Decoration>[] = [];

  for (const { pos, label } of em.labels) {
    // Only show labels that still match the typed prefix
    if (em.typed && !label.startsWith(em.typed)) continue;

    // Show the remaining untyped portion of the label
    const remaining = label.slice(em.typed.length);
    if (!remaining) continue;

    // Replace character(s) at the word start with the label widget
    const replaceLen = Math.min(remaining.length, state.doc.length - pos);
    decos.push(
      Decoration.replace({
        widget: new EasyMotionWidget(remaining),
      }).range(pos, pos + replaceLen),
    );
  }

  // Sort by from position (required by CodeMirror)
  decos.sort((a, b) => a.from - b.from);

  return Decoration.set(decos);
}

const easyMotionDecorations = EditorView.decorations.compute(
  [easyMotionField],
  (state) => buildDecorations(state),
);

// ─── DOM class toggling (for dimming) ───────────────────────────────────────

const easyMotionEditorAttrs = EditorView.editorAttributes.compute(
  [easyMotionField],
  (state): Record<string, string> => {
    const em = state.field(easyMotionField);
    return em.active ? { class: 'cm-easymotion-dimmed' } : {};
  },
);

// ─── Key interception ───────────────────────────────────────────────────────

const easyMotionKeyHandler = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event: KeyboardEvent, view: EditorView) {
      const em = view.state.field(easyMotionField);
      if (!em.active) return false;

      // Escape cancels
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({ effects: deactivateEasyMotion.of(undefined) });
        return true;
      }

      // Only handle single printable characters
      if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) {
        // Non-character key → cancel
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({ effects: deactivateEasyMotion.of(undefined) });
        return true;
      }

      const ch = event.key.toLowerCase();
      const newTyped = em.typed + ch;

      // Check for exact match
      const exact = em.labels.find(l => l.label === newTyped);
      if (exact) {
        event.preventDefault();
        event.stopPropagation();
        // Jump cursor and deactivate
        view.dispatch({
          selection: { anchor: exact.pos },
          effects: deactivateEasyMotion.of(undefined),
          scrollIntoView: true,
        });
        return true;
      }

      // Check if any labels start with the typed prefix
      const hasPrefix = em.labels.some(l => l.label.startsWith(newTyped));
      if (hasPrefix) {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({ effects: typeEasyMotionChar.of(ch) });
        return true;
      }

      // No match at all → cancel
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: deactivateEasyMotion.of(undefined) });
      return true;
    },
  }),
);

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Activate EasyMotion on the given EditorView.
 * Scans the viewport for word starts and overlays labels.
 */
export function activateEasyMotionMode(view: EditorView): void {
  const { from, to } = view.viewport;
  const positions = findWordStarts(view.state, { from, to });

  if (positions.length === 0) return;

  const labels = generateLabels(positions.length);
  const labelEntries: EasyMotionLabel[] = positions.map((pos, i) => ({
    pos,
    label: labels[i],
  }));

  view.dispatch({ effects: activateEasyMotion.of(labelEntries) });
}

/**
 * The CodeMirror 6 extension bundle. Add this to your editor extensions.
 */
export function easyMotionExtension(): Extension {
  return [
    easyMotionField,
    easyMotionDecorations,
    easyMotionEditorAttrs,
    easyMotionKeyHandler,
  ];
}
