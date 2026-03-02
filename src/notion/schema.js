'use strict';

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function validateNotionConfig(config, env = process.env) {
  const notion = (((config || {}).storage || {}).notion) || {};
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
  if (docDataSourceIds.length === 0) warnings.push('storage.notion.docDataSourceIds is empty; notion sync will not import docs');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    settings: {
      tokenEnv,
      tokenPresent: Boolean(token),
      apiVersion: notion.apiVersion || '2025-09-03',
      memoryDataSourceId,
      relationsDataSourceId,
      docDataSourceIds,
      pollIntervalSec: Number(notion.pollIntervalSec || 120),
      cursor: notion.cursor || null,
      baseUrl: process.env.HIPPOCORE_NOTION_BASE_URL || 'https://api.notion.com',
    },
  };
}

module.exports = {
  validateNotionConfig,
  toArray,
};
