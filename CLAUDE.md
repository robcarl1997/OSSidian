# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An Electron + React + CodeMirror 6 desktop app that clones core Obsidian functionality: vault-based note management, wikilinks (`[[note]]`), live markdown preview, multi-tab editing, Vim mode, and full-text search. UI strings are in German.

## Commands

```bash
# Development (starts renderer, main process, and Electron concurrently)
npm run dev

# Individual processes
npm run dev:renderer   # Vite dev server on port 5173
npm run dev:main       # tsc --watch for electron/
npm run dev:electron   # nodemon-supervised Electron (waits for renderer first)

# Build
npm run build          # builds renderer + main
npm run build:renderer # Vite → dist/renderer/
npm run build:main     # tsc → dist-electron/

# Type checking
npm run typecheck

# Tests
npm test               # Vitest (currently no test files exist)
```

## Architecture

### Process Boundary

**Main process** (`electron/main.ts`): All file system I/O, vault scanning, settings persistence (`userData/settings.json`), chokidar file watcher, and IPC handlers.

**Renderer process** (`src/renderer/`): React UI + CodeMirror editor. No direct FS access — everything goes through IPC.

**Bridge**: `electron/preload.ts` exposes `window.vaultApp` (typed as `VaultApi` in `shared/ipc.ts`) via `contextBridge`. All IPC calls flow through this interface.

**Shared code** (`shared/`): Pure TypeScript modules used by both processes — `ipc.ts` (all type definitions) and `linking.ts` (wikilink parsing, path resolution, link rewriting on rename). No Node.js imports allowed here.

### State Flow

1. On startup: main loads vault from last settings, sends full `VaultSnapshot` to renderer
2. Renderer holds all editor state in `App.tsx` (open tabs, active note, vault tree, settings)
3. File changes are pushed from main via `vault:change` IPC event (chokidar → renderer)
4. Auto-save: 700ms debounce after each edit, calls `note:save`

### Editor Architecture (`src/renderer/editor/`)

- `MarkdownEditor.tsx`: Thin wrapper that creates/reconfigures a CodeMirror `EditorView`; rebuilds when theme/font/vim settings change
- `livePreview.ts`: ViewPlugin that decorates markdown in-place — headings, bold/italic, wikilinks (rendered as clickable widgets), external links
- `linkAutocomplete.ts`: CompletionSource for `[[` — resolves notes relative to current file first

### Key Type Definitions (`shared/ipc.ts`)

- `AppSettings`: All persisted preferences (vim mode, theme, font, link format)
- `VaultEntry`: File tree node (name, path, kind: `'file'|'folder'`, children)
- `NoteDocument`: In-memory note (path, content, headings[], dirty flag, mtime)
- `VaultSnapshot`: Full initial state (tree, allPaths[], settings)
- `VaultChangeEvent`: Real-time update pushed from main (add/change/unlink)

### Theming

CSS custom properties in `src/renderer/styles.css`. Three themes (`dark` = Catppuccin Mocha, `light`, `sepia`) applied via `[data-theme="..."]` on `<body>`. All colors are variables — do not hardcode colors.

## Driving and testing the app

**Do not control the running app via screenshots.** Screenshots are slow, ambiguous, and force you to guess pixel positions. Use the Playwright debug harness instead — it gives you programmatic access to the renderer with structured (parseable) results.

### The harness

`scripts/debug-cli.mjs` — launches Electron via `playwright._electron.launch`, runs a sequence of commands separated by `--`, then exits. Requires the Vite dev server on `localhost:5173` (start with `npm run dev:renderer` if not running).

```bash
# basic shape
node scripts/debug-cli.mjs <cmd> [args] -- <cmd> [args] -- ...

# example: open a note, switch to vim normal mode, press Ctrl+D, read cursor pos
node scripts/debug-cli.mjs \
  waitMs 1500 \
  -- eval "(() => { const t = Array.from(document.querySelectorAll('.tree-item')).find(e => e.textContent.includes('Tasks')); t?.click(); return 'opened'; })()" \
  -- waitMs 1500 \
  -- focus .cm-content \
  -- press Escape \
  -- press "Control+d" \
  -- eval "(() => { const v = window.__cm; const head = v.state.selection.main.head; return { line: v.state.doc.lineAt(head).number, head, scroll: v.scrollDOM.scrollTop }; })()"
```

Available commands: `eval <js>`, `click <selector>`, `press <key>`, `type <text>`, `wait <selector>`, `waitMs <ms>`, `focus <selector>`, `screenshot <path>`, `reload`, `logs`. See the file header for full docs.

### Globals exposed for debugging

`MarkdownEditor.tsx` attaches the most recently created CodeMirror `EditorView` and the `Vim` API to `window` so the harness can introspect editor state without having to find them via the DOM:

- `window.__cm` — the `EditorView` (use `__cm.state`, `__cm.scrollDOM`, `__cm.cm` for the CM5-compat shim, etc.)
- `window.__Vim` — the Vim singleton (`Vim.handleKey`, `Vim.map`, etc.)

This is intentional — keep these in place; do not remove them.

### Workflow for fixing UI bugs

1. **Reproduce via the harness first.** Always confirm the bug fires under Playwright before changing code — it gives a deterministic baseline (cursor position, selection range, vim mode, scroll offset) you can compare against after the fix.
2. **Inspect state, not pixels.** Use `eval` to read `window.__cm.state.selection`, `window.__cm.cm.state.vim`, doc content, scroll offsets — anything you'd otherwise eyeball from a screenshot.
3. **Verify the fix the same way.** Re-run the same harness command sequence and confirm the structured result matches expectations.
4. **Only fall back to `screenshot` for genuinely visual issues** (CSS layout, theming, widget rendering) — never for state you can read programmatically.

### When to use a real screenshot

Layout/CSS regressions, theme color checks, widget rendering glitches. Save with `screenshot /tmp/foo.png`, then `Read /tmp/foo.png` to view it.
