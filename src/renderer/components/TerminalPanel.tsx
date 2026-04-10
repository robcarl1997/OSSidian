import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
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

// ─── Types ───────────────────────────────────────────────────────────────────

interface TermInstance {
  id: number;
  name: string;
  term: Terminal;
  fitAddon: FitAddon;
  pid: number | null;
  containerEl: HTMLDivElement;
  unsubData: (() => void) | null;
  unsubExit: (() => void) | null;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface TerminalPanelProps {
  vaultPath: string | null;
  activeFile?: string | null;
  selection?: string;
  theme: Theme;
  position: 'bottom' | 'right';
  size: number;
  visible: boolean;
  onSizeChange: (s: number) => void;
  onPositionToggle: () => void;
  onContextUpdate: () => void;
  onClose: () => void;
}

export interface TerminalPanelHandle {
  newTerminal(): void;
  nextTerminal(): void;
  prevTerminal(): void;
  closeTerminal(): void;
}

// ─── Component ────────────────────────────────────────────────────────────────

let nextInstanceId = 1;

const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel({
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
}, ref) {
  const wrapperRef   = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<TermInstance[]>([]);
  const [instances, setInstances]     = useState<{ id: number; name: string }[]>([]);
  const [activeTermId, setActiveTermId] = useState<number | null>(null);
  const dragRef            = useRef<{ startCoord: number; startSize: number } | null>(null);
  const onContextUpdateRef = useRef(onContextUpdate);
  const vaultPathRef       = useRef(vaultPath);
  const activeFileRef      = useRef(activeFile);
  const selectionRef       = useRef(selection);
  const themeRef           = useRef(theme);
  const termCountRef       = useRef(0);

  useEffect(() => { onContextUpdateRef.current = onContextUpdate; });
  useEffect(() => { vaultPathRef.current = vaultPath; });
  useEffect(() => { activeFileRef.current = activeFile; });
  useEffect(() => { selectionRef.current = selection; });
  useEffect(() => { themeRef.current = theme; });

  // ─── Helper: create a terminal instance ──────────────────────────────────

  const createInstance = useCallback((): TermInstance => {
    termCountRef.current += 1;
    const id = nextInstanceId++;
    const name = `Terminal ${termCountRef.current}`;

    const containerEl = document.createElement('div');
    containerEl.className = 'terminal-instance hidden';
    containerEl.setAttribute('data-term-id', String(id));

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:  "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
      fontSize:    13,
      theme:       XTERM_THEMES[themeRef.current] ?? XTERM_THEMES.dark,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const inst: TermInstance = { id, name, term, fitAddon, pid: null, containerEl, unsubData: null, unsubExit: null };
    return inst;
  }, []);

  // ─── Helper: spawn PTY for an instance ──────────────────────────────────

  const spawnPty = useCallback(async (inst: TermInstance) => {
    const env: Record<string, string> = {};
    const af = activeFileRef.current;
    const sel = selectionRef.current;
    if (af)  env['OBSIDIAN_FILE']      = af;
    if (sel) env['OBSIDIAN_SELECTION'] = sel;

    const pid = await window.terminalApp.create(
      inst.term.cols, inst.term.rows, vaultPathRef.current ?? '/', env,
    );
    inst.pid = pid;

    // Clean up previous listeners
    inst.unsubData?.();
    inst.unsubExit?.();

    inst.unsubData = window.terminalApp.onData((p, data) => {
      if (p === pid) inst.term.write(data);
    });
    inst.unsubExit = window.terminalApp.onExit((p) => {
      if (p !== pid) return;
      inst.term.writeln('\r\n\x1b[2m[Prozess beendet \u2014 beliebige Taste zum Neustart]\x1b[0m');
      inst.pid = null;

      const unsub = inst.term.onData(() => {
        unsub.dispose();
        inst.term.reset();
        spawnPty(inst);
      });
    });
  }, []);

  // ─── Helper: destroy a terminal instance ─────────────────────────────────

  const destroyInstance = useCallback((inst: TermInstance) => {
    inst.unsubData?.();
    inst.unsubExit?.();
    if (inst.pid !== null) {
      window.terminalApp.kill(inst.pid);
      inst.pid = null;
    }
    inst.term.dispose();
    inst.containerEl.remove();
  }, []);

  // ─── Helper: activate a terminal ─────────────────────────────────────────

  const activateTerminal = useCallback((id: number) => {
    for (const inst of instancesRef.current) {
      if (inst.id === id) {
        inst.containerEl.classList.remove('hidden');
        requestAnimationFrame(() => {
          inst.fitAddon.fit();
          if (inst.pid !== null) {
            window.terminalApp.resize(inst.pid, inst.term.cols, inst.term.rows);
          }
          inst.term.focus();
        });
      } else {
        inst.containerEl.classList.add('hidden');
      }
    }
    setActiveTermId(id);
  }, []);

  // ─── Boot: create first terminal on mount ────────────────────────────────

  useEffect(() => {
    if (!wrapperRef.current) return;
    const inst = createInstance();
    instancesRef.current = [inst];
    wrapperRef.current.appendChild(inst.containerEl);
    inst.term.open(inst.containerEl);
    inst.fitAddon.fit();

    const onFocus = () => onContextUpdateRef.current();
    inst.term.textarea?.addEventListener('focus', onFocus);

    inst.term.onData(data => {
      if (inst.pid !== null) window.terminalApp.write(inst.pid, data);
    });

    spawnPty(inst);

    inst.containerEl.classList.remove('hidden');
    setInstances([{ id: inst.id, name: inst.name }]);
    setActiveTermId(inst.id);

    return () => {
      for (const i of instancesRef.current) {
        destroyInstance(i);
      }
      instancesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Imperative handle ──────────────────────────────────────────────────

  const newTerminal = useCallback(() => {
    if (!wrapperRef.current) return;
    const inst = createInstance();
    instancesRef.current = [...instancesRef.current, inst];
    wrapperRef.current.appendChild(inst.containerEl);
    inst.term.open(inst.containerEl);

    const onFocus = () => onContextUpdateRef.current();
    inst.term.textarea?.addEventListener('focus', onFocus);

    inst.term.onData(data => {
      if (inst.pid !== null) window.terminalApp.write(inst.pid, data);
    });

    spawnPty(inst);

    setInstances(instancesRef.current.map(i => ({ id: i.id, name: i.name })));
    activateTerminal(inst.id);
  }, [createInstance, spawnPty, activateTerminal]);

  const nextTerminal = useCallback(() => {
    const all = instancesRef.current;
    if (all.length <= 1) return;
    const idx = all.findIndex(i => i.id === activeTermId);
    const next = all[(idx + 1) % all.length];
    activateTerminal(next.id);
  }, [activeTermId, activateTerminal]);

  const prevTerminal = useCallback(() => {
    const all = instancesRef.current;
    if (all.length <= 1) return;
    const idx = all.findIndex(i => i.id === activeTermId);
    const prev = all[(idx - 1 + all.length) % all.length];
    activateTerminal(prev.id);
  }, [activeTermId, activateTerminal]);

  const closeTerminal = useCallback((targetId?: number) => {
    const id = targetId ?? activeTermId;
    if (id === null) return;
    const all = instancesRef.current;
    const idx = all.findIndex(i => i.id === id);
    if (idx === -1) return;

    const inst = all[idx];
    destroyInstance(inst);
    const remaining = all.filter(i => i.id !== id);
    instancesRef.current = remaining;
    setInstances(remaining.map(i => ({ id: i.id, name: i.name })));

    if (remaining.length === 0) {
      setActiveTermId(null);
      onClose();
    } else {
      // Switch to the next or previous tab
      const newIdx = Math.min(idx, remaining.length - 1);
      activateTerminal(remaining[newIdx].id);
    }
  }, [activeTermId, destroyInstance, activateTerminal, onClose]);

  useImperativeHandle(ref, () => ({
    newTerminal,
    nextTerminal,
    prevTerminal,
    closeTerminal: () => closeTerminal(),
  }), [newTerminal, nextTerminal, prevTerminal, closeTerminal]);

  // ─── Live theme updates ───────────────────────────────────────────────────

  useEffect(() => {
    for (const inst of instancesRef.current) {
      inst.term.options.theme = XTERM_THEMES[theme] ?? XTERM_THEMES.dark;
    }
  }, [theme]);

  // ─── Refit on size / visibility / position changes ───────────────────────

  const refitActive = useCallback(() => {
    requestAnimationFrame(() => {
      const inst = instancesRef.current.find(i => i.id === activeTermId);
      if (!inst) return;
      inst.fitAddon.fit();
      if (inst.pid !== null) {
        window.terminalApp.resize(inst.pid, inst.term.cols, inst.term.rows);
      }
    });
  }, [activeTermId]);

  useEffect(() => { refitActive(); }, [size, refitActive]);
  useEffect(() => {
    if (visible) {
      refitActive();
      requestAnimationFrame(() => {
        const inst = instancesRef.current.find(i => i.id === activeTermId);
        inst?.term.focus();
      });
    }
  }, [visible, refitActive, activeTermId]);
  useEffect(() => { refitActive(); }, [position, refitActive]);

  // ─── ResizeObserver ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver(() => {
      const inst = instancesRef.current.find(i => i.id === activeTermId);
      if (!inst) return;
      inst.fitAddon.fit();
      if (inst.pid !== null) {
        window.terminalApp.resize(inst.pid, inst.term.cols, inst.term.rows);
      }
    });
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, [activeTermId]);

  // ─── Drag-to-resize ───────────────────────────────────────────────────────

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const coord = position === 'bottom' ? e.clientY : e.clientX;
    dragRef.current = { startCoord: coord, startSize: size };

    const onMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = position === 'bottom'
        ? dragRef.current.startCoord - me.clientY
        : dragRef.current.startCoord - me.clientX;
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
        <div className="terminal-tabs">
          {instances.map(inst => (
            <button
              key={inst.id}
              className={`terminal-tab${inst.id === activeTermId ? ' active' : ''}`}
              onClick={() => activateTerminal(inst.id)}
            >
              <span className="terminal-tab-label">{inst.name}</span>
              <span
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTerminal(inst.id); }}
                title="Terminal schlie\u00dfen"
              >
                {'\u00d7'}
              </span>
            </button>
          ))}
        </div>
        <div className="terminal-header-actions">
          <button
            className="terminal-new-btn"
            title="Neues Terminal"
            onClick={newTerminal}
          >
            +
          </button>
          <button
            className="terminal-header-btn"
            title={isBottom ? 'Rechts andocken' : 'Unten andocken'}
            onClick={onPositionToggle}
          >
            {isBottom ? '\u25b6' : '\u25bc'}
          </button>
          <button className="terminal-header-btn" title="Alle Terminals schlie\u00dfen" onClick={onClose}>
            {'\u2715'}
          </button>
        </div>
      </div>
      <div ref={wrapperRef} className="terminal-instances-wrapper" />
    </div>
  );
});

export default TerminalPanel;
