'use strict';

const { sha256 } = require('../hash');
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

function pageToSource(page) {
  const pageId = page.id;
  const edited = page.last_edited_time || new Date().toISOString();
  const text = notionPageToText(page);
  if (!text) return null;

  const content = [
    `# Notion ${pageId}`,
    `notion_page_id: ${pageId}`,
    `last_edited_time: ${edited}`,
    '',
    text,
    '',
  ].join('\n');

  return {
    sourceType: 'notion',
    sourcePath: `notion:${pageId}`,
    mtimeMs: Date.parse(edited) || Date.now(),
    content,
    contentHash: sha256(content),
    scopeLevel: 'global',
    projectId: null,
    sourceAuthority: 1.0,
    defaultState: 'verified',
    metadata: {
      notionPageId: pageId,
      notionLastEdited: edited,
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
      const source = pageToSource(page);
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
      const source = pageToSource(page);
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
