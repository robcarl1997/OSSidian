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
