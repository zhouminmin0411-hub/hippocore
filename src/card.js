'use strict';

const OPEN_QUESTION_RE = /\?|？|\b(should|whether|open question|tbd|to be decided|undecided)\b|是否|要不要|还是|待确认|待定|我来判断|无明确时间|时间未定|暂不确定/i;
const UNDECIDED_HINT_RE = /\b(not directly executable|clarification|decision needed|pending decision)\b|不可直接执行|待决策|待确认|待定|仍在探索|尚未定稿/i;
const ROLE_PREFIX_RE = /^(user|assistant|ai|ai_supplement)\s*[:：-]\s*/i;
const TYPE_PREFIX_RE = /^(decision|task|insight|project|area|entity|event|todo)\s*[:：-]\s*/i;
const CN_TYPE_PREFIX_RE = /^(决定|决策|任务|待办|洞察|项目|领域|事件)\s*[:：-]\s*/;
const GENERIC_PREFIX_RE = /^(idea|insight|task|todo|decision|note|context|背景|问题|待办|灵感|产品灵感|决策)$/i;
const SOURCE_PATH_NOTION_RE = /^notion:/i;

function compact(text, limit = 96) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

function normalizeOneLine(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/^[-*]\s*(\[[ xX]\])?\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTypePrefix(text) {
  return normalizeOneLine(text)
    .replace(ROLE_PREFIX_RE, '')
    .replace(TYPE_PREFIX_RE, '')
    .replace(CN_TYPE_PREFIX_RE, '')
    .trim();
}

function splitAtLabelPrefix(text) {
  const hit = /^([^:：]{1,32})[:：]\s*(.+)$/.exec(String(text || '').trim());
  if (!hit) return { label: '', content: String(text || '').trim() };
  return {
    label: String(hit[1] || '').trim(),
    content: String(hit[2] || '').trim(),
  };
}

function looksUndecidedText(text) {
  const value = normalizeOneLine(text);
  if (!value) return false;
  if (OPEN_QUESTION_RE.test(value)) return true;
  if ((value.includes('/') || value.includes('|')) && /待办|跟进|追踪|提醒|todo|follow up|track/i.test(value)) {
    return true;
  }
  return false;
}

function looksUndecidedFromFields({
  body = '',
  actionabilitySummary = '',
  meaningSummary = '',
  nextAction = '',
  exploratory = false,
} = {}) {
  if (exploratory) return true;
  if (!String(nextAction || '').trim()) {
    const combined = `${actionabilitySummary || ''} ${meaningSummary || ''}`.trim();
    if (UNDECIDED_HINT_RE.test(combined)) return true;
  }
  return looksUndecidedText(body);
}

function simplifyUndecidedTitle(text, useChineseSuffix) {
  const value = normalizeOneLine(text);
  if (!value) return value;
  const suffix = useChineseSuffix ? '（待决策）' : ' (pending decision)';
  const alreadyTagged = useChineseSuffix
    ? /（待决策）|待决策|待确认|待定/.test(value)
    : /\(pending decision\)|pending decision/i.test(value);
  if (alreadyTagged) return value;

  const { label, content } = splitAtLabelPrefix(value);
  if (label && content && (content.includes('/') || content.includes('|') || /[?？]/.test(content))) {
    return `${label}${suffix}`;
  }

  if ((value.includes('/') || value.includes('|')) && value.length > 24) {
    const first = value.split(/\s*(?:\/|\|)\s*/)[0].trim();
    if (first) return `${first}${suffix}`;
  }

  return `${value}${suffix}`;
}

function pickTitleSeed({ type = '', title = '', body = '' } = {}) {
  const cleanedTitle = stripTypePrefix(title);
  const cleanedBody = stripTypePrefix(body);
  const normalizedType = String(type || '').trim().toLowerCase();

  const titleTooGeneric = !cleanedTitle
    || cleanedTitle.toLowerCase() === normalizedType
    || GENERIC_PREFIX_RE.test(cleanedTitle);
  if (!titleTooGeneric) return cleanedTitle;
  if (cleanedBody) return cleanedBody;
  return cleanedTitle || cleanedBody || '';
}

function maybeDropGenericPrefix(text) {
  const value = normalizeOneLine(text);
  if (!value) return value;
  const { label, content } = splitAtLabelPrefix(value);
  if (!label || !content) return value;
  if (GENERIC_PREFIX_RE.test(label)) return content;
  if (label.includes('/') && content.length >= 6) return content;
  return value;
}

function trimSentenceForTitle(text, limit = 88) {
  const value = normalizeOneLine(text);
  if (!value) return value;
  if (value.length <= limit) return value;
  const firstSentence = value.split(/[。！？.!?]/)[0].trim();
  if (firstSentence.length >= 8 && firstSentence.length <= limit) return firstSentence;
  return compact(value, limit);
}

function buildReadableTitle({
  type = '',
  title = '',
  body = '',
  meaningSummary = '',
  actionabilitySummary = '',
  nextAction = '',
  exploratory = false,
} = {}) {
  const seed = pickTitleSeed({ type, title, body });
  let out = maybeDropGenericPrefix(seed);
  if (!out) out = stripTypePrefix(body);
  if (!out) out = stripTypePrefix(title);
  if (!out) return 'Untitled memory';

  const undecided = looksUndecidedFromFields({
    body,
    actionabilitySummary,
    meaningSummary,
    nextAction,
    exploratory,
  });
  if (undecided) {
    out = simplifyUndecidedTitle(out, hasCjk(`${out} ${body} ${meaningSummary} ${actionabilitySummary}`));
  }

  out = trimSentenceForTitle(out, 88);
  out = out.replace(/[:：,\-–]\s*$/, '').trim();
  return compact(out, 88) || 'Untitled memory';
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

function normalizeLineRange(lineStart, lineEnd) {
  const hasStart = Number.isFinite(Number(lineStart));
  const hasEnd = Number.isFinite(Number(lineEnd));
  if (!hasStart && !hasEnd) return '';
  if (hasStart && hasEnd) {
    const start = Number(lineStart);
    const end = Number(lineEnd);
    if (start === end) return String(start);
    return `${start}-${end}`;
  }
  return String(hasStart ? Number(lineStart) : Number(lineEnd));
}

function buildSourceDecisionPath({ sourcePath = '', lineStart = null, lineEnd = null } = {}) {
  const raw = String(sourcePath || '').trim();
  const lineRange = normalizeLineRange(lineStart, lineEnd);
  if (SOURCE_PATH_NOTION_RE.test(raw)) {
    const parsed = parseNotionSourcePath(raw);
    const parts = ['Notion'];
    if (parsed.pageId) parts.push(`page:${parsed.pageId}`);
    if (parsed.blockId) parts.push(`block:${parsed.blockId}`);
    if (lineRange) parts.push(`line:${lineRange}`);
    return parts.join(' > ');
  }

  if (!raw) {
    return lineRange ? `Unknown source > line:${lineRange}` : 'Unknown source';
  }
  return lineRange ? `${raw} > line:${lineRange}` : raw;
}

function inferSourceCategory(sourcePath) {
  const value = String(sourcePath || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value.startsWith('notion:')) return 'notion_doc';
  if (value.startsWith('session_end:') || value.startsWith('session:')) return 'session_transcript';
  if (value.startsWith('api:')) return 'manual_write';
  if (value.includes('/imports/chats/')) return 'chat_import';
  if (value.includes('/imports/obsidian/')) return 'obsidian_import';
  return 'file_source';
}

function sourceCategoryLabel(sourcePath, hintText = '') {
  const code = inferSourceCategory(sourcePath);
  const useZh = hasCjk(hintText);
  if (useZh) {
    if (code === 'notion_doc') return 'Notion 文档';
    if (code === 'session_transcript') return '会话记录';
    if (code === 'manual_write') return '手动写入';
    if (code === 'chat_import') return '聊天导入';
    if (code === 'obsidian_import') return 'Obsidian 导入';
    if (code === 'file_source') return '本地文件';
    return '未知来源';
  }
  if (code === 'notion_doc') return 'Notion document';
  if (code === 'session_transcript') return 'Session transcript';
  if (code === 'manual_write') return 'Manual write';
  if (code === 'chat_import') return 'Chat import';
  if (code === 'obsidian_import') return 'Obsidian import';
  if (code === 'file_source') return 'Local file';
  return 'Unknown source';
}

module.exports = {
  buildReadableTitle,
  buildSourceDecisionPath,
  inferSourceCategory,
  sourceCategoryLabel,
  parseNotionSourcePath,
  normalizeLineRange,
  looksUndecidedText,
};
