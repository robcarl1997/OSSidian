import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { AppAction, AppKeybinding } from '../../../shared/ipc';

interface CommandEntry {
  label: string;
  action: AppAction;
  shortcut?: string;
}

/** All commands exposed in the palette with German labels */
const COMMANDS: CommandEntry[] = [
  { label: 'Schnellöffner',              action: 'quickOpen' },
  { label: 'Seitenleiste ein/ausblenden', action: 'toggleSidebar' },
  { label: 'Gliederung ein/ausblenden',   action: 'toggleOutline' },
  { label: 'Nächster Tab',               action: 'tabNext' },
  { label: 'Vorheriger Tab',             action: 'tabPrev' },
  { label: 'Tab schließen',              action: 'tabClose' },
  { label: 'Zurück springen',            action: 'jumpBack' },
  { label: 'Neue Notiz',                 action: 'newNote' },
  { label: 'Einstellungen öffnen',       action: 'openSettings' },
  { label: 'Terminal ein/ausblenden',     action: 'toggleTerminal' },
  { label: 'Dateibaum fokussieren',      action: 'focusFileTree' },
  { label: 'Git-Panel fokussieren',      action: 'focusGit' },
  { label: 'Backlinks fokussieren',      action: 'focusBacklinks' },
  { label: 'Geteilte Ansicht',           action: 'splitPane' },
  { label: 'Befehlspalette',             action: 'commandPalette' },
];

interface Props {
  keybindings: AppKeybinding[];
  onExecute: (action: AppAction) => void;
  onClose: () => void;
}

/** Simple fuzzy match: all query chars must appear in order in the target */
function fuzzyMatch(query: string, target: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Substring match gets best score
  if (t.includes(q)) {
    const idx = t.indexOf(q);
    return { match: true, score: idx === 0 ? 0 : 1 };
  }

  // Character-by-character fuzzy match
  let qi = 0;
  let lastMatchIdx = -1;
  let gaps = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (lastMatchIdx >= 0 && ti - lastMatchIdx > 1) gaps++;
      lastMatchIdx = ti;
      qi++;
    }
  }

  if (qi === q.length) {
    return { match: true, score: 2 + gaps };
  }

  return { match: false, score: Infinity };
}

export default function CommandPalette({ keybindings, onExecute, onClose }: Props) {
  const [query, setQuery]             = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLDivElement>(null);

  // Build shortcut lookup from keybindings
  const shortcutMap = useMemo(() => {
    const map = new Map<AppAction, string>();
    for (const kb of keybindings) {
      if (!map.has(kb.action)) {
        map.set(kb.action, kb.key);
      }
    }
    return map;
  }, [keybindings]);

  const commands = useMemo<CommandEntry[]>(() => {
    return COMMANDS.map(cmd => ({
      ...cmd,
      shortcut: shortcutMap.get(cmd.action),
    }));
  }, [shortcutMap]);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map(cmd => ({ cmd, ...fuzzyMatch(query, cmd.label) }))
      .filter(r => r.match)
      .sort((a, b) => a.score - b.score)
      .map(r => r.cmd);
  }, [query, commands]);

  useEffect(() => { setSelectedIdx(0); }, [results]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const item = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const confirm = useCallback((idx: number) => {
    const cmd = results[idx];
    if (cmd) {
      onClose();
      onExecute(cmd.action);
    }
  }, [results, onExecute, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'j') || (e.ctrlKey && e.key === 'n');
    const isUp   = e.key === 'ArrowUp'   || (e.ctrlKey && e.key === 'k') || (e.ctrlKey && e.key === 'p');
    if (isDown)            { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)); }
    if (isUp)              { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); confirm(selectedIdx); }
    if (e.key === 'Escape') { onClose(); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Befehl eingeben\u2026"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div ref={listRef} className="command-palette-list">
          {results.length === 0 ? (
            <div className="command-palette-empty">Keine Befehle gefunden</div>
          ) : results.map((cmd, i) => (
            <div
              key={cmd.action}
              className={`command-palette-item${i === selectedIdx ? ' selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => confirm(i)}
            >
              <span className="command-palette-label">{cmd.label}</span>
              {cmd.shortcut && (
                <span className="command-palette-shortcut">{cmd.shortcut}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
