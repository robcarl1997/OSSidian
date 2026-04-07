export interface SlashCommand {
  id: string;
  group: string;
  label: string;
  icon: string;
  keywords: string[];
  insert: string;
  cursorOffset: number; // character offset within inserted text where cursor lands
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── Headings ────────────────────────────────────────────────────────────────
  { id: 'h1', group: 'Überschrift', label: 'Überschrift 1', icon: 'H1',
    keywords: ['h1', 'heading', 'überschrift', 'titel'],
    insert: '# ', cursorOffset: 2 },
  { id: 'h2', group: 'Überschrift', label: 'Überschrift 2', icon: 'H2',
    keywords: ['h2', 'heading', 'überschrift'],
    insert: '## ', cursorOffset: 3 },
  { id: 'h3', group: 'Überschrift', label: 'Überschrift 3', icon: 'H3',
    keywords: ['h3', 'heading', 'überschrift'],
    insert: '### ', cursorOffset: 4 },

  // ── Lists ────────────────────────────────────────────────────────────────────
  { id: 'bullet', group: 'Liste', label: 'Aufzählung', icon: '•',
    keywords: ['bullet', 'list', 'aufzählung', 'liste', 'ul'],
    insert: '- ', cursorOffset: 2 },
  { id: 'numbered', group: 'Liste', label: 'Nummerierte Liste', icon: '1.',
    keywords: ['numbered', 'list', 'nummer', 'ol'],
    insert: '1. ', cursorOffset: 3 },
  { id: 'task', group: 'Liste', label: 'Aufgabe / Todo', icon: '☐',
    keywords: ['task', 'todo', 'checkbox', 'aufgabe', 'check'],
    insert: '- [ ] ', cursorOffset: 6 },

  // ── Blocks ────────────────────────────────────────────────────────────────────
  { id: 'quote', group: 'Block', label: 'Zitat', icon: '❝',
    keywords: ['quote', 'zitat', 'blockquote'],
    insert: '> ', cursorOffset: 2 },
  { id: 'code', group: 'Block', label: 'Code-Block', icon: '</>',
    keywords: ['code', 'codeblock', 'programm', 'snippet'],
    insert: '```\n\n```', cursorOffset: 4 },
  { id: 'divider', group: 'Block', label: 'Trennlinie', icon: '—',
    keywords: ['divider', 'hr', 'trennlinie', 'horizontal', 'rule'],
    insert: '---', cursorOffset: 3 },

  // ── Table ─────────────────────────────────────────────────────────────────────
  { id: 'table', group: 'Tabelle', label: 'Tabelle', icon: '▦',
    keywords: ['table', 'tabelle', 'grid'],
    // cursor lands in the first data cell (offset 57)
    insert: '| Spalte 1 | Spalte 2 | Spalte 3 |\n| --- | --- | --- |\n|  |  |  |',
    cursorOffset: 57 },

  // ── Inline formatting ─────────────────────────────────────────────────────────
  { id: 'bold', group: 'Text', label: 'Fett', icon: 'B',
    keywords: ['bold', 'fett', 'strong'],
    insert: '****', cursorOffset: 2 },
  { id: 'italic', group: 'Text', label: 'Kursiv', icon: 'I',
    keywords: ['italic', 'kursiv', 'em'],
    insert: '**', cursorOffset: 1 },
  { id: 'inlinecode', group: 'Text', label: 'Inline-Code', icon: '`',
    keywords: ['inline', 'code', 'mono'],
    insert: '``', cursorOffset: 1 },
];

export function filterCommands(query: string): SlashCommand[] {
  if (!query) return SLASH_COMMANDS;
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter(cmd =>
    cmd.label.toLowerCase().includes(q) ||
    cmd.keywords.some(k => k.includes(q))
  );
}
