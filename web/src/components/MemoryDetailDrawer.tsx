import type { UiMemoryDetailResponse } from '../types';
import { presentCopy, presentStateLabel, presentTypeLabel } from '../presenters';

interface MemoryDetailDrawerProps {
  detail: UiMemoryDetailResponse | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  onClose: () => void;
}

function InfoBlock({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <section className="detail-block">
      <div className="detail-block__label">{label}</div>
      <div className="detail-block__value">{presentCopy(value)}</div>
    </section>
  );
}

export function MemoryDetailDrawer({ detail, loading, error, open, onClose }: MemoryDetailDrawerProps) {
  return (
    <div className={`detail-drawer${open ? ' detail-drawer--open' : ''}`}>
      <div className="detail-drawer__backdrop" onClick={onClose} />
      <div className="detail-drawer__panel">
        <div className="detail-drawer__header">
          <div>
            <div className="detail-drawer__eyebrow">Memory detail</div>
            <h3>{detail?.item.title || '选择一条 memory 查看详情'}</h3>
          </div>
          <button className="ghost-button ghost-button--soft" onClick={onClose}>关闭</button>
        </div>
        {loading ? <div className="detail-drawer__state">正在加载详情...</div> : null}
        {error ? <div className="detail-drawer__state detail-drawer__state--error">{error}</div> : null}
        {!loading && !error && detail ? (
          <div className="detail-drawer__content">
            <div className="detail-drawer__chips">
              <span className="badge badge--type">{presentTypeLabel(detail.item.type)}</span>
              <span className={`badge badge--state badge--state-${detail.item.state}`}>{presentStateLabel(detail.item.state)}</span>
              {detail.item.projectDisplayName ? <span className="badge badge--project">{detail.item.projectDisplayName}</span> : null}
            </div>
            <section className="detail-summary">
              <div>
                <div className="detail-block__label">创建时间</div>
                <div className="detail-summary__value">{detail.item.createdAt || '--'}</div>
              </div>
              <div>
                <div className="detail-block__label">更新时间</div>
                <div className="detail-summary__value">{detail.item.updatedAt || '--'}</div>
              </div>
              <div>
                <div className="detail-block__label">项目</div>
                <div className="detail-summary__value">{detail.item.projectDisplayName || detail.item.projectId || '--'}</div>
              </div>
            </section>
            <InfoBlock label="完整正文" value={detail.item.body} />
            <InfoBlock label="Context Summary" value={detail.item.contextSummary} />
            <InfoBlock label="Meaning Summary" value={detail.item.meaningSummary} />
            <InfoBlock label="Actionability Summary" value={detail.item.actionabilitySummary} />
            <InfoBlock label="Next Action" value={detail.item.nextAction} />
            <InfoBlock label="Owner Hint" value={detail.item.ownerHint} />
            <InfoBlock label="来源类型" value={detail.item.source.sourceLabel} />
            <InfoBlock label="来源路径" value={detail.item.source.sourceDecisionPath} />

            <section className="detail-block">
              <div className="detail-block__label">Evidence</div>
              <div className="detail-list">
                {detail.item.evidence.length === 0 ? <p className="detail-muted">暂无 evidence。</p> : null}
                {detail.item.evidence.map((evidence) => (
                  <article key={evidence.id} className="detail-list__item">
                    <div className="detail-list__meta">
                      <span>{evidence.sourceLabel}</span>
                      {evidence.sourceUrl ? (
                        <a href={evidence.sourceUrl} target="_blank" rel="noreferrer">Open source</a>
                      ) : null}
                    </div>
                    <div className="detail-list__path">{evidence.sourceDecisionPath}</div>
                    <p>{presentCopy(evidence.snippet)}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="detail-block">
              <div className="detail-block__label">Relations</div>
              <div className="relation-columns">
                <div>
                  <h4>Outgoing</h4>
                  {detail.item.relations.outgoing.length === 0 ? <p className="detail-muted">暂无 outgoing relation。</p> : null}
                  {detail.item.relations.outgoing.map((relation) => (
                    <div key={`out-${relation.targetId}-${relation.relationType}`} className="relation-item">
                      <strong>{relation.relationType}</strong>
                      <span>{relation.targetType} / {relation.targetTitle}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <h4>Incoming</h4>
                  {detail.item.relations.incoming.length === 0 ? <p className="detail-muted">暂无 incoming relation。</p> : null}
                  {detail.item.relations.incoming.map((relation) => (
                    <div key={`in-${relation.targetId}-${relation.relationType}`} className="relation-item">
                      <strong>{relation.relationType}</strong>
                      <span>{relation.targetType} / {relation.targetTitle}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
