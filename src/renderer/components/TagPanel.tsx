import { useEffect, useState, useMemo } from 'react';
import type { TagInfo } from '../../../shared/ipc';

interface TagPanelProps {
  onOpenNote: (path: string) => void;
  refreshTrigger?: number;
}

export default function TagPanel({ onOpenNote, refreshTrigger }: TagPanelProps) {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedTag, setExpandedTag] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    window.vaultApp.getAllTags()
      .then(setTags)
      .finally(() => setLoading(false));
  }, [refreshTrigger]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return tags;
    const q = filter.toLowerCase();
    return tags.filter(t => t.tag.toLowerCase().includes(q));
  }, [tags, filter]);

  const handleTagClick = (tag: string) => {
    setExpandedTag(prev => prev === tag ? null : tag);
  };

  const fileBasename = (filePath: string) => {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return (parts[parts.length - 1] ?? '').replace(/\.md$/, '');
  };

  if (loading && tags.length === 0) {
    return (
      <div className="tag-panel">
        <div className="tag-panel-empty">Lade Tags...</div>
      </div>
    );
  }

  return (
    <div className="tag-panel">
      <div className="tag-panel-search">
        <input
          type="text"
          placeholder="Tags filtern..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      <div className="tag-panel-list">
        {filtered.length === 0 ? (
          <div className="tag-panel-empty">Keine Tags gefunden</div>
        ) : (
          filtered.map(t => (
            <div key={t.tag}>
              <button
                className={`tag-item${expandedTag === t.tag ? ' expanded' : ''}`}
                onClick={() => handleTagClick(t.tag)}
              >
                <span className="tag-item-name">#{t.tag}</span>
                <span className="tag-item-count">{t.count}</span>
              </button>

              {expandedTag === t.tag && (
                <div className="tag-files">
                  {t.files.map(f => (
                    <button
                      key={f}
                      className="tag-file-item"
                      onClick={() => onOpenNote(f)}
                    >
                      {fileBasename(f)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
