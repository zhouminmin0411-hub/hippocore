'use strict';

const {
  buildReadableTitle,
  buildSourceDecisionPath,
  parseNotionSourcePath,
  sourceCategoryLabel,
} = require('../card');

function notionPageUrl(pageId) {
  if (!pageId) return null;
  const compact = String(pageId).replace(/-/g, '');
  return `https://www.notion.so/${compact}`;
}

function notionBlockUrl(pageId, blockId = null) {
  if (!pageId) return null;
  const pagePart = String(pageId).replace(/-/g, '');
  if (!blockId) return `https://www.notion.so/${pagePart}`;
  return `https://www.notion.so/${pagePart}#${String(blockId).replace(/-/g, '')}`;
}

function asTitle(text) {
  return [{ type: 'text', text: { content: String(text || '').slice(0, 2000) || 'Untitled' } }];
}

function asRichText(text) {
  if (text == null || text === '') return [];
  return [{ type: 'text', text: { content: String(text).slice(0, 2000) } }];
}

function memoryHippocoreId(itemId) {
  return `item-${itemId}`;
}

function relationHippocoreId(fromId, toId, relationType) {
  return `rel-${fromId}-${toId}-${relationType || 'related_to'}`;
}

function resolvePropertyName(propertyMap, key) {
  if (!propertyMap || typeof propertyMap !== 'object') return key;
  const mapped = propertyMap[key];
  if (typeof mapped !== 'string' || !mapped.trim()) return null;
  return mapped.trim();
}

function setProperty(target, propertyMap, key, value, { optional = false } = {}) {
  const resolved = resolvePropertyName(propertyMap, key);
  if (!resolved) {
    if (optional) return false;
    return false;
  }
  target[resolved] = value;
  return true;
}

