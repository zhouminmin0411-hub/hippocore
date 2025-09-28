'use strict';

const { sha256 } = require('../hash');

const SUMMARY_TERMS_ZH = ['总结', '小结', '本阶段', '阶段结论', '当前结论', '归纳', '接下来', '后续动作', '待办', '决策', '结论', '要点'];
const SUMMARY_TERMS_EN = ['summary', 'recap', 'checkpoint', 'compression', 'takeaways', 'current conclusion', 'next steps', 'action items', 'decisions'];
const ACTION_TERMS_ZH = ['接下来', '后续动作', '下一步', '待办', '行动项'];
const ACTION_TERMS_EN = ['next steps', 'action items', 'next action', 'follow-up'];
const CONCLUSION_TERMS_ZH = ['结论', '决策', '要点', '总结', '归纳'];
const CONCLUSION_TERMS_EN = ['conclusion', 'decision', 'takeaways', 'summary', 'recap'];

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

function countAny(text, terms) {
  let count = 0;
  for (const term of terms) {
    if (text.includes(String(term).toLowerCase())) count += 1;
  }
  return count;
}

function readExplicitCheckpointId(event) {
  if (!event || typeof event !== 'object') return null;
  const explicit = event.checkpointId || event.summaryId || null;
  if (explicit) return { value: String(explicit), reason: 'explicit_event_marker' };

  const candidates = [
    event.kind,
    event.type,
    event.tag,
    event.event,
    event.meta && event.meta.kind,
    event.meta && event.meta.type,
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  if (candidates.some((value) => /(checkpoint|summary|compression)/.test(value))) {
    const fallback = event.messageId || event.id || null;
    if (fallback) return { value: String(fallback), reason: 'explicit_event_marker' };
  }
  return null;
}

function buildCheckpointKey(sessionKey, explicit, messageId, text) {
  if (explicit) return `summary:${String(explicit)}`;
  if (messageId) return `anchor:${String(messageId)}`;
  return `digest:${sha256(`${String(sessionKey || '')}|${normalizeText(text)}`).slice(0, 16)}`;
}

function summarySignals(text) {
  const normalized = lower(text);
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const head = normalized.slice(0, 120);
  const termCount = countAny(normalized, [...SUMMARY_TERMS_ZH, ...SUMMARY_TERMS_EN]);
  const bulletCount = lines.filter((line) => /^([-*•]\s+|\d+[.)]\s+)/.test(line)).length;
  const sectionCount = lines.filter((line) => (
    /[:：]$/.test(line)
    || /^#{1,6}\s/.test(line)
    || /^(summary|recap|takeaways|next steps|action items|总结|小结|要点|结论|接下来)/.test(line)
  )).length;
  const headingHit = includesAny(head, [...SUMMARY_TERMS_ZH, ...SUMMARY_TERMS_EN]);
  const hasConclusion = includesAny(normalized, [...CONCLUSION_TERMS_ZH, ...CONCLUSION_TERMS_EN]);
  const hasAction = includesAny(normalized, [...ACTION_TERMS_ZH, ...ACTION_TERMS_EN]);
  const isLongStructured = normalized.length >= 180 && (bulletCount >= 2 || sectionCount >= 2);

  let score = 0;
  if (termCount > 0) score += 0.25;
  if (headingHit) score += 0.25;
  if (bulletCount >= 2) score += 0.15;
  if (hasConclusion && hasAction) score += 0.2;
  if (isLongStructured) score += 0.15;

  return {
    termCount,
    bulletCount,
    sectionCount,
    headingHit,
    hasConclusion,
    hasAction,
    score,
  };
}

function detectCheckpointAnchor(event, messageText, sessionState = {}, config = {}) {
  const compatibility = (((config || {}).openclaw || {}).checkpointCompatibility || {});
  if (compatibility.enabled === false) {
    return { matched: false, reason: 'disabled', confidence: 0, checkpointKey: null, summarySnippet: null };
  }

  const text = normalizeText(messageText);
  if (!text) {
    return { matched: false, reason: 'no_match', confidence: 0, checkpointKey: null, summarySnippet: null };
  }

  const explicit = compatibility.allowExplicitEventMarkers === false ? null : readExplicitCheckpointId(event);
  const messageId = sessionState.messageId || (event && event.messageId) || null;
  const summarySnippet = text.slice(0, 240);
  if (explicit) {
    return {
      matched: true,
      reason: explicit.reason,
      confidence: 1,
      checkpointKey: buildCheckpointKey(sessionState.sessionKey, explicit.value, messageId, text),
      summarySnippet,
    };
  }

  const signals = summarySignals(text);
  const minConfidence = Number(compatibility.minConfidence || 0.78);
  const requireSummarySignals = compatibility.requireSummarySignals !== false;
  if (signals.headingHit && text.length >= 60) {
    return {
      matched: true,
      reason: 'summary_heading',
      confidence: Math.max(0.8, signals.score),
      checkpointKey: buildCheckpointKey(sessionState.sessionKey, null, messageId, text),
      summarySnippet,
    };
  }
  if (signals.score >= minConfidence && (!requireSummarySignals || signals.termCount > 0 || signals.headingHit)) {
    return {
      matched: true,
      reason: 'shape_score',
      confidence: signals.score,
      checkpointKey: buildCheckpointKey(sessionState.sessionKey, null, messageId, text),
      summarySnippet,
    };
  }
  return {
    matched: false,
    reason: 'no_match',
    confidence: signals.score,
    checkpointKey: null,
    summarySnippet: null,
  };
}

module.exports = {
  detectCheckpointAnchor,
};
