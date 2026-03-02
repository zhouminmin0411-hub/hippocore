'use strict';

const ENRICHMENT_VERSION = 'rule-v1';

const OWNER_PATTERNS = [
  /\bowner\s*[:：]\s*([A-Za-z0-9_.\-]+)/i,
  /\bassignee\s*[:：]\s*([A-Za-z0-9_.\-]+)/i,
  /负责人\s*[:：]\s*([^\s,，。;；]+)/,
  /由\s*([^\s,，。;；]{1,16})\s*负责/,
];

function compact(text, limit = 240) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
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
  const text = compact(body, 160);
  if (!text) return '';

  if (type === 'Decision') return compact(`This decision constrains execution direction and should be treated as a default operating choice: ${text}`, 260);
  if (type === 'Task') return compact(`This task captures near-term execution intent and should be tracked for completion: ${text}`, 260);
  if (type === 'Insight') return compact(`This insight captures a reusable lesson that can reduce repeated mistakes: ${text}`, 260);
  if (type === 'Area') return compact(`This area defines stable scope and ownership boundaries for future work: ${text}`, 260);
  if (type === 'Project') return compact(`This project memory anchors planning context and release expectations: ${text}`, 260);
  if (type === 'Entity') return compact(`This entity memory records a person/system that may affect delivery dependencies: ${text}`, 260);
  return compact(`This event memory records runtime or process signal for follow-up decisions: ${text}`, 260);
}

function extractNextAction(type, body) {
  const text = compact(body, 180);
  if (!text) return '';

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
  const nextAction = extractNextAction(type, body);
  if (nextAction) return compact(`Actionable now: ${nextAction}`, 240);

  if (type === 'Decision') return 'Actionability: use as baseline when choosing implementation path.';
  if (type === 'Task') return 'Actionability: schedule owner and deadline, then track status changes.';
  if (type === 'Insight') return 'Actionability: attach to planning/review checklist for future runs.';
  if (type === 'Area') return 'Actionability: keep this as scope boundary for prioritization.';
  return 'Actionability: use as supporting signal in retrieval and planning.';
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
  const projectId = (item && item.projectId) || null;
  const projectNameMap = (context && context.projectNameMap) || {};

  const contextSummary = compact(`Captured from ${pickSourceLabel(sourcePath)}. Core statement: ${body}`, 260);
  const meaningSummary = inferMeaning(type, body);
  const actionabilitySummary = inferActionability(type, body);
  const nextAction = extractNextAction(type, body);
  const ownerHint = inferOwnerHint(body);
  const projectDisplayName = resolveProjectDisplayName(projectId, projectNameMap);

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
