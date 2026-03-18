interface TrendStripProps {
  selectedDate: string;
  trend: Array<{ date: string; count: number }>;
  onSelectDate: (date: string) => void;
}

export function TrendStrip({ selectedDate, trend, onSelectDate }: TrendStripProps) {
  const max = Math.max(1, ...trend.map((item) => item.count));

  return (
    <section className="panel-card">
      <div className="panel-card__header">
        <div>
          <div className="panel-card__eyebrow">Recent activity</div>
          <h3 className="panel-card__title">最近 7 天记忆趋势</h3>
        </div>
      </div>
      <div className="trend-strip">
        {trend.map((item) => {
          const active = item.date === selectedDate;
          const height = `${Math.max(12, (item.count / max) * 100)}%`;
          return (
            <button
              key={item.date}
              type="button"
              className={`trend-strip__item${active ? ' trend-strip__item--active' : ''}`}
              onClick={() => onSelectDate(item.date)}
            >
              <span className="trend-strip__bar" style={{ height }} />
              <span className="trend-strip__count">{item.count}</span>
              <span className="trend-strip__date">{item.date.slice(5)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
