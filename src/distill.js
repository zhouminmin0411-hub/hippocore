'use strict';

const { sha256 } = require('./hash');

const DECISION_RE = /\b(decide|decided|decision|choose|chose|go with|adopt|selected|approved)\b|决定|决策|选型|采用|结论|拍板/i;
const TASK_PREFIX_RE = /^(todo|to do|action item|follow up|need to|must|next step|fix|retry|investigate|please)\b|^(待办|需要|必须|请|提醒|跟进|修复|补跑|排查|确认)/i;
const TASK_CONTAINS_RE = /\b(todo|to do|action item|follow up|need to|must|next step|fix|retry|investigate)\b|待办|跟进|修复|补跑|排查/i;
const INSIGHT_RE = /\b(insight|takeaway|lesson|pattern|learned|root cause|retrospective)\b|洞察|启发|经验|复盘|根因|发现/i;
const PROJECT_RE = /\b(project|milestone|roadmap|release|sprint|version)\b|项目|里程碑|路线图|版本|发布|迭代/i;
const AREA_RE = /\b(area|domain|ownership|responsibility|focus area|capability)\b|领域|职责|责任域|关注方向|能力域|长期方向/i;
const ENTITY_RE = /\b(with|contact|stakeholder|customer|owner|teammate|assigned to)\b|与.+沟通|和.+讨论|负责人|客户|同学/i;
const EVENT_RE = /\b(error|failed|failure|success|completed|blocked|timeout|429|incident|restart)\b|失败|成功|完成|阻塞|超时|报错|重启|限流/i;

const TYPE_PRIORITY = ['Decision', 'Task', 'Insight', 'Project', 'Area', 'Entity', 'Event'];

const TYPE_LIMITS = {
  Decision: 3,
  Task: 6,
  Insight: 3,
  Project: 3,
  Area: 3,
  Entity: 2,
  Event: 3,
};

const TYPE_META = {
  Decision: { confidence: 0.86, importance: 0.95 },
  Task: { confidence: 0.78, importance: 0.84 },
  Insight: { confidence: 0.74, importance: 0.7 },
  Project: { confidence: 0.68, importance: 0.76 },
  Area: { confidence: 0.72, importance: 0.72 },
  Entity: { confidence: 0.66, importance: 0.64 },
  Event: { confidence: 0.62, importance: 0.52 },
};

