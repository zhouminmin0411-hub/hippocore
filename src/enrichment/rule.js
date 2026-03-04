'use strict';

const ENRICHMENT_VERSION = 'rule-v2';

const OWNER_PATTERNS = [
  /\bowner\s*[:：]\s*([A-Za-z0-9_.\-]+)/i,
  /\bassignee\s*[:：]\s*([A-Za-z0-9_.\-]+)/i,
  /负责人\s*[:：]\s*([^\s,，。;；]+)/,
  /由\s*([^\s,，。;；]{1,16})\s*负责/,
];

const OPEN_QUESTION_RE = /\?|？|\b(should|whether|open question|tbd|to be decided)\b|是否|要不要|还是|待确认|待定|我来判断/i;
const IDEA_RE = /\b(idea|brainstorm|concept|proposal|hypothesis|ssot)\b|灵感|想法|构想|设想|方案|思路|单一真相源|收口|闭环/i;
const EXECUTION_COMMITMENT_RE = /\b(owner|assignee|deadline|due|must|need to|by\s+\d{4}-\d{2}-\d{2})\b|负责人|截止|到期|必须|需要|今日|明天|本周|下周|\d{1,2}:\d{2}/i;

function compact(text, limit = 240) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function parseNotionSourcePath(sourcePath) {
  const value = String(sourcePath || '').trim();
  if (!value.startsWith('notion:')) return { pageId: null, blockId: null };
  const payload = value.slice('notion:'.length);
  const hashIdx = payload.indexOf('#');
  if (hashIdx === -1) return { pageId: payload || null, blockId: null };
  return {
    pageId: payload.slice(0, hashIdx) || null,
    blockId: payload.slice(hashIdx + 1) || null,
  };
}

function notionUrl(pageId, blockId = null) {
  if (!pageId) return null;
  const pagePart = String(pageId).replace(/-/g, '');
  if (!blockId) return `https://www.notion.so/${pagePart}`;
  return `https://www.notion.so/${pagePart}#${String(blockId).replace(/-/g, '')}`;
}

function pickSourceLabel(sourcePath) {
  const value = String(sourcePath || '').trim();
  if (!value) return 'session memory input';
  if (value.startsWith('notion:')) return 'Notion document source';
  if (value.startsWith('session:') || value.startsWith('session_end:')) return 'session transcript source';
  if (value.includes('/imports/chats/')) return 'chat import source';
  if (value.includes('/imports/obsidian/')) return 'Obsidian import source';
  return value;
}

function inferMeaning(type, body) {
  if (isOpenPlanningItem(type, body)) {
    return 'This captures an open planning idea/question and should not be treated as a committed execution task yet.';
  }
  if (type === 'Decision') return 'This decision should be treated as an execution default until explicitly changed.';
  if (type === 'Task') return 'This task represents near-term execution intent and should be tracked to completion.';
  if (type === 'Insight') return 'This insight captures a reusable lesson that can reduce repeated mistakes.';
  if (type === 'Area') return 'This area defines stable scope and ownership boundaries for future work.';
  if (type === 'Project') return 'This project memory anchors planning context and release expectations.';
  if (type === 'Entity') return 'This entity memory records a person/system that may affect dependencies.';
  return 'This event memory records runtime/process signal for follow-up decisions.';
}

function isOpenPlanningItem(type, body) {
  const text = String(body || '').trim();
  if (!text) return false;
  if (OPEN_QUESTION_RE.test(text) || /无明确时间|时间未定|暂不确定/.test(text)) return true;
  if ((type === 'Task' || type === 'Insight') && IDEA_RE.test(text) && !EXECUTION_COMMITMENT_RE.test(text)) return true;
  if ((text.includes('/') || text.includes('|')) && /待办|跟进|追踪|提醒|todo|follow up|track/i.test(text) && !EXECUTION_COMMITMENT_RE.test(text)) {
    return true;
  }
  return false;
}

function extractNextAction(type, body) {
  const text = compact(body, 180);
  if (!text) return '';
  if (isOpenPlanningItem(type, body)) return '';

  const patterns = [
    /\b(todo|need to|must|please|action item|next step)\b[:：\-\s]*(.+)$/i,
    /(?:待办|下一步|需要|必须|请)\s*[:：\-\s]*(.+)$/i,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(text);
    if (hit && hit[2]) {
      return compact(hit[2], 140);
    }
  }

  if (type === 'Task') return compact(text, 140);
  if (type === 'Decision') return 'Execute according to this decision and record validation outcome.';
  if (type === 'Insight') return 'Convert this insight into a concrete decision or task.';
  return '';
}

