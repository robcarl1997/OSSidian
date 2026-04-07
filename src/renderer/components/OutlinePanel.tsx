import type { HeadingRef } from '../../../shared/ipc';

interface Props {
  headings: HeadingRef[];
  onJumpTo: (slug: string) => void;
}

export default function OutlinePanel({ headings, onJumpTo }: Props) {
  return (
    <aside className="outline-panel">
      <div className="outline-header">Outline</div>
      <div className="outline-list">
        {headings.length === 0 ? (
          <div className="outline-empty">Keine Überschriften</div>
        ) : headings.map((h, i) => (
          <button
            key={i}
            className="outline-item"
            style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
            onClick={() => onJumpTo(h.slug)}
          >
            {h.text}
          </button>
        ))}
      </div>
    </aside>
  );
}
