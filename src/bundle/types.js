'use strict';

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function normalizeOneLine(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function hasCjk(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ''));
}

function compact(value, limit = 240) {
  const out = normalizeOneLine(value);
  if (!out) return '';
  if (out.length <= limit) return out;
  return `${out.slice(0, Math.max(0, limit - 3))}...`;
}

function slugifyTopic(value) {
  const base = normalizeOneLine(value)
    .toLowerCase()
    .replace(/[`"'“”‘’]+/g, '')
    .replace(/\b(user|assistant|ai|decision|task|insight|area|event|question|问题|决策|决定|任务|待办|洞察|事件)\b/gi, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'untitled-topic';
}

module.exports = {
  normalizeText,
  normalizeOneLine,
  hasCjk,
  compact,
  slugifyTopic,
};
