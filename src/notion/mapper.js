'use strict';

function notionPageUrl(pageId) {
  if (!pageId) return null;
  const compact = String(pageId).replace(/-/g, '');
  return `https://www.notion.so/${compact}`;
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

function buildMemoryProperties(row) {
  const type = String(row.type || 'Event');
  return {
    Title: { title: asTitle(row.title || `${type}: ${String(row.body || '').slice(0, 64)}`) },
    HippocoreId: { rich_text: asRichText(memoryHippocoreId(row.id)) },
    Type: { select: { name: type } },
    Body: { rich_text: asRichText(row.body || '') },
    State: { select: { name: String(row.state || 'candidate') } },
    ScopeLevel: { select: { name: String(row.scope_level || 'project') } },
    ProjectId: { rich_text: asRichText(row.project_id || '') },
    Confidence: { number: Number(row.confidence || 0) },
    Importance: { number: Number(row.importance || 0) },
    SourceAuthority: { number: Number(row.source_authority || 0) },
    FreshnessTs: { number: Number(row.freshness_ts || Date.now()) },
    SourcePath: { rich_text: asRichText(row.source_path || '') },
    LineStart: row.line_start == null ? { number: null } : { number: Number(row.line_start) },
    LineEnd: row.line_end == null ? { number: null } : { number: Number(row.line_end) },
  };
}

function buildRelationProperties({ fromPageId, toPageId, relationType = 'related_to', weight = 1, evidenceRef = '', relationId }) {
  return {
    HippocoreRelationId: { rich_text: asRichText(relationId) },
    RelationType: { select: { name: relationType } },
    Weight: { number: Number(weight || 1) },
    EvidenceRef: { rich_text: asRichText(evidenceRef || '') },
    From: { relation: fromPageId ? [{ id: fromPageId }] : [] },
    To: { relation: toPageId ? [{ id: toPageId }] : [] },
  };
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
};
