'use strict';

const { retrieveRanked } = require('./retrieve');

function looksRisk(text) {
  return /\b(risk|issue|blocked|failed|failure|incident|timeout|error|debt)\b|风险|阻塞|失败|故障|报错|超时/i.test(text || '');
}

function looksQuestion(text) {
  return /\?|？|\b(should|whether|open question|待确认|是否)\b/i.test(text || '');
}

function addLine(out, title, items) {
  if (!items.length) return;
  out.push(`## ${title}`);
  for (const item of items) {
    out.push(`- [${item.id}] ${item.title}`);
    const summary = item.meaningSummary || item.actionabilitySummary || item.contextSummary || item.body;
    out.push(`  ${summary}`);
    if (item.nextAction) {
      out.push(`  Next: ${item.nextAction}`);
    }
  }
  out.push('');
}

function markItemsUsed(db, itemIds) {
  if (!itemIds.length) return;
  const placeholders = itemIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE memory_items
    SET
      use_count = use_count + 1,
      last_used_at = ?
    WHERE id IN (${placeholders})
  `).run(new Date().toISOString(), ...itemIds);
}

function composeSections(retrieval) {
  const sections = {
    constraints: [],
    decisions: [],
    tasks: [],
    risks: [],
    openQuestions: [],
  };

  for (const item of retrieval.candidates) {
    if (item.type === 'Decision') {
      sections.decisions.push(item);
      continue;
    }

    if (item.type === 'Task') {
      sections.tasks.push(item);
      continue;
    }

    if (item.type === 'Area' || item.type === 'Insight') {
      sections.constraints.push(item);
      continue;
    }

    if (item.type === 'Event') {
      if (looksRisk(item.body)) sections.risks.push(item);
      else if (looksQuestion(item.body)) sections.openQuestions.push(item);
      else sections.constraints.push(item);
      continue;
    }

    if (item.type === 'Project') {
      sections.constraints.push(item);
      continue;
    }

    if (looksQuestion(item.body)) {
      sections.openQuestions.push(item);
      continue;
    }

    sections.constraints.push(item);
  }

  return sections;
}

function composeContext(db, {
  query,
  projectId = null,
  types = [],
  tokenBudget = 1200,
  includeCandidate = true,
  scopePolicy = 'layered',
  retrieval = null,
} = {}) {
  const retrievalResult = retrieval || retrieveRanked(db, {
    query,
    projectId,
    types,
    tokenBudget,
    includeCandidate,
    scopePolicy,
  });

  const sections = composeSections(retrievalResult);

  const lines = [];
  lines.push('# MEMORY CONTEXT');
  lines.push('');

  addLine(lines, 'Constraints', sections.constraints);
  addLine(lines, 'Decisions', sections.decisions);
  addLine(lines, 'Tasks', sections.tasks);
  addLine(lines, 'Risks', sections.risks);
  addLine(lines, 'Open Questions', sections.openQuestions);

  if (retrievalResult.relations.length) {
    lines.push('## Relations');
    for (const rel of retrievalResult.relations.slice(0, 40)) {
      lines.push(`- (${rel.relationType}) ${rel.fromItemId} -> ${rel.toItemId} ${rel.targetTitle || ''}`.trim());
    }
    lines.push('');
  }

  const citations = retrievalResult.candidates.map((item) => ({
    itemId: item.id,
    sourcePath: item.evidence.sourcePath,
    lineStart: item.evidence.lineStart,
    lineEnd: item.evidence.lineEnd,
    type: item.type,
    title: item.title,
    notionPageUrl: item.notionPageUrl || item.evidence.notionPageUrl || null,
    notionBlockAnchor: item.notionBlockAnchor || item.evidence.notionBlockAnchor || null,
    sourceSnippet: item.sourceSnippet || item.evidence.sourceSnippet || item.evidence.snippet || null,
    contextSummary: item.contextSummary || item.evidence.contextSummary || null,
    meaningSummary: item.meaningSummary || item.evidence.meaningSummary || null,
    actionabilitySummary: item.actionabilitySummary || item.evidence.actionabilitySummary || null,
    nextAction: item.nextAction || item.evidence.nextAction || null,
    ownerHint: item.ownerHint || item.evidence.ownerHint || null,
  }));

  markItemsUsed(db, retrievalResult.candidates.map((item) => item.id));

  return {
    query,
    projectId,
    tokenBudget,
    retrieval: retrievalResult,
    sections: {
      constraints: sections.constraints,
      decisions: sections.decisions,
      tasks: sections.tasks,
      risks: sections.risks,
      openQuestions: sections.openQuestions,
    },
    citations,
    contextText: lines.join('\n').trim(),
  };
}

module.exports = {
  composeContext,
};
