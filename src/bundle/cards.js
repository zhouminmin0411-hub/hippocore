'use strict';

const { distillChunk } = require('../distill');
const { buildReadableTitle, looksUndecidedText } = require('../card');
const { buildRuleEnrichment } = require('../enrichment/rule');
const { compact, hasCjk, normalizeOneLine, slugifyTopic } = require('./types');

function cleanStatement(value) {
  return normalizeOneLine(value)
    .replace(/^(user|assistant|ai|ai_supplement)\s*[:：-]\s*/i, '')
    .replace(/^(decision|task|insight|area|event|project)\s*[:：-]\s*/i, '')
    .replace(/^(决定|决策|任务|待办|洞察|领域|事件|项目)\s*[:：-]\s*/i, '')
    .trim();
}

function buildDisplayBody(type, statement, sourceSummary) {
  const clean = cleanStatement(statement);
  const zh = hasCjk(`${clean} ${sourceSummary}`);
  if (!clean) return zh ? '该主题来自当前来源的综合提炼结果。' : 'This theme was derived from the current source.';
  if (type === 'Decision') {
    return zh
      ? compact(`当前阶段的核心判断是：${clean}。这一判断来自整段来源内容的综合提炼，而不是单条摘录。`, 260)
      : compact(`The current working decision is: ${clean}. This card is derived from the source as a whole rather than a single quote.`, 260);
  }
  if (type === 'Task') {
    return zh
      ? compact(`当前明确的后续动作是：${clean}。该动作来自整段内容的综合整理。`, 260)
      : compact(`The next concrete action is: ${clean}. This action is synthesized from the broader source context.`, 260);
  }
  if (looksUndecidedText(clean)) {
    return zh
      ? compact(`当前需要继续回答的问题是：${clean}。它代表这一来源里尚未定稿但值得追踪的主题。`, 260)
      : compact(`The current open question is: ${clean}. It captures a still-open theme that deserves follow-up.`, 260);
  }
  if (type === 'Insight') {
    return zh
      ? compact(`当前沉淀出的关键洞察是：${clean}。它总结了来源中的一个可复用观点。`, 260)
      : compact(`The key insight is: ${clean}. It summarizes a reusable point from the source.`, 260);
  }
  return zh
    ? compact(`这一主题当前的完整表达是：${clean}。它来自对整段来源内容的整理。`, 260)
    : compact(`This theme can be summarized as: ${clean}. It is derived from the source as a whole.`, 260);
}

function buildEvidence(item, chunk, bundle) {
  return {
    sourceType: bundle.bundleType === 'conversation' ? 'session' : (bundle.sourceType || 'obsidian'),
    sourcePath: bundle.sourcePath,
    lineStart: chunk && Number.isFinite(chunk.lineStart) ? chunk.lineStart : null,
    lineEnd: chunk && Number.isFinite(chunk.lineEnd) ? chunk.lineEnd : null,
    snippet: compact(item.body || item.title || '', 220),
    role: item.evidence && item.evidence.role ? item.evidence.role : null,
  };
}

function draftFromItem(item, chunk, bundle, config) {
  const summaryHint = bundle.summaryText || '';
  const title = buildReadableTitle({
    type: item.type,
    title: item.title,
    body: cleanStatement(item.body),
  });
  const displayBody = buildDisplayBody(item.type, item.body, summaryHint);
  const enrichment = buildRuleEnrichment({
    type: item.type,
    body: displayBody,
    projectId: item.projectId || bundle.projectId || null,
    evidence: {
      sourcePath: bundle.sourcePath,
      sourceSnippet: item.body,
      snippet: item.body,
    },
  }, {
    sourcePath: bundle.sourcePath,
    projectNameMap: config && config.quality && config.quality.enrichment
      ? config.quality.enrichment.projectNameMap
      : {},
  });
  const topicSlug = slugifyTopic(title || item.body);
  return {
    type: item.type,
    title,
    displayBody,
    body: `${displayBody}\n\nContext: ${summaryHint}`.trim(),
    topicKeyCandidate: `${bundle.bundleType === 'document' ? 'doc' : 'conv'}-topic:${topicSlug}`,
    meaningSummary: enrichment.meaning_summary || '',
    actionabilitySummary: enrichment.actionability_summary || '',
    nextAction: enrichment.next_action || '',
    contextSummary: summaryHint,
    projectDisplayName: enrichment.project_display_name || '',
    ownerHint: enrichment.owner_hint || '',
    evidence: [buildEvidence(item, chunk, bundle)],
    confidence: item.confidence,
    importance: item.importance,
    scopeLevel: item.scopeLevel || (bundle.projectId ? 'project' : 'global'),
    projectId: item.projectId || bundle.projectId || null,
    sourceAuthority: item.sourceAuthority || 0.8,
    relationHints: Array.isArray(item.relationHints) ? item.relationHints : [],
  };
}

