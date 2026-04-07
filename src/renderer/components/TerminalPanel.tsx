import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../../../shared/ipc';

// ─── Per-theme xterm color maps ───────────────────────────────────────────────

const ANSI_DARK = {
  black:        '#45475a',
  red:          '#f38ba8',
  green:        '#a6e3a1',
  yellow:       '#f9e2af',
  blue:         '#89b4fa',
  magenta:      '#cba6f7',
  cyan:         '#89dceb',
  white:        '#bac2de',
  brightBlack:  '#585b70',
  brightRed:    '#f38ba8',
  brightGreen:  '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue:   '#89b4fa',
  brightMagenta:'#cba6f7',
  brightCyan:   '#89dceb',
  brightWhite:  '#a6adc8',
};

const ANSI_LIGHT = {
  black:        '#2c2c2c',
  red:          '#cc0000',
  green:        '#196f19',
  yellow:       '#b45309',
  blue:         '#1d4ed8',
  magenta:      '#7c3aed',
  cyan:         '#0e7490',
  white:        '#6b7280',
  brightBlack:  '#555555',
  brightRed:    '#dc2626',
  brightGreen:  '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue:   '#2563eb',
  brightMagenta:'#9333ea',
  brightCyan:   '#0891b2',
  brightWhite:  '#9ca3af',
};

const ANSI_SEPIA = {
  black:        '#3d2b1f',
  red:          '#8a3422',
  green:        '#3d6b2c',
  yellow:       '#8a6815',
  blue:         '#2a5d7d',
  magenta:      '#7a3878',
  cyan:         '#1a6b6d',
  white:        '#7a6555',
  brightBlack:  '#5a4030',
  brightRed:    '#a84030',
  brightGreen:  '#4a7f38',
  brightYellow: '#a07820',
  brightBlue:   '#3a6d8d',
  brightMagenta:'#8a4888',
  brightCyan:   '#2a7b7d',
  brightWhite:  '#9a8070',
};

