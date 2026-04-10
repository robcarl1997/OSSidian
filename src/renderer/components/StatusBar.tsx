import { useMemo } from 'react';
import type { NoteDocument } from '../../../shared/ipc';

export interface StatusBarProps {
  doc: NoteDocument | null;
  cursorOffset: number;
}

/** Compute line and column from a string offset. */
function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, col: clamped - lastNewline };
}

/** Count words in text (splits on whitespace, ignores empty tokens). */
function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/** Format reading time from word count (~200 wpm). */
function formatReadingTime(words: number): string {
  if (words === 0) return '0 min';
  const minutes = words / 200;
  if (minutes < 1) return '< 1 min';
  return `${Math.ceil(minutes)} min`;
}

export default function StatusBar({ doc, cursorOffset }: StatusBarProps) {
  if (!doc) return null;

  const stats = useMemo(() => {
    const text = doc.raw;
    const words = countWords(text);
    const chars = text.length;
    const lines = text.split('\n').length;
    const readingTime = formatReadingTime(words);
    return { words, chars, lines, readingTime };
  }, [doc.raw]);

  const { line, col } = useMemo(
    () => offsetToLineCol(doc.raw, cursorOffset),
    [doc.raw, cursorOffset],
  );

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-bar-item">{stats.words} {`W\u00f6rter`}</span>
        <span className="status-bar-divider" />
        <span className="status-bar-item">{stats.chars} Zeichen</span>
        <span className="status-bar-divider" />
        <span className="status-bar-item">{stats.lines} Zeilen</span>
        <span className="status-bar-divider" />
        <span className="status-bar-item">{stats.readingTime} Lesezeit</span>
      </div>
      <div className="status-bar-right">
        <span className="status-bar-item">Zeile {line}, Spalte {col}</span>
      </div>
    </div>
  );
}
