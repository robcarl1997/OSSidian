/**
 * Heading-based fold service for markdown documents.
 *
 * Provides a CodeMirror 6 fold service that makes heading sections foldable:
 * a heading section spans from the heading line to just before the next heading
 * of equal or higher level (or end of document).
 *
 * Also exports a custom fold gutter with German tooltips and a subtle arrow UI.
 */
import { foldService, foldGutter } from '@codemirror/language';

/**
 * A fold service that makes heading sections foldable.
 * A heading section spans from the heading line to just before the next
 * heading of equal or higher level (or end of document).
 */
export const markdownFoldService = foldService.of((state, lineStart, _lineEnd) => {
  const line = state.doc.lineAt(lineStart);
  const headingMatch = line.text.match(/^(#{1,6})\s+/);
  if (!headingMatch) return null;

  const level = headingMatch[1].length;

  // Find the end of this section: next heading of same or higher level, or end of doc
  let endLine = state.doc.lines;
  for (let i = line.number + 1; i <= state.doc.lines; i++) {
    const nextLine = state.doc.line(i);
    const nextHeading = nextLine.text.match(/^(#{1,6})\s+/);
    if (nextHeading && nextHeading[1].length <= level) {
      endLine = i - 1;
      break;
    }
  }

  // The fold range: from end of heading line to end of last line in section
  const foldEnd = state.doc.line(endLine);
  if (foldEnd.number <= line.number) return null; // Nothing to fold

  return { from: line.to, to: foldEnd.to };
});

/**
 * Custom fold gutter with heading-appropriate markers and German tooltips.
 */
export const headingFoldGutter = foldGutter({
  markerDOM(open) {
    const el = document.createElement('span');
    el.className = open ? 'cm-fold-marker open' : 'cm-fold-marker closed';
    el.textContent = open ? '\u25BE' : '\u25B8'; // ▾ / ▸
    el.title = open ? 'Einklappen' : 'Ausklappen';
    return el;
  },
});