const XTERM_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor:     '#cba6f7',
    ...ANSI_DARK,
  },
  light: {
    background: '#f8f8f8',
    foreground: '#2c2c2c',
    cursor:     '#7c3aed',
    ...ANSI_LIGHT,
  },
  sepia: {
    background: '#f5ede1',
    foreground: '#3d2b1f',
    cursor:     '#c66115',
    ...ANSI_SEPIA,
  },
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface TerminalPanelProps {
  vaultPath: string | null;
  activeFile?: string | null;
  selection?: string;
  theme: Theme;
  position: 'bottom' | 'right';
  size: number;                       // height (bottom) or width (right)
  visible: boolean;
  onSizeChange: (s: number) => void;
  onPositionToggle: () => void;
  onContextUpdate: () => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TerminalPanel({
  vaultPath,
  activeFile,
  selection,
  theme,
  position,
  size,
  visible,
  onSizeChange,
  onPositionToggle,
  onContextUpdate,
  onClose,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitAddonRef  = useRef<FitAddon | null>(null);
  const pidRef       = useRef<number | null>(null);
  const unsubData          = useRef<(() => void) | null>(null);
  const unsubExit          = useRef<(() => void) | null>(null);
  const dragRef            = useRef<{ startCoord: number; startSize: number } | null>(null);
  const onContextUpdateRef = useRef(onContextUpdate);
  const vaultPathRef       = useRef(vaultPath);
  const activeFileRef      = useRef(activeFile);
  const selectionRef       = useRef(selection);

  useEffect(() => { onContextUpdateRef.current = onContextUpdate; });
  useEffect(() => { vaultPathRef.current = vaultPath; });
  useEffect(() => { activeFileRef.current = activeFile; });
  useEffect(() => { selectionRef.current = selection; });

  // ─── Boot terminal (once on mount) ───────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:  "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
      fontSize:    13,
      theme:       XTERM_THEMES[theme] ?? XTERM_THEMES.dark,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current     = term;
    fitAddonRef.current = fitAddon;

    const onFocus = () => onContextUpdateRef.current();
    term.textarea?.addEventListener('focus', onFocus);

    // ── Spawn (or respawn) the shell process ─────────────────────────────
    const spawnPty = async () => {
      const env: Record<string, string> = {};
      const af = activeFileRef.current;
      const sel = selectionRef.current;
      if (af)  env['OBSIDIAN_FILE']      = af;
      if (sel) env['OBSIDIAN_SELECTION'] = sel;

      const pid = await window.terminalApp.create(
        term.cols, term.rows, vaultPathRef.current ?? '/', env,
      );
      pidRef.current = pid;

      // Unsub previous listeners before attaching new ones
      unsubData.current?.();
      unsubExit.current?.();

      unsubData.current = window.terminalApp.onData((p, data) => {
        if (p === pid) term.write(data);
      });
      unsubExit.current = window.terminalApp.onExit((p) => {
        if (p !== pid) return;
        term.writeln('\r\n\x1b[2m[Prozess beendet — beliebige Taste zum Neustart]\x1b[0m');
        pidRef.current = null;

        // One-shot listener: next keypress respawns the shell
        const unsub = term.onData(() => {
          unsub.dispose();
          term.reset();
          spawnPty();
        });
      });
    };

    spawnPty();

    term.onData(data => {
      if (pidRef.current !== null) window.terminalApp.write(pidRef.current, data);
    });

    return () => {
      term.textarea?.removeEventListener('focus', onFocus);
      unsubData.current?.();
      unsubExit.current?.();
      if (pidRef.current !== null) {
        window.terminalApp.kill(pidRef.current);
        pidRef.current = null;
      }
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Live theme updates ───────────────────────────────────────────────────
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = XTERM_THEMES[theme] ?? XTERM_THEMES.dark;
  }, [theme]);

  // ─── Refit on size / visibility / position changes ───────────────────────
  const refit = useCallback(() => {
    requestAnimationFrame(() => {
      if (!fitAddonRef.current || !termRef.current || pidRef.current === null) return;
      fitAddonRef.current.fit();
      window.terminalApp.resize(pidRef.current, termRef.current.cols, termRef.current.rows);
    });
  }, []);

  useEffect(() => { refit(); }, [size, refit]);
  useEffect(() => {
    if (visible) {
      refit();
      requestAnimationFrame(() => termRef.current?.focus());
    }
  }, [visible, refit]);
  useEffect(() => { refit(); }, [position, refit]);

  // ─── ResizeObserver (catches all other size changes) ─────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (!fitAddonRef.current || !termRef.current || pidRef.current === null) return;
      fitAddonRef.current.fit();
      window.terminalApp.resize(pidRef.current, termRef.current.cols, termRef.current.rows);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ─── Drag-to-resize ───────────────────────────────────────────────────────
  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const coord = position === 'bottom' ? e.clientY : e.clientX;
    dragRef.current = { startCoord: coord, startSize: size };

    const onMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = position === 'bottom'
        ? dragRef.current.startCoord - me.clientY   // drag up = grow
        : dragRef.current.startCoord - me.clientX;  // drag left = grow
      const min = position === 'bottom' ? 80  : 200;
      const max = position === 'bottom' ? 800 : 1200;
      onSizeChange(Math.max(min, Math.min(max, dragRef.current.startSize + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  }, [position, size, onSizeChange]);

  const isBottom = position === 'bottom';
  const style    = isBottom
    ? { height: size, display: visible ? undefined : 'none' as const }
    : { width:  size, display: visible ? undefined : 'none' as const };

  return (
    <div className={`terminal-panel terminal-panel--${position}`} style={style}>
      <div
        className={`terminal-resize-handle terminal-resize-handle--${position}`}
        onMouseDown={onHandleMouseDown}
      />
      <div className="terminal-header">
        <span className="terminal-title">Terminal</span>
        {vaultPath && (
          <span className="terminal-cwd">{vaultPath.split('/').pop()}</span>
        )}
        <div className="terminal-header-actions">
          <button
            className="terminal-header-btn"
            title={isBottom ? 'Rechts andocken' : 'Unten andocken'}
            onClick={onPositionToggle}
          >
            {isBottom ? '▶' : '▼'}
          </button>
          <button className="terminal-header-btn" title="Terminal schließen" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div ref={containerRef} className="terminal-container" />
    </div>
  );
}
