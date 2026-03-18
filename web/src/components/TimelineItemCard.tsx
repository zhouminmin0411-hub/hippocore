import type { TimelineItem } from '../types';
import { presentCopy, presentStateLabel, presentTypeLabel } from '../presenters';

interface TimelineItemCardProps {
  item: TimelineItem;
  selected: boolean;
  onSelect: (id: number) => void;
}

function getExcerpt(item: TimelineItem) {
  return presentCopy(item.displayBody || item.body);
}

function buildNarrative(item: TimelineItem) {
  return presentCopy(item.meaningSummary || item.contextSummary || item.sourceSummary || getExcerpt(item));
}

export function TimelineItemCard({ item, selected, onSelect }: TimelineItemCardProps) {
  return (
    <div className="timeline-entry">
      <div className="timeline-entry__context">
        <div className="timeline-entry__time-row">
          <span className="timeline-entry__time">{item.time || '--:--'}</span>
          <div className="timeline-entry__line" />
        </div>
        <div className="timeline-entry__narrative">{buildNarrative(item)}</div>
      </div>
      <article
        className={`timeline-card${selected ? ' timeline-card--selected' : ''}`}
        onClick={() => onSelect(item.id)}
      >
        <div className="timeline-card__dot" />
        <div className="timeline-card__content">
          <div className="timeline-card__meta">
            <span className={`badge badge--type badge--type-${item.type.toLowerCase()}`}>{presentTypeLabel(item.type)}</span>
            <span className={`badge badge--state badge--state-${item.state}`}>{presentStateLabel(item.state)}</span>
            {item.projectDisplayName ? <span className="badge badge--project">{item.projectDisplayName}</span> : null}
          </div>
          <h4 className="timeline-card__title">{item.title}</h4>
          <p className="timeline-card__excerpt">{getExcerpt(item)}</p>
          <div className="timeline-card__footer">
            <span>{item.source.sourceLabel}</span>
            {item.ownerHint ? <span>{item.ownerHint}</span> : null}
            {item.sourceSummary ? <span>{item.sourceSummary}</span> : null}
          </div>
        </div>
      </article>
    </div>
  );
}
