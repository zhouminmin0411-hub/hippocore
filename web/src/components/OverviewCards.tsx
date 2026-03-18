import type { UiHealthResponse, UiOverviewResponse } from '../types';
import { presentTypeLabel } from '../presenters';

interface OverviewCardsProps {
  overview: UiOverviewResponse | null;
  health: UiHealthResponse | null;
}

function formatTime(value: string | null) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function OverviewCards({ overview, health }: OverviewCardsProps) {
  const summary = overview?.summary;
  const sortedTypes = Object.entries(summary?.byType ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const typeSummary = sortedTypes.map(([type, count]) => `${count} 条 ${presentTypeLabel(type)}`).join('、');
  const story = summary?.dayTotal
    ? `今天共沉淀了 ${summary.dayTotal} 条 memory。${typeSummary ? `主要集中在 ${typeSummary}。` : ''}`
    : '今天还没有新的 memory 沉淀。';

  return (
    <section className="memory-summary">
      <div className="memory-summary__spark">✦</div>
      <div className="memory-summary__content">
        <div className="memory-summary__eyebrow">AI 记忆摘要</div>
        <h2>{story}</h2>
        <p>
          {summary?.dayTotal
            ? '你可以沿着下面的时间线继续往下读，查看它们是如何被记录下来的、属于什么类型，以及目前停留在哪个状态。'
            : '如果你刚完成一次同步或刚结束一段对话，点击 Refresh 重新拉取即可。'}
        </p>
        <dl className="memory-summary__meta">
          <div>
            <dt>今日新增</dt>
            <dd>{summary?.dayTotal ?? 0}</dd>
          </div>
          <div>
            <dt>候选</dt>
            <dd>{summary?.candidateCount ?? 0}</dd>
          </div>
          <div>
            <dt>已确认</dt>
            <dd>{summary?.verifiedCount ?? 0}</dd>
          </div>
          <div>
            <dt>已归档</dt>
            <dd>{summary?.archivedCount ?? 0}</dd>
          </div>
          <div>
            <dt>最新 memory</dt>
            <dd>{formatTime(summary?.latestMemoryAt ?? health?.latestMemoryAt ?? null)}</dd>
          </div>
          <div>
            <dt>最近同步</dt>
            <dd>{formatTime(summary?.latestSyncAt ?? health?.latestSyncAt ?? null)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
