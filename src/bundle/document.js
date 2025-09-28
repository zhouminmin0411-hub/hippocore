'use strict';

const path = require('path');
const { sha256 } = require('../hash');
const { compact, normalizeOneLine } = require('./types');

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

function resolveDocumentOriginKey(source) {
  const sourcePath = String(source && source.sourcePath ? source.sourcePath : '').trim();
  const metadata = (source && source.metadata && typeof source.metadata === 'object') ? source.metadata : {};
  const stableId = metadata.hippocore_source_id || metadata.memory_source_id || metadata.source_id || null;
  if (stableId) return `doc-source:${String(stableId).trim()}`;
  if (sourcePath.startsWith('notion:')) {
    const parsed = parseNotionSourcePath(sourcePath);
    if (parsed.pageId) return `notion-page:${parsed.pageId}`;
  }
  return `file:${path.resolve(sourcePath || 'unknown-document')}`;
}

function resolveDocumentTitle(source) {
  const metadata = (source && source.metadata && typeof source.metadata === 'object') ? source.metadata : {};
  if (metadata.title) return compact(metadata.title, 120);
  const sourcePath = String(source && source.sourcePath ? source.sourcePath : '').trim();
  if (sourcePath.startsWith('notion:')) return 'Notion document';
  const base = path.basename(sourcePath || '', path.extname(sourcePath || ''));
  return compact(normalizeOneLine(base), 120) || 'Document';
}

function buildDocumentBundle(source, chunkRows = []) {
  const content = String(source && source.content ? source.content : '').trim();
  const originKey = resolveDocumentOriginKey(source);
  return {
    id: `bundle:${sha256(`document|${originKey}|${source && source.contentHash ? source.contentHash : content}`)}`,
    bundleType: 'document',
    sourcePath: source.sourcePath,
    sourceOriginKey: originKey,
    sourceTitle: resolveDocumentTitle(source),
    sourceHash: String(source && source.contentHash ? source.contentHash : sha256(content)),
    projectId: source.projectId || null,
    content,
    metadata: source.metadata || {},
    chunks: Array.isArray(chunkRows) ? chunkRows : [],
    sourceType: source.sourceType || 'document',
  };
}

module.exports = {
  buildDocumentBundle,
  resolveDocumentOriginKey,
};
