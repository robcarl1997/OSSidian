import type { NoteDocument } from '../../../shared/ipc';

interface TabBarProps {
  tabs: NoteDocument[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

function tabTitle(doc: NoteDocument): string {
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
            <span className="tab-title">{tabTitle(tab)}</span>
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
