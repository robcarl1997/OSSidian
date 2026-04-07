import { useState, useMemo, useEffect, useRef, useCallback } from 'react';

interface Props {
  allPaths: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

function noteName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') ?? path;
}

function noteDir(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.slice(0, -1).join('/');
}

export default function QuickOpen({ allPaths, onOpen, onClose }: Props) {
  const [query, setQuery]           = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return allPaths.slice(0, 30);
    const q = query.toLowerCase();
    return allPaths
      .filter(p => noteName(p).toLowerCase().includes(q) || p.toLowerCase().includes(q))
      .sort((a, b) => {
        const an = noteName(a).toLowerCase();
        const bn = noteName(b).toLowerCase();
        return (an.startsWith(q) ? 0 : 1) - (bn.startsWith(q) ? 0 : 1) || an.localeCompare(bn);
      })
      .slice(0, 50);
  }, [query, allPaths]);

  useEffect(() => { setSelectedIdx(0); }, [results]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const item = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const confirm = useCallback((idx: number) => {
    const path = results[idx];
    if (path) { onOpen(path); onClose(); }
  }, [results, onOpen, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); confirm(selectedIdx); }
    if (e.key === 'Escape')    { onClose(); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="quick-open" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-open-input"
          placeholder="Notiz suchen…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div ref={listRef} className="quick-open-list">
          {results.length === 0 ? (
            <div className="quick-open-empty">Keine Treffer</div>
          ) : results.map((path, i) => (
            <div
              key={path}
              className={`quick-open-item${i === selectedIdx ? ' selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => confirm(i)}
            >
              <span className="quick-open-name">{noteName(path)}</span>
              <span className="quick-open-dir">{noteDir(path)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
