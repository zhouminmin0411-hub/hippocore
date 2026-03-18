import { useEffect, useMemo, useState } from 'react';
import { fetchHealth, fetchMemoryDetail, fetchOverview, fetchTimeline } from './api';
import { DashboardShell } from './components/DashboardShell';
import { DateNavigator } from './components/DateNavigator';
import { MemoryDetailDrawer } from './components/MemoryDetailDrawer';
import { OverviewCards } from './components/OverviewCards';
import { TimelineList } from './components/TimelineList';
import { presentStateLabel } from './presenters';
import type { UiHealthResponse, UiMemoryDetailResponse, UiOverviewResponse, UiTimelineResponse } from './types';

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function readInitialDate() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('date');
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return todayString();
  return value;
}

function shiftDate(dateString: string, offsetDays: number) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function App() {
  const [selectedDate, setSelectedDate] = useState(readInitialDate);
  const [selectedState, setSelectedState] = useState('all');
  const [selectedMemoryId, setSelectedMemoryId] = useState<number | null>(null);
  const [health, setHealth] = useState<UiHealthResponse | null>(null);
  const [overview, setOverview] = useState<UiOverviewResponse | null>(null);
  const [timeline, setTimeline] = useState<UiTimelineResponse | null>(null);
  const [detail, setDetail] = useState<UiMemoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refreshSeed, setRefreshSeed] = useState(0);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('date', selectedDate);
    window.history.replaceState({}, '', url);
  }, [selectedDate]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    Promise.all([
      fetchHealth(),
      fetchOverview(selectedDate, 7),
      fetchTimeline(selectedDate, selectedState, []),
    ])
      .then(([nextHealth, nextOverview, nextTimeline]) => {
        if (!active) return;
        setHealth(nextHealth);
        setOverview(nextOverview);
        setTimeline(nextTimeline);
        if (selectedMemoryId && !nextTimeline.items.some((item) => item.id === selectedMemoryId)) {
          setSelectedMemoryId(null);
          setDetail(null);
        }
      })
      .catch((err: Error) => {
        if (!active) return;
        setError(err.message || '加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedDate, selectedState, refreshSeed]);

  useEffect(() => {
    if (!selectedMemoryId) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    let active = true;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);

    fetchMemoryDetail(selectedMemoryId)
      .then((nextDetail) => {
        if (active) setDetail(nextDetail);
      })
      .catch((err: Error) => {
        if (active) setDetailError(err.message || '详情加载失败');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedMemoryId]);

  const totalMemoryCount = health?.memoryItemCount ?? 0;
  const hasAnyMemory = totalMemoryCount > 0;
  const timelineItems = timeline?.items ?? [];
  const emptyMessage = useMemo(() => (
    loading ? '正在加载时间线...' : '可以切换到其他日期，或者完成一次 sync 后再回来刷新。'
  ), [loading]);

  return (
    <>
      <DashboardShell
        header={(
          <DateNavigator
            value={selectedDate}
            onPrevious={() => setSelectedDate((current) => shiftDate(current, -1))}
            onNext={() => setSelectedDate((current) => shiftDate(current, 1))}
            onToday={() => setSelectedDate(todayString())}
            onRefresh={() => setRefreshSeed((value) => value + 1)}
          />
        )}
        summary={<OverviewCards overview={overview} health={health} />}
        filters={(
          <div className="filters-row">
            <div className="filters-row__group">
              {['all', 'candidate', 'verified', 'archived'].map((state) => (
                <button
                  key={state}
                  type="button"
                  className={`filter-chip${selectedState === state ? ' filter-chip--active' : ''}`}
                  onClick={() => setSelectedState(state)}
                >
                  {presentStateLabel(state)}
                </button>
              ))}
            </div>
            <div className="filters-row__hint">
              {health?.dbReady ? `当前共 ${totalMemoryCount} 条 memory` : '正在连接 hippocore'}
            </div>
          </div>
        )}
        timeline={(
          <>
            {error ? <div className="banner banner--error">{error}</div> : null}
            {!hasAnyMemory && !loading ? (
              <section className="panel-card panel-card--empty-state">
                <div className="panel-card__eyebrow">Getting started</div>
                <h3 className="panel-card__title">还没有可展示的 memory</h3>
                <p>先运行 `hippocore sync` 或结束一次会话，页面就会开始出现时间线数据。</p>
              </section>
            ) : null}
            <TimelineList
              items={timelineItems}
              selectedMemoryId={selectedMemoryId}
              onSelectMemory={setSelectedMemoryId}
              emptyMessage={emptyMessage}
            />
          </>
        )}
      />
      <MemoryDetailDrawer
        detail={detail}
        loading={detailLoading}
        error={detailError}
        open={selectedMemoryId !== null}
        onClose={() => setSelectedMemoryId(null)}
      />
    </>
  );
}