function mergeDrafts(existing, next) {
  const out = { ...existing };
  if (!out.title || next.title.length > out.title.length) out.title = next.title;
  if (!out.displayBody || next.displayBody.length > out.displayBody.length) out.displayBody = next.displayBody;
  if (!out.body || next.body.length > out.body.length) out.body = next.body;
  if (!out.meaningSummary || next.meaningSummary.length > out.meaningSummary.length) out.meaningSummary = next.meaningSummary;
  if (!out.actionabilitySummary || next.actionabilitySummary.length > out.actionabilitySummary.length) out.actionabilitySummary = next.actionabilitySummary;
  if (!out.nextAction || next.nextAction.length > out.nextAction.length) out.nextAction = next.nextAction;
  out.contextSummary = next.contextSummary || out.contextSummary;
  out.confidence = Math.max(Number(out.confidence || 0), Number(next.confidence || 0));
  out.importance = Math.max(Number(out.importance || 0), Number(next.importance || 0.5));
  out.evidence = [...(Array.isArray(out.evidence) ? out.evidence : []), ...(Array.isArray(next.evidence) ? next.evidence : [])]
    .slice(0, 5);
  return out;
}

function tokenize(text) {
  return new Set(
    normalizeOneLine(text)
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token && token.length > 1),
  );
}

function overlapScore(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap;
}

function isIgnorableAssistantMessage(text) {
  const normalized = normalizeOneLine(text).trim();
  if (!normalized) return true;
  if (normalized === 'NO_REPLY') return true;
  if (/^\[\[reply_to_current\]\]/i.test(normalized)) return true;
  if (/^(收到|好的|明白|继续|ok|okay|sure|got it|i will check|let me check)[。.! ]*$/i.test(normalized)) return true;
  if (/to=functions\./i.test(normalized) || /BEGIN_UNTRUSTED_CHILD_RESULT/i.test(normalized)) return true;
  if (/tool_stream_bug|server_error|echo done|stdout|stderr|exit code/i.test(normalized)) return true;
  return false;
}

function isSemanticUserMessage(text) {
  const normalized = normalizeOneLine(text).trim();
  if (!normalized) return false;
  if (/^\/new$/i.test(normalized)) return false;
  if (/^(如何了|然后呢|继续|好的|ok|收到)[？?。.! ]*$/i.test(normalized)) return false;
  return normalized.length >= 6;
}

function buildAssistantSupplement(text, summaryHint) {
  const normalized = cleanStatement(text);
  if (!normalized) return {
    meaningSummary: '',
    actionabilitySummary: '',
    nextAction: '',
  };

  const zh = hasCjk(`${normalized} ${summaryHint}`);
  return {
    meaningSummary: zh
      ? compact(`助手补充说明：${normalized}。`, 180)
      : compact(`Assistant supplemental context: ${normalized}.`, 180),
    actionabilitySummary: zh
      ? compact(`助手建议的后续方向：${normalized}。`, 180)
      : compact(`Assistant follow-up guidance: ${normalized}.`, 180),
    nextAction: compact(normalized, 140),
  };
}

function applyAssistantEvidence(draft, bundle, assistantMessages) {
  if (!Array.isArray(assistantMessages) || !assistantMessages.length) {
    return draft;
  }

  const draftKey = `${draft.title} ${draft.displayBody} ${draft.body}`;
  const related = assistantMessages.filter((message) => overlapScore(draftKey, message.text) >= 2);
  const selected = related.length
    ? related.slice(0, 2)
    : (assistantMessages.length === 1 ? assistantMessages.slice(0, 1) : []);

  if (!selected.length) {
    return draft;
  }

  const enriched = { ...draft };
  const firstSupplement = buildAssistantSupplement(selected[0].text, draft.contextSummary || '');
  enriched.evidence = [
    ...(Array.isArray(enriched.evidence) ? enriched.evidence : []),
    ...selected.map((message) => ({
      sourceType: 'session',
      sourcePath: bundle.sourcePath,
      lineStart: null,
      lineEnd: null,
      snippet: compact(message.text, 220),
      role: 'assistant',
    })),
  ].slice(0, 5);

  if (!enriched.meaningSummary && firstSupplement.meaningSummary) {
    enriched.meaningSummary = firstSupplement.meaningSummary;
  }
  if (firstSupplement.actionabilitySummary) {
    enriched.actionabilitySummary = enriched.actionabilitySummary
      ? compact(`${enriched.actionabilitySummary} ${firstSupplement.actionabilitySummary}`, 220)
      : firstSupplement.actionabilitySummary;
  }
  if (!enriched.nextAction && firstSupplement.nextAction) {
    enriched.nextAction = firstSupplement.nextAction;
  }

  return enriched;
}

