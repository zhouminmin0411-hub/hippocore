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

function toUuid(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const compact = raw.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function extractNotionIdFromText(value) {
  const input = String(value || '');
  if (!input) return null;
  const direct = toUuid(input);
  if (direct) return direct;

  const hit = input.match(/[0-9a-fA-F]{32}/);
  if (hit && hit[0]) return toUuid(hit[0]);

  const uuidHit = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (uuidHit && uuidHit[0]) return toUuid(uuidHit[0]);
  return null;
}

function parseWatchRoot(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let kind = null;
  let payload = raw;
  const prefixed = /^(page|data[_-]?source|database|ds)\s*[:：]\s*(.+)$/i.exec(raw);
  if (prefixed && prefixed[1] && prefixed[2]) {
    kind = /^page$/i.test(prefixed[1]) ? 'page' : 'data_source';
    payload = prefixed[2].trim();
  }

  const id = extractNotionIdFromText(payload);
  if (!id) return null;
  if (!kind) kind = 'page';
  return { kind, id, raw };
}

function normalizeWatchRoots(watchRoots) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(watchRoots) ? watchRoots : []) {
    const parsed = parseWatchRoot(raw);
    if (!parsed) continue;
    const key = `${parsed.kind}:${parsed.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
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

function getPageSyncSafe(client, pageId) {
  try {
    return client.getPageSync(pageId);
  } catch {
    return null;
  }
}

function collectDescendantRefsSync({
  client,
  rootBlockId,
  maxDepth = 4,
  maxVisitedBlocks = 3000,
}) {
  const childPageIds = new Set();
  const childDataSourceIds = new Set();
  const visitedBlocks = new Set();

  function walk(blockId, depth) {
    if (!blockId) return;
    const normalizedBlockId = toUuid(blockId) || String(blockId);
    if (visitedBlocks.has(normalizedBlockId)) return;
    if (visitedBlocks.size >= maxVisitedBlocks) return;
    visitedBlocks.add(normalizedBlockId);

    let children = [];
    try {
      children = listBlockChildrenSync(client, blockId);
    } catch {
      children = [];
    }

    for (const block of children) {
      const type = String((block && block.type) || '').trim();
      if (type === 'child_page' && block && block.id) {
        const pageId = toUuid(block.id);
        if (pageId) childPageIds.add(pageId);
      } else if (type === 'child_database' && block && block.id) {
        const dataSourceId = toUuid(block.id);
        if (dataSourceId) childDataSourceIds.add(dataSourceId);
      }

      if (block && block.has_children && depth < maxDepth) {
        walk(block.id, depth + 1);
      }
    }
  }

  walk(rootBlockId, 0);
  return {
    childPageIds: Array.from(childPageIds),
    childDataSourceIds: Array.from(childDataSourceIds),
  };
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

function pageToSource(page, { dataSourceId = null, watchRootId = null, blockEntries = [] } = {}) {
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
    ...(watchRootId ? [`notion_watch_root: ${watchRootId}`] : []),
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
      notionWatchRoot: watchRootId || null,
      notionBlockAnchor,
      notionSnippet: snippet,
    },
  };
}

function fetchNotionDocSourcesSync({
  client,
  docDataSourceIds = [],
  watchRoots = [],
  watchMaxDepth = 4,
  cursor = null,
} = {}) {
  const normalizedCursor = normalizeCursor(cursor);
  const allSources = [];
  let maxEdited = normalizedCursor;
  const seenPageIds = new Set();
  const normalizedWatchRoots = normalizeWatchRoots(watchRoots);

  const pendingDataSourceIds = [];
  const queuedDataSourceIds = new Set();
  const pendingPages = [];
  const queuedPages = new Set();

  function enqueueDataSource(dataSourceId) {
    const normalized = String(dataSourceId || '').trim();
    if (!normalized) return;
    if (queuedDataSourceIds.has(normalized)) return;
    queuedDataSourceIds.add(normalized);
    pendingDataSourceIds.push(normalized);
  }

  function enqueuePage(pageId, watchRootId = null) {
    const normalized = toUuid(pageId);
    if (!normalized) return;
    if (seenPageIds.has(normalized) || queuedPages.has(normalized)) return;
    queuedPages.add(normalized);
    pendingPages.push({
      pageId: normalized,
      watchRootId: toUuid(watchRootId) || watchRootId || null,
    });
  }

  for (const dataSourceId of docDataSourceIds) enqueueDataSource(dataSourceId);
  for (const root of normalizedWatchRoots) {
    if (root.kind === 'data_source') enqueueDataSource(root.id);
    else enqueuePage(root.id, root.id);
  }

  function collectAndQueueDescendants(pageId, watchRootId = null) {
    const refs = collectDescendantRefsSync({
      client,
      rootBlockId: pageId,
      maxDepth: watchMaxDepth,
    });
    for (const childPageId of refs.childPageIds) enqueuePage(childPageId, watchRootId || pageId);
    for (const childDataSourceId of refs.childDataSourceIds) enqueueDataSource(childDataSourceId);
  }

  function importPage(page, { dataSourceId = null, watchRootId = null } = {}) {
    const pageId = toUuid(page && page.id);
    if (!pageId || seenPageIds.has(pageId)) return;
    seenPageIds.add(pageId);

    const edited = normalizeCursor(page.last_edited_time);
    collectAndQueueDescendants(pageId, watchRootId || pageId);

    if (!edited) return;
    if (normalizedCursor && edited <= normalizedCursor) return;

    let blockEntries = [];
    try {
      blockEntries = collectBlockTextsSync({ client, blockId: pageId });
    } catch {
      blockEntries = [];
    }
    const source = pageToSource(page, { dataSourceId, watchRootId, blockEntries });
    if (!source) return;
    allSources.push(source);
    if (!maxEdited || edited > maxEdited) maxEdited = edited;
  }

  let dsIdx = 0;
  let pageIdx = 0;
  while (dsIdx < pendingDataSourceIds.length || pageIdx < pendingPages.length) {
    if (dsIdx < pendingDataSourceIds.length) {
      const dataSourceId = pendingDataSourceIds[dsIdx];
      dsIdx += 1;
      let pages = [];
      try {
        pages = queryAllPagesSync(client, dataSourceId);
      } catch {
        pages = [];
      }
      for (const page of pages) {
        importPage(page, { dataSourceId, watchRootId: dataSourceId });
      }
      continue;
    }

    const entry = pendingPages[pageIdx];
    pageIdx += 1;
    const page = getPageSyncSafe(client, entry.pageId);
    if (!page) continue;
    importPage(page, { watchRootId: entry.watchRootId || entry.pageId });
  }

  return {
    sources: allSources,
    newCursor: maxEdited,
    importedCount: allSources.length,
  };
}

async function fetchNotionDocSources(options = {}) {
  return fetchNotionDocSourcesSync(options);
}

module.exports = {
  fetchNotionDocSources,
  fetchNotionDocSourcesSync,
};
