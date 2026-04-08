import { useEffect, useState } from 'react';
import type { BacklinkResult } from '../../../shared/ipc';

interface BacklinksPanelProps {
  targetPath: string | null;
  onOpen: (path: string) => void;
}

export default function BacklinksPanel({ targetPath, onOpen }: BacklinksPanelProps) {
  const [results, setResults] = useState<BacklinkResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!targetPath) { setResults([]); return; }
    setLoading(true);
    window.vaultApp.getBacklinks(targetPath)
      .then(setResults)
      .finally(() => setLoading(false));
  }, [targetPath]);

  if (!targetPath) {
    return (
      <div className="backlinks-empty">
        Keine Notiz geöffnet
      </div>
    );
  }

  return (
    <div className="backlinks-panel">
      {loading ? (
        <div className="backlinks-empty">Suche…</div>
      ) : results.length === 0 ? (
        <div className="backlinks-empty">Keine Verknüpfungen gefunden</div>
      ) : (
        <ul className="backlinks-list">
          {results.map((r, i) => (
            <li key={`${r.path}-${i}`} className="backlink-item" onClick={() => onOpen(r.path)}>
              <div className="backlink-name">{r.name}</div>
              <div className="backlink-excerpt">{r.excerpt}</div>
              <div className="backlink-line">Zeile {r.line}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
