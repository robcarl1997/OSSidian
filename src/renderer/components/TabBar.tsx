import type { NoteDocument } from '../../../shared/ipc';

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','m4a','aac','wma']);
const VIDEO_EXTS = new Set(['mp4','webm','mov','avi','mkv','wmv']);

interface TabBarProps {
  tabs: NoteDocument[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

function tabIcon(path: string): string {
  if (path === '__graph__') return '';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return '🖼️ ';
  if (ext === 'pdf') return '📋 ';
  if (AUDIO_EXTS.has(ext)) return '🎵 ';
  if (VIDEO_EXTS.has(ext)) return '🎬 ';
  return '';
}

function tabTitle(doc: NoteDocument): string {
  if (doc.path === '__graph__') return 'Graph-Ansicht';
  const parts = doc.path.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1] ?? 'Untitled';
  return filename.replace(/\.md$/, '');
}

export default function TabBar({ tabs, activePath, onActivate, onClose }: TabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map(tab => {
        const isActive = tab.path === activePath;
        return (
          <div
            key={tab.path}
            className={`tab${isActive ? ' tab-active' : ''}`}
            onClick={() => onActivate(tab.path)}
            title={tab.path}
          >
            {tab.dirty && <span className="tab-dirty">•</span>}
            <span className="tab-title">{tabIcon(tab.path)}{tabTitle(tab)}</span>
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
