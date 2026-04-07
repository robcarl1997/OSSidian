/**
 * Git gutter for CodeMirror 6.
 * Shows VS Code-style change indicators (added/modified/deleted) next to line
 * numbers. Clicking a marker fires a custom 'git:hunk-click' event that bubbles
 * up to MarkdownEditor for the revert popup.
 */

import { gutter, GutterMarker, EditorView, type BlockInfo } from '@codemirror/view';
import { StateField, StateEffect, type Extension } from '@codemirror/state';
import { diffLines } from 'diff';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHunk {
  type: 'added' | 'modified' | 'deleted';
  /** 1-indexed first line in the *current* file. For 'deleted', the line after which the deletion occurs. */
  currentFrom: number;
  /** 1-indexed last line in the *current* file (inclusive). */
  currentTo: number;
  /** Original lines from HEAD (used for reverting). */
  headContent: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

export const setGitHunks = StateEffect.define<GitHunk[]>();

export const gitHunksField = StateField.define<GitHunk[]>({
  create: () => [],
  update: (hunks, tr) => {
    for (const e of tr.effects) {
      if (e.is(setGitHunks)) return e.value;
    }
    return hunks;
  },
});

// ─── Diff computation ─────────────────────────────────────────────────────────

export function computeHunks(headContent: string | null, currentContent: string): GitHunk[] {
  if (headContent === null) return [];
  if (headContent === currentContent) return [];

  const changes = diffLines(headContent, currentContent);
  const hunks: GitHunk[] = [];
  let currentLine = 1;

  let i = 0;
  while (i < changes.length) {
    const change = changes[i];
    const count  = change.count ?? 0;

    if (!change.added && !change.removed) {
      currentLine += count;
      i++;
      continue;
    }

    if (change.removed) {
      const next = changes[i + 1];
      if (next?.added) {
        // Consecutive remove+add → modification
        const addedCount = next.count ?? 0;
        hunks.push({
          type:        'modified',
          currentFrom: currentLine,
          currentTo:   currentLine + addedCount - 1,
          headContent: change.value,
        });
        currentLine += addedCount;
        i += 2;
      } else {
        // Pure deletion – show marker at the line *before* the deletion
        const markerLine = Math.max(1, currentLine);
        // Merge with preceding hunk if same line
        const prev = hunks[hunks.length - 1];
        if (prev?.type === 'deleted' && prev.currentFrom === markerLine) {
          prev.headContent += change.value;
        } else {
          hunks.push({
            type:        'deleted',
            currentFrom: markerLine,
            currentTo:   markerLine,
            headContent: change.value,
          });
        }
        i++;
      }
      continue;
    }

    if (change.added) {
      hunks.push({
        type:        'added',
        currentFrom: currentLine,
        currentTo:   currentLine + count - 1,
        headContent: '',
      });
      currentLine += count;
      i++;
    }
  }

  return hunks;
}

// ─── Gutter marker ────────────────────────────────────────────────────────────

class GitMarker extends GutterMarker {
  constructor(readonly hunkType: 'added' | 'modified' | 'deleted', readonly isFirst: boolean, readonly isLast: boolean) {
    super();
  }
  eq(other: GitMarker) {
    return this.hunkType === other.hunkType && this.isFirst === other.isFirst && this.isLast === other.isLast;
  }
  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = [
      'cm-git-marker',
      `cm-git-${this.hunkType}`,
      this.isFirst ? 'cm-git-first' : '',
      this.isLast  ? 'cm-git-last'  : '',
    ].filter(Boolean).join(' ');
    return div;
  }
  ignoreEvent() { return false; }
}

// ─── Extension ────────────────────────────────────────────────────────────────

export function gitGutterExtension(): Extension {
  return [
    gitHunksField,
    gutter({
      class: 'cm-git-gutter',
      lineMarker(view: EditorView, line: BlockInfo): GutterMarker | null {
        const hunks  = view.state.field(gitHunksField);
        const lineNo = view.state.doc.lineAt(line.from).number;

        for (const hunk of hunks) {
          if (lineNo >= hunk.currentFrom && lineNo <= hunk.currentTo) {
            return new GitMarker(
              hunk.type,
              lineNo === hunk.currentFrom,
              lineNo === hunk.currentTo,
            );
          }
        }
        return null;
      },
      lineMarkerChange: (update) =>
        update.docChanged ||
        update.state.field(gitHunksField) !== update.startState.field(gitHunksField),
      domEventHandlers: {
        click(view: EditorView, line: BlockInfo, event: Event): boolean {
          const hunks  = view.state.field(gitHunksField);
          const lineNo = view.state.doc.lineAt(line.from).number;
          const hunk   = hunks.find(h => lineNo >= h.currentFrom && lineNo <= h.currentTo);
          if (!hunk) return false;
          const me = event as MouseEvent;
          view.dom.dispatchEvent(new CustomEvent('git:hunk-click', {
            bubbles: true,
            detail: { x: me.clientX, y: me.clientY, hunk },
          }));
          return true;
        },
      },
    }),
  ];
}
