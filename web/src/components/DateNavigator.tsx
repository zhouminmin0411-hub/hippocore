interface DateNavigatorProps {
  value: string;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onRefresh: () => void;
}

function formatDateLabel(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(date);
}

export function DateNavigator({ value, onPrevious, onNext, onToday, onRefresh }: DateNavigatorProps) {
  const date = new Date(`${value}T00:00:00`);
  const dayName = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date);

  return (
    <section className="page-hero">
      <header className="page-hero__topbar">
        <div className="page-hero__brand">HIPPOCORE</div>
        <button className="ghost-button ghost-button--soft" onClick={onRefresh}>刷新</button>
      </header>
      <div className="page-hero__content">
        <div>
          <div className="page-hero__dayname">{dayName}</div>
          <h1 className="page-hero__title">{formatDateLabel(value)}</h1>
          <p className="page-hero__subtitle">
            以一天为单位阅读 hippocore 捕捉到的记忆沉淀，先看今天发生了什么，再顺着时间线往下读。
          </p>
        </div>
        <div className="date-switcher">
          <button className="ghost-button ghost-button--compact" onClick={onPrevious}>上一天</button>
          <button className="ghost-button ghost-button--compact ghost-button--current" onClick={onToday}>今天</button>
          <button className="ghost-button ghost-button--compact" onClick={onNext}>下一天</button>
        </div>
      </div>
      <div className="page-hero__datecode">{value}</div>
    </section>
  );
}
