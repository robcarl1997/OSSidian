/**
 * Autocomplete for [[wikilinks]] in CodeMirror 6.
 * Triggers after typing `[[` and suggests note names from the vault.
 */

import {
  Completion,
  CompletionContext,
  CompletionResult,
  autocompletion,
} from '@codemirror/autocomplete';
import { Facet } from '@codemirror/state';
import { Extension } from '@codemirror/state';

// ─── Config facet ─────────────────────────────────────────────────────────────

export interface AutocompleteConfig {
  allPaths: string[];
  notePath: string;
}

export const autocompleteConfig = Facet.define<AutocompleteConfig, AutocompleteConfig>({
  combine: vs => vs[0] ?? { allPaths: [], notePath: '' },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function basename(p: string, ext?: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  let name = parts[parts.length - 1] ?? '';
  if (ext && name.endsWith(ext)) name = name.slice(0, -ext.length);
  return name;
}

function dirname(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.slice(0, -1).join('/');
}

// ─── Completion source ────────────────────────────────────────────────────────

function wikilinkSource(context: CompletionContext): CompletionResult | null {
  // Check if we're inside [[…
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const textBefore = line.text.slice(0, pos - line.from);

  const openBracket = textBefore.lastIndexOf('[[');
  if (openBracket === -1) return null;

  // Make sure there's no closing ]] before the cursor
  const afterOpen = textBefore.slice(openBracket + 2);
  if (afterOpen.includes(']]')) return null;

  const config = state.facet(autocompleteConfig);
  const query = afterOpen.toLowerCase();
  const fromDir = dirname(config.notePath.replace(/\\/g, '/'));

  // Build completions
  const completions: Completion[] = config.allPaths
    .filter(p => {
      const stem = basename(p, '.md').toLowerCase();
      return stem.includes(query);
    })
    .sort((a, b) => {
      // Same directory first
      const aDir = dirname(a.replace(/\\/g, '/'));
      const bDir = dirname(b.replace(/\\/g, '/'));
      const aSame = aDir === fromDir ? 0 : 1;
      const bSame = bDir === fromDir ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;

      const aStem = basename(a, '.md').toLowerCase();
      const bStem = basename(b, '.md').toLowerCase();

      // Prefix match before substring match
      const aPrefix = aStem.startsWith(query) ? 0 : 1;
      const bPrefix = bStem.startsWith(query) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;

      return aStem.localeCompare(bStem);
    })
    .slice(0, 50)
    .map(p => {
      const stem = basename(p, '.md');
      return {
        label: stem,
        apply: (view, _completion, from, to) => {
          // Replace the partial text + closing ]]
          const insert = `${stem}]]`;
          const textAfter = line.text.slice(to - line.from);
          const hasClose = textAfter.startsWith(']]');
          view.dispatch({
            changes: {
              from,
              to: hasClose ? to + 2 : to,
              insert,
            },
            selection: { anchor: from + insert.length },
          });
        },
        detail: p.replace(/\\/g, '/').split('/').slice(-2).join('/'),
        type: 'text',
      } satisfies Completion;
    });

  return {
    from: line.from + openBracket + 2,
    options: completions,
    validFor: /^[^\]]*$/,
  };
}

// ─── Extension export ─────────────────────────────────────────────────────────

export function wikilinkAutocomplete(): Extension {
  return autocompletion({
    override: [wikilinkSource],
    activateOnTyping: true,
    closeOnBlur: true,
  });
}
