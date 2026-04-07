import { useEffect, useRef } from 'react';
import type { SlashCommand } from './slashCommands';

interface Props {
  x: number;
  y: number;
  commands: SlashCommand[];
  selectedIdx: number;
  onSelect: (cmd: SlashCommand) => void;
}

export default function SlashCommandMenu({ x, y, commands, selectedIdx, onSelect }: Props) {
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  if (commands.length === 0) return null;

  // Collect groups in order of first appearance
  const groups: string[] = [];
  for (const c of commands) {
    if (!groups.includes(c.group)) groups.push(c.group);
  }

  return (
    <div
      className="slash-menu"
      style={{ position: 'fixed', left: x, top: y + 6 }}
      // Prevent click from stealing focus from the editor
      onMouseDown={e => e.preventDefault()}
    >
      {groups.map(group => (
        <div key={group}>
          <div className="slash-menu-group">{group}</div>
          {commands.filter(c => c.group === group).map(cmd => {
            const idx = commands.indexOf(cmd);
            const selected = idx === selectedIdx;
            return (
              <div
                key={cmd.id}
                ref={selected ? selectedRef : undefined}
                className={`slash-menu-item${selected ? ' selected' : ''}`}
                onMouseDown={() => onSelect(cmd)}
              >
                <span className="slash-menu-icon">{cmd.icon}</span>
                <span className="slash-menu-label">{cmd.label}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
