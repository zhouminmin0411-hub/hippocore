'use strict';

const { sha256 } = require('../hash');
const { DISTILL_VERSION } = require('../ingest');
const { notionPageToText } = require('./mapper');

function normalizeCursor(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

async function queryAllPages(client, dataSourceId) {
  const pages = [];
  let cursor = null;
  do {
    const out = await client.queryDataSource(dataSourceId, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    });
    pages.push(...(out.results || []));
    cursor = out.has_more ? out.next_cursor : null;
  } while (cursor);
  return pages;
}

function queryAllPagesSync(client, dataSourceId) {
  const pages = [];
  let cursor = null;
  do {
    const out = client.queryDataSourceSync(dataSourceId, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    });
    pages.push(...(out.results || []));
    cursor = out.has_more ? out.next_cursor : null;
  } while (cursor);
  return pages;
}

function richTextArrayToText(value) {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => item && (item.plain_text || (item.text && item.text.content) || ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function blockToText(block) {
  if (!block || typeof block !== 'object') return { id: null, text: '' };
  const type = String(block.type || '').trim();
  if (!type) return { id: block.id || null, text: '' };
  const payload = (block[type] && typeof block[type] === 'object') ? block[type] : {};
  let text = '';
  let prefix = '';

  switch (type) {
    case 'heading_1':
      prefix = '# ';
      text = richTextArrayToText(payload.rich_text);
      break;
    case 'heading_2':
      prefix = '## ';
      text = richTextArrayToText(payload.rich_text);
      break;
    case 'heading_3':
      prefix = '### ';
      text = richTextArrayToText(payload.rich_text);
      break;
    case 'paragraph':
    case 'quote':
    case 'callout':
    case 'toggle':
    case 'bulleted_list_item':
    case 'numbered_list_item':
      text = richTextArrayToText(payload.rich_text);
      break;
    case 'to_do':
      prefix = payload.checked ? '- [x] ' : '- [ ] ';
      text = richTextArrayToText(payload.rich_text);
      break;
    case 'code':
      text = richTextArrayToText(payload.rich_text);
      if (payload.language) {
        text = `${String(payload.language)}: ${text}`.trim();
      }
      break;
    case 'child_page':
      text = String(payload.title || '').trim();
      break;
    case 'bookmark':
      text = String(payload.url || '').trim();
      break;
    default:
      text = richTextArrayToText(payload.rich_text);
      break;
  }

  const formatted = `${prefix}${text}`.trim();
  return { id: block.id || null, text: formatted };
}

async function listBlockChildren(client, blockId) {
  const blocks = [];
  let cursor = null;
  do {
    const out = await client.retrieveBlockChildren(blockId, cursor);
    blocks.push(...(out.results || []));
    cursor = out.has_more ? out.next_cursor : null;
  } while (cursor);
  return blocks;
}

function listBlockChildrenSync(client, blockId) {
  const blocks = [];
  let cursor = null;
  do {
    const out = client.retrieveBlockChildrenSync(blockId, cursor);
    blocks.push(...(out.results || []));
    cursor = out.has_more ? out.next_cursor : null;
  } while (cursor);
  return blocks;
}

async function collectBlockTexts({
  client,
  blockId,
  depth = 0,
  maxDepth = 2,
  maxBlocks = 400,
  sink = [],
}) {
  if (!blockId || sink.length >= maxBlocks) return sink;
  const children = await listBlockChildren(client, blockId);
  for (const block of children) {
    if (sink.length >= maxBlocks) break;
    const rendered = blockToText(block);
    if (rendered.text) sink.push(rendered);
    if (block && block.has_children && depth < maxDepth) {
      await collectBlockTexts({
        client,
        blockId: block.id,
        depth: depth + 1,
        maxDepth,
        maxBlocks,
        sink,
      });
    }
  }
  return sink;
}

function collectBlockTextsSync({
  client,
  blockId,
  depth = 0,
  maxDepth = 2,
  maxBlocks = 400,
  sink = [],
}) {
  if (!blockId || sink.length >= maxBlocks) return sink;
  const children = listBlockChildrenSync(client, blockId);
  for (const block of children) {
    if (sink.length >= maxBlocks) break;
    const rendered = blockToText(block);
    if (rendered.text) sink.push(rendered);
    if (block && block.has_children && depth < maxDepth) {
      collectBlockTextsSync({
        client,
        blockId: block.id,
        depth: depth + 1,
        maxDepth,
        maxBlocks,
        sink,
      });
    }
  }
  return sink;
}

function pageToSource(page, { dataSourceId = null, blockEntries = [] } = {}) {
  const pageId = page.id;
  const edited = page.last_edited_time || new Date().toISOString();
  const propertyText = notionPageToText(page);
  const blockText = Array.isArray(blockEntries)
    ? blockEntries.map((entry) => String(entry && entry.text ? entry.text : '')).filter(Boolean).join('\n').trim()
    : '';
  const text = [propertyText, blockText].filter(Boolean).join('\n\n').trim();
  if (!text) return null;
  const notionBlockAnchor = Array.isArray(blockEntries)
    ? (blockEntries.find((entry) => entry && entry.id) || {}).id || null
    : null;
  const sourcePath = notionBlockAnchor
    ? `notion:${pageId}#${notionBlockAnchor}`
    : `notion:${pageId}`;
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 320);
  const header = [
    `# Notion ${pageId}`,
    `notion_page_id: ${pageId}`,
    ...(dataSourceId ? [`notion_data_source_id: ${dataSourceId}`] : []),
    `last_edited_time: ${edited}`,
    ...(notionBlockAnchor ? [`notion_block_anchor: ${notionBlockAnchor}`] : []),
    '',
  ];

  const content = [...header, text, ''].join('\n');

  return {
    sourceType: 'notion',
    sourcePath,
    mtimeMs: Date.parse(edited) || Date.now(),
    content,
    contentHash: sha256(`${DISTILL_VERSION}\n${content}`),
    scopeLevel: 'global',
    projectId: null,
    sourceAuthority: 1.0,
    defaultState: 'verified',
    metadata: {
      notionPageId: pageId,
      notionLastEdited: edited,
      notionDataSourceId: dataSourceId || null,
      notionBlockAnchor,
      notionSnippet: snippet,
    },
  };
}

async function fetchNotionDocSources({ client, docDataSourceIds = [], cursor = null }) {
  const normalizedCursor = normalizeCursor(cursor);
  const allSources = [];
  let maxEdited = normalizedCursor;

  for (const dataSourceId of docDataSourceIds) {
    const pages = await queryAllPages(client, dataSourceId);
    for (const page of pages) {
      const edited = normalizeCursor(page.last_edited_time);
      if (!edited) continue;
      if (normalizedCursor && edited <= normalizedCursor) continue;
      let blockEntries = [];
      try {
        blockEntries = await collectBlockTexts({ client, blockId: page.id });
      } catch {
        blockEntries = [];
      }
      const source = pageToSource(page, { dataSourceId, blockEntries });
      if (!source) continue;
      allSources.push(source);
      if (!maxEdited || edited > maxEdited) maxEdited = edited;
    }
  }

  return {
    sources: allSources,
    newCursor: maxEdited,
    importedCount: allSources.length,
  };
}

function fetchNotionDocSourcesSync({ client, docDataSourceIds = [], cursor = null }) {
  const normalizedCursor = normalizeCursor(cursor);
  const allSources = [];
  let maxEdited = normalizedCursor;

  for (const dataSourceId of docDataSourceIds) {
    const pages = queryAllPagesSync(client, dataSourceId);
    for (const page of pages) {
      const edited = normalizeCursor(page.last_edited_time);
      if (!edited) continue;
      if (normalizedCursor && edited <= normalizedCursor) continue;
      let blockEntries = [];
      try {
        blockEntries = collectBlockTextsSync({ client, blockId: page.id });
      } catch {
        blockEntries = [];
      }
      const source = pageToSource(page, { dataSourceId, blockEntries });
      if (!source) continue;
      allSources.push(source);
      if (!maxEdited || edited > maxEdited) maxEdited = edited;
    }
  }

  return {
    sources: allSources,
    newCursor: maxEdited,
    importedCount: allSources.length,
  };
}

module.exports = {
  fetchNotionDocSources,
  fetchNotionDocSourcesSync,
};