function inferActionability(type, body) {
  if (isOpenPlanningItem(type, body)) {
    return 'Actionability: not directly executable yet; decide owner/trigger rule first, then convert to a concrete task.';
  }
  const nextAction = extractNextAction(type, body);
  if (nextAction) return compact(`Actionable now: ${nextAction}`, 240);

  if (type === 'Decision') return 'Actionability: use as baseline when choosing implementation path.';
  if (type === 'Task') return 'Actionability: schedule owner and deadline, then track status changes.';
  if (type === 'Insight') return 'Actionability: attach to planning/review checklist for future runs.';
  if (type === 'Area') return 'Actionability: keep this as scope boundary for prioritization.';
  return 'Actionability: use as supporting signal in retrieval and planning.';
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function buildContextSummary(type, body, sourcePath, evidenceSnippet) {
  const sourceLabel = pickSourceLabel(sourcePath);
  if (!String(sourcePath || '').startsWith('notion:')) {
    return compact(`Captured from ${sourceLabel}. Core statement: ${body}`, 260);
  }

  const parsed = parseNotionSourcePath(sourcePath);
  const quote = compact(evidenceSnippet || body, 140);
  const anchorLabel = parsed.blockId
    ? `block ${String(parsed.blockId).slice(0, 8)}`
    : 'page';
  const link = notionUrl(parsed.pageId, parsed.blockId);

  const base = quote
    ? `Quoted evidence: "${quote}" (source: Notion ${anchorLabel})`
    : `Source: Notion ${anchorLabel}`;
  if (!link) return compact(base, 260);
  return compact(`${base}. Open: ${link}`, 260);
}

function inferOwnerHint(body) {
  const text = String(body || '');
  for (const pattern of OWNER_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit && hit[1]) return compact(hit[1], 80);
  }
  return '';
}

function resolveProjectDisplayName(projectId, projectNameMap) {
  const key = String(projectId || '').trim();
  if (!key) return '';
  if (!projectNameMap || typeof projectNameMap !== 'object') return key;
  const mapped = projectNameMap[key];
  if (mapped == null) return key;
  const value = String(mapped).trim();
  return value || key;
}

function buildRuleEnrichment(item, context = {}) {
  const type = String(item && item.type ? item.type : 'Event');
  const body = String(item && item.body ? item.body : '');
  const sourcePath = (context && context.sourcePath) || (item && item.evidence && item.evidence.sourcePath) || '';
  const evidenceSnippet = (item && item.evidence && (item.evidence.sourceSnippet || item.evidence.snippet)) || '';
  const projectId = (item && item.projectId) || null;
  const projectNameMap = (context && context.projectNameMap) || {};

  const contextSummary = buildContextSummary(type, body, sourcePath, evidenceSnippet);
  let meaningSummary = inferMeaning(type, body);
  let actionabilitySummary = inferActionability(type, body);
  const nextAction = extractNextAction(type, body);
  const ownerHint = inferOwnerHint(body);
  const projectDisplayName = resolveProjectDisplayName(projectId, projectNameMap);

  const contextNorm = normalizeForCompare(contextSummary);
  const meaningNorm = normalizeForCompare(meaningSummary);
  const actionNorm = normalizeForCompare(actionabilitySummary);
  if (meaningNorm && meaningNorm === contextNorm) {
    meaningSummary = inferMeaning(type, '');
  }
  if (actionNorm && (actionNorm === contextNorm || actionNorm === meaningNorm)) {
    actionabilitySummary = inferActionability(type, '');
  }

  return {
    context_summary: contextSummary,
    meaning_summary: meaningSummary,
    actionability_summary: actionabilitySummary,
    next_action: nextAction,
    owner_hint: ownerHint,
    project_display_name: projectDisplayName,
    enrichment_source: 'rule',
    enrichment_version: ENRICHMENT_VERSION,
    llm_enriched_at: null,
  };
}

module.exports = {
  buildRuleEnrichment,
  ENRICHMENT_VERSION,
};
