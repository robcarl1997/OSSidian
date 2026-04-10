interface BookmarksPanelProps {
  bookmarks: string[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}

function displayName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1] ?? 'Untitled';
  return filename.replace(/\.md$/, '');
}

export default function BookmarksPanel({ bookmarks, activePath, onOpen, onRemove }: BookmarksPanelProps) {
  if (bookmarks.length === 0) {
    return (
      <div className="bookmarks-empty">
        Keine Lesezeichen vorhanden
      </div>
    );
  }

  return (
    <div className="bookmarks-panel">
      <ul className="bookmarks-list">
        {bookmarks.map(path => (
          <li
            key={path}
            className={`bookmarks-item${path === activePath ? ' active' : ''}`}
            onClick={() => onOpen(path)}
            title={path}
          >
            <span className="bookmarks-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </span>
            <span className="bookmarks-name">{displayName(path)}</span>
            <button
              className="bookmarks-remove"
              onClick={e => { e.stopPropagation(); onRemove(path); }}
              title="Lesezeichen entfernen"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