function extractBundleCards(bundle, config) {
  const extractionStats = {
    extractionPolicy: bundle.bundleType === 'conversation' ? 'checkpoint_first_role_weighted' : 'document_default',
    windowMessageCount: Array.isArray(bundle.messages) ? bundle.messages.length : 0,
    windowUserCount: Array.isArray(bundle.messages) ? bundle.messages.filter((message) => message.role === 'user').length : 0,
    windowAssistantCount: Array.isArray(bundle.messages) ? bundle.messages.filter((message) => message.role === 'assistant').length : 0,
    assistantIgnoredCount: 0,
    userFactCandidateCount: 0,
    assistantEvidenceAttachedCount: 0,
  };

  const assistantMessages = bundle.bundleType === 'conversation'
    ? (Array.isArray(bundle.messages) ? bundle.messages.filter((message) => message.role === 'assistant') : [])
        .filter((message) => {
          const ignored = isIgnorableAssistantMessage(message.text);
          if (ignored) extractionStats.assistantIgnoredCount += 1;
          return !ignored;
        })
    : [];
  const userMessages = bundle.bundleType === 'conversation'
    ? (Array.isArray(bundle.messages) ? bundle.messages.filter((message) => message.role === 'user') : [])
        .filter((message) => isSemanticUserMessage(message.text))
    : [];

  if (bundle.bundleType === 'conversation' && userMessages.length === 0) {
    const empty = [];
    empty.stats = extractionStats;
    return empty;
  }

  const chunks = Array.isArray(bundle.chunks) && bundle.chunks.length
    ? bundle.chunks
    : [{
      chunkIndex: 0,
      lineStart: 1,
      lineEnd: String((bundle.bundleType === 'conversation'
        ? userMessages.map((message) => `USER: ${message.text}`).join('\n')
        : bundle.content) || '').split('\n').length,
      text: (bundle.bundleType === 'conversation'
        ? userMessages.map((message) => `USER: ${message.text}`).join('\n')
        : bundle.content) || '',
    }];
  const options = {
    typeWhitelist: ['Decision', 'Task', 'Insight', 'Area', 'Event'],
    minConfidence: bundle.bundleType === 'conversation' ? 0.74 : 0.7,
  };

  const grouped = new Map();
  for (const chunk of chunks) {
    const items = distillChunk({
      source: {
        sourceType: bundle.bundleType === 'conversation' ? 'session' : (bundle.sourceType || 'obsidian'),
        sourcePath: bundle.sourcePath,
        mtimeMs: Date.now(),
        projectId: bundle.projectId || null,
        sourceAuthority: bundle.bundleType === 'conversation' ? 0.8 : 1,
        defaultState: 'candidate',
        scopeLevel: bundle.projectId ? 'project' : 'global',
      },
      chunk,
      options,
    });

    for (const item of items) {
      let draft = draftFromItem(item, chunk, bundle, config);
      if (bundle.bundleType === 'conversation') {
        draft = applyAssistantEvidence(draft, bundle, assistantMessages);
        const assistantEvidenceCount = Array.isArray(draft.evidence)
          ? draft.evidence.filter((evidence) => evidence.role === 'assistant').length
          : 0;
        extractionStats.assistantEvidenceAttachedCount += assistantEvidenceCount;
      }
      const current = grouped.get(draft.topicKeyCandidate);
      grouped.set(draft.topicKeyCandidate, current ? mergeDrafts(current, draft) : draft);
    }
  }

  const drafts = Array.from(grouped.values()).slice(0, bundle.bundleType === 'conversation' ? 5 : 8);
  extractionStats.userFactCandidateCount = drafts.length;
  drafts.stats = extractionStats;
  return drafts;
}

module.exports = {
  extractBundleCards,
};