function compact(text, limit = 180) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit - 3)}...`;
}

function normalizeForDedup(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLine(text) {
  return String(text || '')
    .replace(/^[-*]\s*(\[[ xX]\])?\s*/, '')
    .replace(/^>\s*/, '')
    .trim();
}

function normalizeStatement(text) {
  let out = cleanLine(text);
  out = out
    .replace(/^(decision|task|insight|project|area|event|entity|todo)\s*[:：-]\s*/i, '')
    .replace(/^(决定|决策|任务|待办|洞察|项目|领域|事件)\s*[:：-]\s*/i, '')
    .trim();
  return compact(out, 260);
}

function isNoise(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (value.length < 10) return true;
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(value)) return true;
  if (/^#{1,6}\s/.test(value)) return true;
  if (/^source file:/i.test(value)) return true;
  if (/^session\s+/i.test(value)) return true;
  if (/^HEARTBEAT_OK$/i.test(value)) return true;
  if (/^conversation info/i.test(value)) return true;
  if (/^current time:/i.test(value)) return true;
  if (/^read heartbeat\.md/i.test(value)) return true;
  if (/^system:\s*\[/i.test(value)) return true;
  if (/^ai_supplement:/i.test(value)) return true;
  if (/^assistant supplemental context/i.test(value)) return true;
  if (/^stderr/i.test(value)) return true;
  return false;
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((raw) => {
      const source = cleanLine(raw);
      const statement = normalizeStatement(raw);
      return { source, statement };
    })
    .filter((item) => !isNoise(item.source) && !isNoise(item.statement));
}

function classifySignals(candidate) {
  const source = candidate.source || '';
  const statement = candidate.statement || '';
  const signals = [];

  if (DECISION_RE.test(source) || DECISION_RE.test(statement)) signals.push('Decision');
  if (/^[-*]\s*\[[ xX]\]/.test(source) || TASK_PREFIX_RE.test(statement) || TASK_CONTAINS_RE.test(source) || TASK_CONTAINS_RE.test(statement)) {
    signals.push('Task');
  }
  if (INSIGHT_RE.test(source) || INSIGHT_RE.test(statement)) signals.push('Insight');
  if (PROJECT_RE.test(source) || PROJECT_RE.test(statement)) signals.push('Project');
  if (AREA_RE.test(source) || AREA_RE.test(statement)) signals.push('Area');
  if (ENTITY_RE.test(source) || ENTITY_RE.test(statement)) signals.push('Entity');
  if (EVENT_RE.test(source) || EVENT_RE.test(statement)) signals.push('Event');

  return Array.from(new Set(signals));
}

function resolveType(signals) {
  if (!signals || !signals.length) return { type: null, weak: true };
  for (const type of TYPE_PRIORITY) {
    if (signals.includes(type)) {
      return { type, weak: signals.length > 1 };
    }
  }
  return { type: null, weak: true };
}

function detectRole(sourcePath) {
  if (!sourcePath) return null;
  if (sourcePath.startsWith('session_end:')) return 'user_session';
  if (!sourcePath.startsWith('session:')) return null;
  return 'user';
}

function relationTypeForStatement(statement) {
  if (/\b(depends on|依赖|受制于|前置)\b/i.test(statement)) return 'depends_on';
  if (/\b(contradict|冲突|相反|不一致)\b/i.test(statement)) return 'contradicts';
  if (/\b(supersede|replace|替代|废弃)\b/i.test(statement)) return 'supersedes';
  if (/\b(derived from|based on|基于|来源于)\b/i.test(statement)) return 'derived_from';
  if (/\b(support|证明|佐证)\b/i.test(statement)) return 'supports';
  return 'related_to';
}

function relationHints(statement, source, type) {
  const hints = [];
  const links = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match = regex.exec(statement);
  while (match) {
    links.push(match[1].trim());
    match = regex.exec(statement);
  }

  const relType = relationTypeForStatement(statement);
  for (const link of links) {
    const targetKey = `note:${normalizeForDedup(link)}`;
    hints.push({ relationType: relType, targetCanonicalKey: targetKey, targetLabel: link, weight: 0.8 });
  }

  if (source.projectId) {
    hints.push({
      relationType: 'belongs_to_project',
      targetCanonicalKey: `project:${normalizeForDedup(source.projectId)}`,
      targetLabel: source.projectId,
      weight: 1.0,
    });
  }

  // Decisions often connect to tasks in same chunk; add weak related relation for composability.
  if (type === 'Decision') {
    hints.push({
      relationType: 'related_to',
      targetCanonicalKey: `project:${normalizeForDedup(source.projectId || 'main')}`,
      targetLabel: source.projectId || 'main',
      weight: 0.5,
    });
  }

  return hints;
}

function mkItem({ type, statement, source, chunk, weak }) {
  const meta = TYPE_META[type] || TYPE_META.Event;
  const normalized = normalizeForDedup(statement);
  const dedupKey = sha256(`${type}|${normalized}`);
  const title = compact(`${type}: ${statement}`, 96);

  let state = source.defaultState || 'candidate';
  const confidence = Math.max(0.3, meta.confidence - (weak ? 0.08 : 0));
  if (confidence < 0.7) {
    state = 'candidate';
  }

  return {
    type,
    title,
    body: statement,
    confidence,
    state,
    status: state === 'archived' ? 'archived' : 'verified',
    importance: meta.importance,
    freshnessTs: source.mtimeMs || Date.now(),
    dedupKey,
    canonicalKey: dedupKey,
    scopeLevel: source.scopeLevel || 'project',
    projectId: source.projectId || null,
    sourceAuthority: Number(source.sourceAuthority || 0.7),
    evidence: {
      sourceType: source.sourceType,
      sourcePath: source.sourcePath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      snippet: compact(statement, 320),
      role: detectRole(source.sourcePath),
    },
    relationHints: relationHints(statement, source, type),
  };
}

function distillChunk({ source, chunk }) {
  const items = [];
  const counts = new Map();
  const seen = new Set();

  const candidates = splitSentences(chunk.text).slice(0, 80);

  for (const candidate of candidates) {
    const signals = classifySignals(candidate);
    const resolved = resolveType(signals);
    const type = resolved.type;
    if (!type) continue;

    const current = counts.get(type) || 0;
    const limit = TYPE_LIMITS[type] || 2;
    if (current >= limit) continue;

    const key = `${type}|${normalizeForDedup(candidate.statement)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push(mkItem({
      type,
      statement: candidate.statement,
      source,
      chunk,
      weak: resolved.weak,
    }));
    counts.set(type, current + 1);
  }

  return items;
}

module.exports = {
  distillChunk,
};
