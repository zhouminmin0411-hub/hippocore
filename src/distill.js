'use strict';

const { sha256 } = require('./hash');
const { buildReadableTitle } = require('./card');

const DECISION_RE = /\b(decide|decided|decision|choose|chose|go with|adopt|selected|approved)\b|决定|决策|选型|采用|结论|拍板/i;
const TASK_PREFIX_RE = /^(todo|to do|action item|follow up|need to|must|next step|fix|retry|investigate|please)\b|^(待办|需要|必须|请|提醒|跟进|修复|补跑|排查|确认)/i;
const TASK_CONTAINS_RE = /\b(todo|to do|action item|follow up|need to|must|next step|fix|retry|investigate)\b|待办|跟进|修复|补跑|排查/i;
const INSIGHT_RE = /\b(insight|takeaway|lesson|pattern|learned|root cause|retrospective)\b|洞察|启发|经验|复盘|根因|发现/i;
const PROJECT_RE = /\b(project|milestone|roadmap|release|sprint|version)\b|项目|里程碑|路线图|版本|发布|迭代/i;
const AREA_RE = /\b(area|domain|ownership|responsibility|focus area|capability)\b|领域|职责|责任域|关注方向|能力域|长期方向/i;
const ENTITY_RE = /\b(with|contact|stakeholder|customer|owner|teammate|assigned to)\b|与.+沟通|和.+讨论|负责人|客户|同学/i;
const EVENT_RE = /\b(error|failed|failure|success|completed|blocked|timeout|429|incident|restart)\b|失败|成功|完成|阻塞|超时|报错|重启|限流/i;
const IDEA_RE = /\b(idea|brainstorm|concept|proposal|hypothesis|vision|ssot)\b|灵感|想法|构想|设想|方案|思路|单一真相源|收口|闭环/i;
const OPEN_QUESTION_RE = /\?|？|\b(should|whether|open question|tbd|to be decided)\b|是否|要不要|还是|待确认|待定|我来判断/i;
const UNCERTAIN_TASK_RE = /\b(no clear time|unscheduled|defer)\b|无明确时间|时间未定|暂不确定|稍后再定/i;
const PROCESS_NOISE_RE = /\b(execut(e|ing|ed)|running|command|stdout|stderr|exit code|tool call|api call|script output|traceback)\b|执行命令|命令输出|工具调用|脚本输出|调用接口/i;
const REPORT_NOISE_RE = /^(status|progress|summary|update)\s*[:：]/i;
const COMMITMENT_NOISE_RE = /^(i will|i can|i am going to|let me|我会|我将|我准备|接下来我会|正在处理)/i;

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

const DEFAULT_TYPE_WHITELIST = ['Decision', 'Task', 'Insight', 'Area'];
const DEFAULT_MIN_CONFIDENCE = 0.72;

