import type { TimelineItem } from '../types';
import { TimelineItemCard } from './TimelineItemCard';

interface TimelineListProps {
  items: TimelineItem[];
  selectedMemoryId: number | null;
  onSelectMemory: (id: number) => void;
  emptyMessage: string;
}

export function TimelineList({ items, selectedMemoryId, onSelectMemory, emptyMessage }: TimelineListProps) {
  return (
    <section className="timeline-panel">
      <div className="timeline-panel__header">
        <div>
          <div className="timeline-panel__eyebrow">Timeline</div>
          <h3 className="timeline-panel__title">当天的记忆时间线</h3>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="timeline-empty">
          <h4>这一天还没有新的记忆沉淀</h4>
          <p>{emptyMessage}</p>
        </div>
      ) : (
        <div className="timeline-list">
          {items.map((item) => (
            <TimelineItemCard
              key={item.id}
              item={item}
              selected={selectedMemoryId === item.id}
              onSelect={onSelectMemory}
            />
          ))}
        </div>
      )}
    </section>
  );
}
