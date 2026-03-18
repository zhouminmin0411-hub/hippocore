interface TypeBreakdownProps {
  byType: Record<string, number>;
  selectedTypes: string[];
  onToggleType: (type: string) => void;
}

export function TypeBreakdown({ byType, selectedTypes, onToggleType }: TypeBreakdownProps) {
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return (
    <section className="panel-card">
      <div className="panel-card__header">
        <div>
          <div className="panel-card__eyebrow">Type breakdown</div>
          <h3 className="panel-card__title">当天的记忆类型</h3>
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="panel-card__empty">这一天还没有类型分布数据。</div>
      ) : (
        <div className="type-breakdown">
          {entries.map(([type, count]) => {
            const active = selectedTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                className={`type-pill${active ? ' type-pill--active' : ''}`}
                onClick={() => onToggleType(type)}
              >
                <span>{type}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
