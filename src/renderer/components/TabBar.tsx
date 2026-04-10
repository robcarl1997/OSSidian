import type { NoteDocument } from '../../../shared/ipc';

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','m4a','aac','wma']);
const VIDEO_EXTS = new Set(['mp4','webm','mov','avi','mkv','wmv']);

interface TabBarProps {
  tabs: NoteDocument[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  bookmarks?: string[];
  onToggleBookmark?: (path: string) => void;
}

function tabIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return '🖼️ ';
  if (ext === 'pdf') return '📋 ';
  if (AUDIO_EXTS.has(ext)) return '🎵 ';
  if (VIDEO_EXTS.has(ext)) return '🎬 ';
  return '';
}

function tabTitle(doc: NoteDocument): string {
  const parts = doc.path.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1] ?? 'Untitled';
  return filename.replace(/\.md$/, '');
}

export default function TabBar({ tabs, activePath, onActivate, onClose, bookmarks, onToggleBookmark }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map(tab => {
        const isActive = tab.path === activePath;
        const isBookmarked = bookmarks?.includes(tab.path) ?? false;
        return (
          <div
            key={tab.path}
            className={`tab${isActive ? ' tab-active' : ''}`}
            onClick={() => onActivate(tab.path)}
            title={tab.path}
          >
            {tab.dirty && <span className="tab-dirty">•</span>}
            <span className="tab-title">{tabIcon(tab.path)}{tabTitle(tab)}</span>
            {onToggleBookmark && (
              <button
                className={`tab-bookmark-btn${isBookmarked ? ' bookmarked' : ''}`}
                onClick={e => { e.stopPropagation(); onToggleBookmark(tab.path); }}
                title={isBookmarked ? 'Lesezeichen entfernen' : 'Lesezeichen hinzufügen'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill={isBookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
            )}
            <button
              className="tab-close"
              onClick={e => { e.stopPropagation(); onClose(tab.path); }}
              title="Tab schließen"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