function compact(text, limit = 180) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, limit - 3)}...`;
}

function normalizeForDedup(text) {
  let out = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const rolePrefix = /^(?:user|assistant|ai_supplement|ai supplement|ai|system|用户|助手|系统)\s*[:：-]\s*/i;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(rolePrefix, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function cleanLine(text) {
  return String(text || '')
    .replace(/^[-*]\s*(\[[ xX]\])?\s*/, '')
    .replace(/^>\s*/, '')
    .trim();
}

function normalizeStatement(text) {
  let out = cleanLine(text);
  const rolePrefix = /^(?:user|assistant|ai_supplement|ai supplement|ai|system|用户|助手|系统)\s*[:：-]\s*/i;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(rolePrefix, '').trim();
    if (next === out) break;
    out = next;
  }
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
  if (PROCESS_NOISE_RE.test(value)) return true;
  if (REPORT_NOISE_RE.test(value)) return true;
  if (COMMITMENT_NOISE_RE.test(value)) return true;
  return false;
}

function updateHeadingStack(stack, rawHeadingLine) {
  const hit = /^#{1,6}\s+(.+)$/.exec(String(rawHeadingLine || '').trim());
  if (!hit) return stack;
  const level = Math.max(1, String(rawHeadingLine).trim().match(/^#{1,6}/)[0].length);
  const heading = cleanLine(hit[1]);
  if (!heading) return stack;
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(heading)) return stack;
  const next = stack.slice(0, Math.max(0, level - 1));
  next.push(compact(heading, 72));
  return next;
}

function parseSectionLabel(line) {
  const value = cleanLine(line);
  const hit = /^([^:：]{2,48})[:：]\s*$/.exec(value);
  if (!hit || !hit[1]) return '';
  return compact(hit[1], 48);
}

function buildContextPrefix(headingStack, sectionLabel) {
  const parts = [];
  if (Array.isArray(headingStack) && headingStack.length) {
    parts.push(headingStack.join(' / '));
  }
  if (sectionLabel) parts.push(sectionLabel);
  return parts.join(' / ');
}

function shouldAttachContext(statement, contextPrefix, sourceType) {
  if (String(sourceType || '').toLowerCase() !== 'notion') return false;
  if (!statement || !contextPrefix) return false;
  const statementNorm = normalizeForDedup(statement);
  const contextNorm = normalizeForDedup(contextPrefix);
  if (contextNorm && statementNorm.includes(contextNorm)) return false;
  if (OPEN_QUESTION_RE.test(statement) || UNCERTAIN_TASK_RE.test(statement)) return true;
  if (/^(待办|无明确时间|跟进|追踪|提醒|需要|请|方案|策略)/.test(statement)) return true;
  if (statement.length <= 56) return true;
  return false;
}

function contextualizeStatement(statement, contextPrefix, sourceType) {
  if (!shouldAttachContext(statement, contextPrefix, sourceType)) return statement;
  return compact(`${contextPrefix}: ${statement}`, 260);
}

function splitSentences(text, { sourceType = null } = {}) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let headingStack = [];
  let sectionLabel = '';

  for (const rawLine of lines) {
    const trimmed = String(rawLine || '').trim();
    if (!trimmed) {
      sectionLabel = '';
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      headingStack = updateHeadingStack(headingStack, trimmed);
      sectionLabel = '';
      continue;
    }

    const source = cleanLine(rawLine);
    if (!source) continue;

    const label = parseSectionLabel(source);
    if (label) {
      sectionLabel = label;
      continue;
    }

    const contextPrefix = buildContextPrefix(headingStack, sectionLabel);
    const parts = source
      .split(/(?<=[.!?。！？])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      const rawStatement = normalizeStatement(part);
      if (!rawStatement) continue;
      if (isNoise(source) || isNoise(rawStatement)) continue;
      const statement = contextualizeStatement(rawStatement, contextPrefix, sourceType);
      out.push({
        source,
        rawStatement,
        statement,
        contextPrefix,
      });
    }
  }

  return out;
}

function isExploratoryCandidate(candidate) {
  const source = String((candidate && candidate.source) || '');
  const rawStatement = String((candidate && (candidate.rawStatement || candidate.statement)) || '');
  const contextPrefix = String((candidate && candidate.contextPrefix) || '');
  const joined = [source, rawStatement, contextPrefix].filter(Boolean).join(' ');
  if (!joined) return false;
  if (OPEN_QUESTION_RE.test(joined)) return true;
  if (UNCERTAIN_TASK_RE.test(joined)) return true;
  if (
    (joined.includes('/') || joined.includes('|'))
    && (/\b(todo|follow up|action item|track|remind)\b/i.test(joined) || /待办|跟进|追踪|提醒/.test(joined))
  ) {
    return true;
  }
  return false;
}

function hasIdeaSignal(candidate) {
  const source = String((candidate && candidate.source) || '');
  const rawStatement = String((candidate && (candidate.rawStatement || candidate.statement)) || '');
  const contextPrefix = String((candidate && candidate.contextPrefix) || '');
  return IDEA_RE.test([source, rawStatement, contextPrefix].filter(Boolean).join(' '));
}

function classifySignals(candidate) {
  const source = candidate.source || '';
  const statement = candidate.rawStatement || candidate.statement || '';
  const signals = [];
  const exploratory = isExploratoryCandidate(candidate);
  const ideaSignal = hasIdeaSignal(candidate);

  if (DECISION_RE.test(source) || DECISION_RE.test(statement)) signals.push('Decision');
  if (
    (/^[-*]\s*\[[ xX]\]/.test(source) || TASK_PREFIX_RE.test(statement) || TASK_CONTAINS_RE.test(source) || TASK_CONTAINS_RE.test(statement))
    && !exploratory
  ) {
    signals.push('Task');
  }
  if (INSIGHT_RE.test(source) || INSIGHT_RE.test(statement) || (ideaSignal && exploratory)) signals.push('Insight');
  if (PROJECT_RE.test(source) || PROJECT_RE.test(statement)) signals.push('Project');
  if (AREA_RE.test(source) || AREA_RE.test(statement)) signals.push('Area');
  if (ENTITY_RE.test(source) || ENTITY_RE.test(statement)) signals.push('Entity');
  if (EVENT_RE.test(source) || EVENT_RE.test(statement)) signals.push('Event');
  if (!signals.length && ideaSignal && exploratory) signals.push('Insight');

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

function normalizeTypeWhitelist(value) {
  const input = Array.isArray(value) ? value : DEFAULT_TYPE_WHITELIST;
  const out = new Set(
    input
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  if (out.size === 0) {
    for (const item of DEFAULT_TYPE_WHITELIST) out.add(item);
  }
  return out;
}

function normalizeMinConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MIN_CONFIDENCE;
  return Math.max(0, Math.min(1, num));
}

function hasStrongAutoVerifySignal(type, statement) {
  const value = String(statement || '').trim();
  if (value.length < 24) return false;
  if (isNoise(value)) return false;

  if (type === 'Decision') {
    return /\b(decision|decided|approve|approved|choose|chosen|must)\b|决定|决策|拍板|必须/i.test(value);
  }
  if (type === 'Task') {
    return /\b(owner|deadline|due|by\s+\d{4}-\d{2}-\d{2}|must|need to)\b|负责人|截止|到期|必须|需要/i.test(value);
  }
  if (type === 'Insight') {
    return /\b(root cause|lesson|takeaway|pattern)\b|根因|经验|洞察|规律/i.test(value);
  }
  if (type === 'Area') {
    return /\b(ownership|responsibility|scope)\b|职责|责任域|范围/i.test(value);
  }
  return false;
}

function mkItem({ type, statement, source, chunk, weak, exploratory = false }) {
  const meta = TYPE_META[type] || TYPE_META.Event;
  const normalized = normalizeForDedup(statement);
  const dedupKey = sha256(`${type}|${normalized}`);
  const title = buildReadableTitle({
    type,
    title: statement,
    body: statement,
    exploratory,
  });

  let state = 'candidate';
  if (source.defaultState === 'archived') {
    state = 'archived';
  } else if (source.defaultState === 'verified' && hasStrongAutoVerifySignal(type, statement)) {
    state = 'verified';
  }
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

function distillChunk({ source, chunk, options = {} }) {
  const typeWhitelist = normalizeTypeWhitelist(options.typeWhitelist);
  const minConfidence = normalizeMinConfidence(options.minConfidence);
  const items = [];
  const counts = new Map();
  const seen = new Set();

  const candidates = splitSentences(chunk.text, {
    sourceType: source && source.sourceType ? source.sourceType : null,
  }).slice(0, 80);

  for (const candidate of candidates) {
    const exploratory = isExploratoryCandidate(candidate);
    const signals = classifySignals(candidate);
    const resolved = resolveType(signals);
    const type = resolved.type;
    if (!type) continue;
    if (!typeWhitelist.has(type)) continue;

    const current = counts.get(type) || 0;
    const limit = TYPE_LIMITS[type] || 2;
    if (current >= limit) continue;

    const key = `${type}|${normalizeForDedup(candidate.statement)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const built = mkItem({
      type,
      statement: candidate.statement,
      source,
      chunk,
      weak: resolved.weak,
      exploratory,
    });
    if (built.confidence < minConfidence) continue;
    items.push(built);
    counts.set(type, current + 1);
  }

  return items;
}

module.exports = {
  distillChunk,
};