function buildBodyWithEnrichmentFallback(row, { propertyMap = null } = {}) {
  const baseBody = String(row.display_body || row.body || '').trim();
  const notionSource = parseNotionSourcePath(row.source_path || '');
  const sourceUrl = notionBlockUrl(notionSource.pageId, notionSource.blockId);
  const sourceSummary = String(row.source_summary || row.context_summary || '').trim();
  const evidenceList = (() => {
    try {
      const parsed = row.evidence_json ? JSON.parse(row.evidence_json) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const readableTitle = buildReadableTitle({
    type: row.type || 'Event',
    title: row.title || '',
    body: row.body || '',
    meaningSummary: row.meaning_summary || '',
    actionabilitySummary: row.actionability_summary || '',
    nextAction: row.next_action || '',
  });
  const sourceDecisionPath = buildSourceDecisionPath({
    sourcePath: row.source_path || '',
    lineStart: row.line_start,
    lineEnd: row.line_end,
  });
  const sourceCategory = sourceCategoryLabel(
    row.source_path || '',
    `${row.body || ''} ${row.meaning_summary || ''}`,
  );
  const type = String(row.type || 'Event');
  const fallbackFields = [
    ['ContextSummary', 'Context', sourceSummary],
    ['MeaningSummary', 'Meaning', row.meaning_summary],
    ['ActionabilitySummary', 'Actionability', row.actionability_summary],
    ['NextAction', 'Next Action', row.next_action],
  ];

  const sections = [];
  for (const [key, label, rawValue] of fallbackFields) {
    const value = String(rawValue || '').trim();
    if (!value) continue;
    if (resolvePropertyName(propertyMap, key)) continue;
    sections.push(`${label}\n${value}`);
  }
  const parts = [baseBody];
  if (sections.length) {
    if (baseBody) parts.push('');
    parts.push(...sections);
  }
  if (!resolvePropertyName(propertyMap, 'Evidence') && evidenceList.length) {
    if (parts.length) parts.push('');
    parts.push('Evidence');
    for (const evidence of evidenceList.slice(0, 4)) {
      parts.push(`- ${String(evidence.snippet || '').trim()}`);
    }
  }
  if (!resolvePropertyName(propertyMap, 'SourceUrl') && sourceUrl) {
    if (parts.length) parts.push('');
    parts.push('Source');
    parts.push(sourceUrl);
  }
  if (!parts.filter(Boolean).length) {
    return readableTitle || baseBody || row.body || 'Untitled memory';
  }
  return parts.join('\n').trim();
}

function buildMemoryProperties(row, { propertyMap = null } = {}) {
  const type = String(row.type || 'Event');
  const out = {};
  const notionSource = parseNotionSourcePath(row.source_path || '');
  const sourceUrl = notionBlockUrl(notionSource.pageId, notionSource.blockId);
  const readableTitle = buildReadableTitle({
    type,
    title: row.title || '',
    body: row.body || '',
    meaningSummary: row.meaning_summary || '',
    actionabilitySummary: row.actionability_summary || '',
    nextAction: row.next_action || '',
  });
  const sourceDecisionPath = buildSourceDecisionPath({
    sourcePath: row.source_path || '',
    lineStart: row.line_start,
    lineEnd: row.line_end,
  });
  const sourceCategory = sourceCategoryLabel(
    row.source_path || '',
    `${row.body || ''} ${row.meaning_summary || ''}`,
  );
  const bodyForNotion = buildBodyWithEnrichmentFallback(row, { propertyMap });
  setProperty(out, propertyMap, 'Title', { title: asTitle(readableTitle) });
  setProperty(out, propertyMap, 'ReadableTitle', { rich_text: asRichText(readableTitle) }, { optional: true });
  setProperty(out, propertyMap, 'HippocoreId', { rich_text: asRichText(memoryHippocoreId(row.id)) });
  setProperty(out, propertyMap, 'Type', { select: { name: type } });
  setProperty(out, propertyMap, 'Body', { rich_text: asRichText(bodyForNotion) });
  setProperty(out, propertyMap, 'State', { select: { name: String(row.state || 'candidate') } });
  setProperty(out, propertyMap, 'ScopeLevel', { select: { name: String(row.scope_level || 'project') } }, { optional: true });
  setProperty(out, propertyMap, 'ProjectId', { rich_text: asRichText(row.project_id || '') }, { optional: true });
  setProperty(out, propertyMap, 'Confidence', { number: Number(row.confidence || 0) }, { optional: true });
  setProperty(out, propertyMap, 'Importance', { number: Number(row.importance || 0) }, { optional: true });
  setProperty(out, propertyMap, 'SourceAuthority', { number: Number(row.source_authority || 0) }, { optional: true });
  setProperty(out, propertyMap, 'FreshnessTs', { number: Number(row.freshness_ts || Date.now()) }, { optional: true });
  setProperty(out, propertyMap, 'SourcePath', { rich_text: asRichText(row.source_path || '') }, { optional: true });
  setProperty(
    out,
    propertyMap,
    'LineStart',
    row.line_start == null ? { number: null } : { number: Number(row.line_start) },
    { optional: true },
  );
  setProperty(
    out,
    propertyMap,
    'LineEnd',
    row.line_end == null ? { number: null } : { number: Number(row.line_end) },
    { optional: true },
  );
  setProperty(out, propertyMap, 'SourceCategory', { rich_text: asRichText(sourceCategory) }, { optional: true });
  setProperty(out, propertyMap, 'SourceDecisionPath', { rich_text: asRichText(sourceDecisionPath) }, { optional: true });
  setProperty(out, propertyMap, 'ContextSummary', { rich_text: asRichText(row.source_summary || row.context_summary || '') }, { optional: true });
  setProperty(out, propertyMap, 'MeaningSummary', { rich_text: asRichText(row.meaning_summary || '') }, { optional: true });
  setProperty(out, propertyMap, 'ActionabilitySummary', { rich_text: asRichText(row.actionability_summary || '') }, { optional: true });
  setProperty(out, propertyMap, 'NextAction', { rich_text: asRichText(row.next_action || '') }, { optional: true });
  setProperty(out, propertyMap, 'OwnerHint', { rich_text: asRichText(row.owner_hint || '') }, { optional: true });
  setProperty(out, propertyMap, 'ProjectDisplayName', { rich_text: asRichText(row.project_display_name || '') }, { optional: true });
  if (sourceUrl) {
    setProperty(out, propertyMap, 'SourceUrl', { url: sourceUrl }, { optional: true });
  }
  const evidenceText = (() => {
    try {
      const parsed = row.evidence_json ? JSON.parse(row.evidence_json) : [];
      if (!Array.isArray(parsed)) return '';
      return parsed
        .slice(0, 4)
        .map((entry) => String(entry.snippet || '').trim())
        .filter(Boolean)
        .join('\n');
    } catch {
      return '';
    }
  })();
  setProperty(out, propertyMap, 'Evidence', { rich_text: asRichText(evidenceText) }, { optional: true });
  return out;
}

function buildRelationProperties(
  {
    fromPageId,
    toPageId,
    relationType = 'related_to',
    weight = 1,
    evidenceRef = '',
    relationId,
  },
  { propertyMap = null } = {},
) {
  const out = {};
  setProperty(out, propertyMap, 'HippocoreRelationId', { rich_text: asRichText(relationId) });
  setProperty(out, propertyMap, 'RelationType', { select: { name: relationType } });
  setProperty(out, propertyMap, 'Weight', { number: Number(weight || 1) }, { optional: true });
  setProperty(out, propertyMap, 'EvidenceRef', { rich_text: asRichText(evidenceRef || '') }, { optional: true });
  setProperty(out, propertyMap, 'From', { relation: fromPageId ? [{ id: fromPageId }] : [] });
  setProperty(out, propertyMap, 'To', { relation: toPageId ? [{ id: toPageId }] : [] });
  return out;
}

function parseNotionPropertyText(prop) {
  if (!prop || typeof prop !== 'object') return '';
  if (Array.isArray(prop.title)) return prop.title.map((x) => x.plain_text || '').join(' ').trim();
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((x) => x.plain_text || '').join(' ').trim();
  if (prop.type === 'select' && prop.select) return String(prop.select.name || '').trim();
  if (prop.type === 'number' && Number.isFinite(prop.number)) return String(prop.number);
  if (prop.type === 'url' && prop.url) return String(prop.url);
  if (prop.type === 'date' && prop.date && prop.date.start) return String(prop.date.start);
  return '';
}

function notionPageToText(page) {
  const properties = (page && page.properties) || {};
  const chunks = [];
  for (const [key, value] of Object.entries(properties)) {
    const text = parseNotionPropertyText(value);
    if (!text) continue;
    chunks.push(`${key}: ${text}`);
  }
  return chunks.join('\n').trim();
}

module.exports = {
  notionPageUrl,
  asRichText,
  asTitle,
  memoryHippocoreId,
  relationHippocoreId,
  buildMemoryProperties,
  buildRelationProperties,
  notionPageToText,
  notionBlockUrl,
};
