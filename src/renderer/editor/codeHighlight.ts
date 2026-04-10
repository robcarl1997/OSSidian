/**
 * Syntax highlighting for fenced code blocks using highlight.js
 *
 * Tokenises code block content and returns mark decoration positions
 * that the live-preview StateField applies to the CodeMirror document.
 */

import hljs from 'highlight.js/lib/core';

// ── Register common languages (keeps the bundle small) ─────────────────────

import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdownLang from 'highlight.js/lib/languages/markdown';
import lua from 'highlight.js/lib/languages/lua';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import plaintext from 'highlight.js/lib/languages/plaintext';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import csharp from 'highlight.js/lib/languages/csharp';
import r from 'highlight.js/lib/languages/r';
import perl from 'highlight.js/lib/languages/perl';
import haskell from 'highlight.js/lib/languages/haskell';

// Canonical names
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', c);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('r', r);
hljs.registerLanguage('perl', perl);
hljs.registerLanguage('haskell', haskell);

// Common aliases
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('py', python);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('htm', xml);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('zsh', bash);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('md', markdownLang);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('h', c);
hljs.registerLanguage('hpp', cpp);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('kt', kotlin);
hljs.registerLanguage('hs', haskell);
hljs.registerLanguage('pl', perl);

// ── Types ──────────────────────────────────────────────────────────────────

export interface HighlightToken {
  /** Character offset within the code block text */
  from: number;
  to: number;
  /** CSS class, e.g. 'hljs-keyword' */
  className: string;
}

// ── HTML → token positions ─────────────────────────────────────────────────

/**
 * Parse highlight.js HTML output and map `<span class="hljs-*">` regions
 * back to character offsets in the original source text.
 */
function parseHljsHtml(html: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let textOffset = 0;

  // Matches: opening <span class="hljs-*">, closing </span>, or text content
  const tagRe = /<span class="(hljs-[\w-]+)">|<\/span>|([^<]+)/g;
  const classStack: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    if (m[1]) {
      // Opening tag — push class
      classStack.push(m[1]);
    } else if (m[0] === '</span>') {
      // Closing tag — pop class
      classStack.pop();
    } else if (m[2]) {
      // Text node — decode HTML entities and record token
      const text = m[2]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'");
      if (classStack.length > 0) {
        tokens.push({
          from: textOffset,
          to: textOffset + text.length,
          className: classStack[classStack.length - 1],
        });
      }
      textOffset += text.length;
    }
  }

  return tokens;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Highlight a code string for the given language.
 * Returns token positions with CSS class names, or an empty array
 * if the language is unknown or highlighting fails.
 */
export function highlightCode(code: string, lang: string): HighlightToken[] {
  if (!lang || !hljs.getLanguage(lang)) return [];

  try {
    const result = hljs.highlight(code, { language: lang });
    return parseHljsHtml(result.value);
  } catch {
    return [];
  }
}
