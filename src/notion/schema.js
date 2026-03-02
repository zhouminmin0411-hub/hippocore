'use strict';

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

const MEMORY_FIELD_SPECS = [
  { key: 'Title', type: 'title', required: true, aliases: ['Name', '标题'] },
  { key: 'HippocoreId', type: 'rich_text', required: true, aliases: ['MemoryId', 'Hippocore ID', 'HippoCoreId', 'ID'] },
  { key: 'Type', type: 'select', required: true, aliases: ['MemoryType', '类型', '类别'] },
  { key: 'Body', type: 'rich_text', required: true, aliases: ['Content', 'Text', '内容', 'Description'] },
  { key: 'State', type: 'select', required: true, aliases: ['Status', '状态'] },
  { key: 'ScopeLevel', type: 'select', required: false, aliases: ['Scope', 'Scope Level', '范围'] },
  { key: 'ProjectId', type: 'rich_text', required: false, aliases: ['Project', 'ProjectID', '项目'] },
  { key: 'Confidence', type: 'number', required: false, aliases: ['Score'] },
  { key: 'Importance', type: 'number', required: false, aliases: [] },
  { key: 'SourceAuthority', type: 'number', required: false, aliases: ['Authority'] },
  { key: 'FreshnessTs', type: 'number', required: false, aliases: ['Freshness'] },
  { key: 'SourcePath', type: 'rich_text', required: false, aliases: ['Source', 'Source File'] },
  { key: 'LineStart', type: 'number', required: false, aliases: [] },
  { key: 'LineEnd', type: 'number', required: false, aliases: [] },
];

const RELATION_FIELD_SPECS = [
  { key: 'HippocoreRelationId', type: 'rich_text', required: true, aliases: ['RelationId', 'Hippocore Relation ID'] },
  { key: 'RelationType', type: 'select', required: true, aliases: ['Type', '关系类型'] },
  { key: 'From', type: 'relation', required: true, aliases: ['Source', 'FromItem'] },
  { key: 'To', type: 'relation', required: true, aliases: ['Target', 'ToItem'] },
  { key: 'Weight', type: 'number', required: false, aliases: [] },
  { key: 'EvidenceRef', type: 'rich_text', required: false, aliases: ['Evidence'] },
];

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function getDataSourceProperties(dataSource) {
  if (!dataSource || typeof dataSource !== 'object') return {};
  const properties = dataSource.properties;
  if (!properties || typeof properties !== 'object') return {};
  return properties;
}

function findPropertyByNames(properties, names = [], expectedType = null) {
  const normalized = new Map();
  for (const [name, def] of Object.entries(properties || {})) {
    normalized.set(normalizeName(name), {
      name,
      type: String((def && def.type) || '').trim(),
    });
  }

  for (const candidate of names) {
    const hit = normalized.get(normalizeName(candidate));
    if (!hit) continue;
    if (!expectedType || hit.type === expectedType) return hit;
  }
  return null;
}

function validateStructuredSchema(dataSource, fieldSpecs) {
  const properties = getDataSourceProperties(dataSource);
  const mapping = {};
  const missingRequired = [];
  const warnings = [];

  for (const spec of fieldSpecs) {
    const hit = findPropertyByNames(
      properties,
      [spec.key, ...(Array.isArray(spec.aliases) ? spec.aliases : [])],
      spec.type || null,
    );
    if (hit) {
      mapping[spec.key] = hit.name;
      continue;
    }

    mapping[spec.key] = null;
    if (spec.required) {
      missingRequired.push(spec.key);
    } else {
      warnings.push(`Optional field missing: ${spec.key}`);
    }
  }

  return {
    ok: missingRequired.length === 0,
    mapping,
    missingRequired,
    warnings,
  };
}

function validateDocSourceSchema(dataSource) {
  const properties = getDataSourceProperties(dataSource);
  const textFields = [];

  for (const [name, def] of Object.entries(properties)) {
    const type = String((def && def.type) || '').trim();
    if (type === 'title' || type === 'rich_text') {
      textFields.push(name);
    }
  }

  return {
    ok: textFields.length > 0,
    mapping: {},
    missingRequired: textFields.length > 0 ? [] : ['title_or_rich_text_field'],
    warnings: [],
    textFields,
  };
}

function validateNotionDataSourceSchema(dataSource, { kind = 'memory' } = {}) {
  const normalizedKind = String(kind || 'memory').toLowerCase();
  if (normalizedKind === 'doc' || normalizedKind === 'docs') {
    const doc = validateDocSourceSchema(dataSource);
    return {
      kind: 'doc',
      ...doc,
    };
  }
  if (normalizedKind === 'relation' || normalizedKind === 'relations') {
    const relation = validateStructuredSchema(dataSource, RELATION_FIELD_SPECS);
    return {
      kind: 'relation',
      ...relation,
    };
  }

  const memory = validateStructuredSchema(dataSource, MEMORY_FIELD_SPECS);
  return {
    kind: 'memory',
    ...memory,
  };
}

function formatSchemaIssueMessage(result, label) {
  if (!result || result.ok) return null;
  const missing = Array.isArray(result.missingRequired) ? result.missingRequired.join(', ') : 'unknown';
  return `${label} schema incompatible: missing required fields (${missing})`;
}

function validateNotionConfig(config, env = process.env, options = {}) {
  const notion = (((config || {}).storage || {}).notion) || {};
  const requireDocSources = Boolean(options && options.requireDocSources);
  const tokenEnv = notion.tokenEnv || 'NOTION_API_KEY';
  const token = env[tokenEnv] || null;

  const memoryDataSourceId = notion.memoryDataSourceId || null;
  const relationsDataSourceId = notion.relationsDataSourceId || null;
  const docDataSourceIds = toArray(notion.docDataSourceIds);

  const errors = [];
  const warnings = [];

  if (!token) errors.push(`Missing Notion token in env var ${tokenEnv}`);
  if (!memoryDataSourceId) errors.push('Missing storage.notion.memoryDataSourceId');
  if (!relationsDataSourceId) warnings.push('storage.notion.relationsDataSourceId is empty; relation sync/migrate will be limited');
  if (docDataSourceIds.length === 0) {
    if (requireDocSources) {
      errors.push('Missing storage.notion.docDataSourceIds (required for onboarding/doctor)');
    } else {
      warnings.push('storage.notion.docDataSourceIds is empty; notion sync will not import docs');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    docSourcesReady: docDataSourceIds.length > 0,
    docSourcesCount: docDataSourceIds.length,
    settings: {
      tokenEnv,
      tokenPresent: Boolean(token),
      apiVersion: notion.apiVersion || '2025-09-03',
      memoryDataSourceId,
      relationsDataSourceId,
      docDataSourceIds,
      docSourcesReady: docDataSourceIds.length > 0,
      docSourcesCount: docDataSourceIds.length,
      pollIntervalSec: Number(notion.pollIntervalSec || 120),
      cursor: notion.cursor || null,
      baseUrl: process.env.HIPPOCORE_NOTION_BASE_URL || 'https://api.notion.com',
    },
  };
}

module.exports = {
  validateNotionConfig,
  validateNotionDataSourceSchema,
  formatSchemaIssueMessage,
  toArray,
};
