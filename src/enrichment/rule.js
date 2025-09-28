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

function detectLanguage(...values) {
  const text = values.map((v) => String(v || '')).join(' ');
  if (!text.trim()) return 'en';
  const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  if (zhCount >= 6) return 'zh';
  if (zhCount > 0 && zhCount >= Math.ceil(latinCount / 2)) return 'zh';
  return 'en';
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

function pickSourceLabel(sourcePath, lang = 'en') {
  const value = String(sourcePath || '').trim();
  const zh = lang === 'zh';
  if (!value) return zh ? '会话记忆输入' : 'session memory input';
  if (value.startsWith('notion:')) return zh ? 'Notion 文档来源' : 'Notion document source';
  if (value.startsWith('session:') || value.startsWith('session_end:')) return zh ? '会话转录来源' : 'session transcript source';
  if (value.includes('/imports/chats/')) return zh ? '聊天导入来源' : 'chat import source';
  if (value.includes('/imports/obsidian/')) return zh ? 'Obsidian 导入来源' : 'Obsidian import source';
  return value;
}

function inferMeaning(type, body, lang = 'en') {
  const zh = lang === 'zh';
  if (isOpenPlanningItem(type, body)) {
    return zh
      ? '这是一个待决策的规划灵感/问题，尚未转化为可执行待办。'
      : 'This captures an open planning idea/question and should not be treated as a committed execution task yet.';
  }
  if (type === 'Decision') return zh ? '该决策可作为当前默认执行方向，除非出现新的反证。' : 'This decision should be treated as an execution default until explicitly changed.';
  if (type === 'Task') return zh ? '该条目是明确执行意图，应进入提醒与完成跟踪。' : 'This task represents near-term execution intent and should be tracked to completion.';
  if (type === 'Insight') return zh ? '该洞察可复用于后续方案评估，减少重复试错。' : 'This insight captures a reusable lesson that can reduce repeated mistakes.';
  if (type === 'Area') return zh ? '该领域定义了稳定边界与责任范围，用于后续优先级判断。' : 'This area defines stable scope and ownership boundaries for future work.';
  if (type === 'Project') return zh ? '该项目记忆用于锚定规划上下文与交付预期。' : 'This project memory anchors planning context and release expectations.';
  if (type === 'Entity') return zh ? '该实体记忆记录可能影响依赖关系的人或系统。' : 'This entity memory records a person/system that may affect dependencies.';
  return zh ? '该事件记录了运行过程信号，可用于后续决策。' : 'This event memory records runtime/process signal for follow-up decisions.';
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

function extractNextAction(type, body, lang = 'en') {
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
  if (type === 'Decision') return lang === 'zh' ? '按该决策推进，并补充验证结果。' : 'Execute according to this decision and record validation outcome.';
  if (type === 'Insight') return lang === 'zh' ? '将该洞察转化为明确决策或待办。' : 'Convert this insight into a concrete decision or task.';
  return '';
}

function inferActionability(type, body, lang = 'en') {
  const zh = lang === 'zh';
  if (isOpenPlanningItem(type, body)) {
    return zh
      ? '可执行性：当前不可直接执行；先明确负责人与触发规则，再转成具体待办。'
      : 'Actionability: not directly executable yet; decide owner/trigger rule first, then convert to a concrete task.';
  }
  const nextAction = extractNextAction(type, body, lang);
  if (nextAction) {
    return zh
      ? compact(`可执行性：可立即执行。建议下一步：${nextAction}`, 240)
      : compact(`Actionable now: ${nextAction}`, 240);
  }

  if (type === 'Decision') return zh ? '可执行性：在方案分歧时优先按该决策落地。' : 'Actionability: use as baseline when choosing implementation path.';
  if (type === 'Task') return zh ? '可执行性：补齐负责人与截止时间后进入跟踪。' : 'Actionability: schedule owner and deadline, then track status changes.';
  if (type === 'Insight') return zh ? '可执行性：纳入规划/复盘检查清单。' : 'Actionability: attach to planning/review checklist for future runs.';
  if (type === 'Area') return zh ? '可执行性：作为优先级评估时的边界约束。' : 'Actionability: keep this as scope boundary for prioritization.';
  return zh ? '可执行性：作为检索与规划的辅助信号。' : 'Actionability: use as supporting signal in retrieval and planning.';
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function buildContextSummary(type, body, sourcePath, evidenceSnippet, lang = 'en') {
  const sourceLabel = pickSourceLabel(sourcePath, lang);
  if (!String(sourcePath || '').startsWith('notion:')) {
    if (lang === 'zh') {
      return compact(`来源：${sourceLabel}。核心陈述：${body}`, 260);
    }
    return compact(`Captured from ${sourceLabel}. Core statement: ${body}`, 260);
  }

  const parsed = parseNotionSourcePath(sourcePath);
  const quote = compact(evidenceSnippet || body, 140);
  const anchorLabel = parsed.blockId
    ? (lang === 'zh' ? `块 ${String(parsed.blockId).slice(0, 8)}` : `block ${String(parsed.blockId).slice(0, 8)}`)
    : (lang === 'zh' ? '页面' : 'page');
  const link = notionUrl(parsed.pageId, parsed.blockId);

  const base = lang === 'zh'
    ? (quote ? `证据摘录：「${quote}」（来源：Notion ${anchorLabel}）` : `来源：Notion ${anchorLabel}`)
    : (quote ? `Quoted evidence: "${quote}" (source: Notion ${anchorLabel})` : `Source: Notion ${anchorLabel}`);
  if (!link) return compact(base, 260);
  return lang === 'zh'
    ? compact(`${base}。链接：${link}`, 260)
    : compact(`${base}. Open: ${link}`, 260);
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

  const language = detectLanguage(type, body, evidenceSnippet, sourcePath);
  const contextSummary = buildContextSummary(type, body, sourcePath, evidenceSnippet, language);
  let meaningSummary = inferMeaning(type, body, language);
  let actionabilitySummary = inferActionability(type, body, language);
  const nextAction = extractNextAction(type, body, language);
  const ownerHint = inferOwnerHint(body);
  const projectDisplayName = resolveProjectDisplayName(projectId, projectNameMap);

  const contextNorm = normalizeForCompare(contextSummary);
  const meaningNorm = normalizeForCompare(meaningSummary);
  const actionNorm = normalizeForCompare(actionabilitySummary);
  if (meaningNorm && meaningNorm === contextNorm) {
    meaningSummary = inferMeaning(type, '', language);
  }
  if (actionNorm && (actionNorm === contextNorm || actionNorm === meaningNorm)) {
    actionabilitySummary = inferActionability(type, '', language);
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
