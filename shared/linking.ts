// Pure utility functions – no Node.js dependencies, works in browser and main process.

import type { HeadingRef } from './ipc';

// ─── Text utilities ───────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ─── Headings ─────────────────────────────────────────────────────────────────

export function extractHeadings(content: string): HeadingRef[] {
  const headings: HeadingRef[] = [];
  const lines = content.split('\n');

  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (m) {
      const text = m[2].trim();
      headings.push({
        text,
        level: m[1].length,
        slug: slugify(text),
        line: i,
      });
    }
  });

  return headings;
}

// ─── Wikilink parsing ─────────────────────────────────────────────────────────

export interface WikilinkMatch {
  /** Note name without anchor (e.g. "My Note") */
  target: string;
  /** Optional heading anchor (e.g. "section-title") */
  anchor: string | null;
  /** Optional display alias (e.g. "click here") */
  alias: string | null;
  /** Full raw match (e.g. "[[My Note|click here]]") */
  raw: string;
  /** Start position in the string */
  from: number;
  /** End position in the string */
  to: number;
}

export function parseWikilinks(content: string): WikilinkMatch[] {
  const results: WikilinkMatch[] = [];
  const re = /\[\[([^\]\r\n]+?)\]\]/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    const inner = m[1];
    const pipeIdx = inner.indexOf('|');
    const hashIdx = inner.indexOf('#');

    let target: string;
    let anchor: string | null = null;
    let alias: string | null = null;

    if (pipeIdx !== -1) {
      const beforePipe = inner.slice(0, pipeIdx);
      alias = inner.slice(pipeIdx + 1).trim();
      if (hashIdx !== -1 && hashIdx < pipeIdx) {
        target = beforePipe.slice(0, hashIdx).trim();
        anchor = beforePipe.slice(hashIdx + 1).trim();
      } else {
        target = beforePipe.trim();
      }
    } else if (hashIdx !== -1) {
      target = inner.slice(0, hashIdx).trim();
      anchor = inner.slice(hashIdx + 1).trim();
    } else {
      target = inner.trim();
    }

    results.push({ target, anchor, alias, raw: m[0], from: m.index, to: m.index + m[0].length });
  }

  return results;
}

// ─── Path helpers (no Node.js required) ──────────────────────────────────────

function basename(p: string, ext?: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  let name = parts[parts.length - 1] ?? '';
  if (ext && name.endsWith(ext)) name = name.slice(0, -ext.length);
  return name;
}

function dirname(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.slice(0, -1).join('/') || '/';
}

// ─── Note resolution ──────────────────────────────────────────────────────────

/** Extract the note stem (filename without .md) from a full path. */
export function stemFromPath(p: string): string {
  return basename(p.replace(/\\/g, '/'), '.md').toLowerCase();
}

/**
 * Find the best matching path for a wikilink target among all vault paths.
 * Prefers notes in the same directory as `fromPath`.
 */
export function findPathByStem(
  target: string,
  allPaths: string[],
  fromPath: string,
): string | null {
  const needle = target.toLowerCase().trim();
  const matches = allPaths.filter(p => stemFromPath(p) === needle);

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const fromDir = dirname(fromPath.replace(/\\/g, '/'));
  const sameDir = matches.find(p => dirname(p.replace(/\\/g, '/')) === fromDir);
  return sameDir ?? matches[0];
}

/** Check whether a wikilink target resolves to an existing path. */
export function wikilinkExists(target: string, allPaths: string[]): boolean {
  const needle = target.toLowerCase().trim();
  return allPaths.some(p => stemFromPath(p) === needle);
}

// ─── Link rewriting ───────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace all wikilinks pointing to `oldStem` with `newStem` in `content`.
 * Leaves aliases intact.
 */
export function rewriteWikilinks(
  content: string,
  oldStem: string,
  newStem: string,
): string {
  if (oldStem === newStem) return content;

  const re = new RegExp(
    `\\[\\[${escapeRegex(oldStem)}(#[^\\]|]*)?(?:\\|([^\\]]+))?\\]\\]`,
    'gi',
  );

  return content.replace(re, (_match, anchor, alias) => {
    const anchorPart = anchor ?? '';
    const aliasPart = alias ? `|${alias}` : '';
    return `[[${newStem}${anchorPart}${aliasPart}]]`;
  });
}
