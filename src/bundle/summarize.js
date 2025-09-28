'use strict';

const { compact, hasCjk, normalizeOneLine } = require('./types');

function splitParagraphs(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => normalizeOneLine(part))
    .filter(Boolean);
}

function summarizeDocumentBundle(bundle, cardSeeds = []) {
  const paragraphs = splitParagraphs(bundle.content).filter((part) => !/^#/.test(part));
  const languageZh = hasCjk(bundle.content);
  const lead = paragraphs[0] || '';
  const topicNames = Array.isArray(cardSeeds)
    ? cardSeeds.map((seed) => seed && seed.title).filter(Boolean).slice(0, 4)
    : [];

  if (languageZh) {
    const parts = [];
    if (lead) parts.push(`这篇文档主要讨论：${compact(lead, 100)}`);
    if (topicNames.length) parts.push(`当前涉及的核心主题包括：${topicNames.join('；')}。`);
    if (!parts.length) parts.push('这篇文档围绕一个或多个相关主题展开讨论，并形成了可复用的判断与问题。');
    return compact(parts.join(' '), 320);
  }

  const parts = [];
  if (lead) parts.push(`This document is mainly about ${compact(lead, 100)}.`);
  if (topicNames.length) parts.push(`The main themes are ${topicNames.join(', ')}.`);
  if (!parts.length) parts.push('This document discusses one or more related themes and captures reusable decisions, questions, and insights.');
  return compact(parts.join(' '), 320);
}

function summarizeConversationBundle(bundle, cardSeeds = []) {
  const messages = Array.isArray(bundle.messages) ? bundle.messages : [];
  const userTexts = messages.filter((m) => m.role === 'user').map((m) => normalizeOneLine(m.text)).filter(Boolean);
  const languageZh = hasCjk(userTexts.join(' '));
  const lead = userTexts[0] || '';
  const last = userTexts[userTexts.length - 1] || '';
  const topicNames = Array.isArray(cardSeeds)
    ? cardSeeds.map((seed) => seed && seed.title).filter(Boolean).slice(0, 4)
    : [];

  if (languageZh) {
    const parts = [];
    if (lead) parts.push(`这一阶段的讨论从“${compact(lead, 60)}”展开。`);
    if (topicNames.length) parts.push(`最终沉淀出的主题包括：${topicNames.join('；')}。`);
    if (last && last !== lead) parts.push(`当前阶段最后收敛到：${compact(last, 70)}。`);
    if (!parts.length) parts.push('这一阶段的对话围绕一个或多个相关问题展开，并沉淀出可复用的判断与待确认点。');
    return compact(parts.join(' '), 320);
  }

  const parts = [];
  if (lead) parts.push(`This discussion phase started from "${compact(lead, 60)}".`);
  if (topicNames.length) parts.push(`The main outcomes are ${topicNames.join(', ')}.`);
  if (last && last !== lead) parts.push(`It currently converges on "${compact(last, 70)}".`);
  if (!parts.length) parts.push('This conversation phase captures one or more related questions and the conclusions reached so far.');
  return compact(parts.join(' '), 320);
}

function summarizeBundle(bundle, cardSeeds = []) {
  const summaryText = bundle.bundleType === 'conversation'
    ? summarizeConversationBundle(bundle, cardSeeds)
    : summarizeDocumentBundle(bundle, cardSeeds);
  return {
    bundleId: bundle.id,
    bundleType: bundle.bundleType,
    summaryText,
  };
}

module.exports = {
  summarizeBundle,
};
