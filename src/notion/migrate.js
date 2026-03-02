'use strict';

const {
  buildMemoryProperties,
  buildRelationProperties,
  memoryHippocoreId,
  relationHippocoreId,
} = require('./mapper');

async function findPageByRichTextEquals(client, dataSourceId, property, value) {
  const out = await client.queryDataSource(dataSourceId, {
    filter: {
      property,
      rich_text: { equals: value },
    },
    page_size: 1,
  });
  const first = Array.isArray(out.results) && out.results.length ? out.results[0] : null;
  return first || null;
}

function findPageByRichTextEqualsSync(client, dataSourceId, property, value) {
  const out = client.queryDataSourceSync(dataSourceId, {
    filter: {
      property,
      rich_text: { equals: value },
    },
    page_size: 1,
  });
  const first = Array.isArray(out.results) && out.results.length ? out.results[0] : null;
  return first || null;
}

async function upsertMemoryRow(client, dataSourceId, row) {
  const propertyMap = null;
  const idProperty = 'HippocoreId';
  return upsertMemoryRowWithSchema(client, dataSourceId, row, { propertyMap, idProperty });
}

async function upsertMemoryRowWithSchema(client, dataSourceId, row, { propertyMap = null, idProperty = null } = {}) {
  const key = memoryHippocoreId(row.id);
  const lookupField = (idProperty && String(idProperty).trim())
    ? String(idProperty).trim()
    : 'HippocoreId';
  const properties = buildMemoryProperties(row, { propertyMap });
  const existing = await findPageByRichTextEquals(client, dataSourceId, lookupField, key);

  if (!existing) {
    const created = await client.createPage({
      parentDataSourceId: dataSourceId,
      properties,
    });
    return { pageId: created.id, created: true };
  }

  await client.updatePage(existing.id, { properties });
  return { pageId: existing.id, created: false };
}

function upsertMemoryRowSync(client, dataSourceId, row, { propertyMap = null, idProperty = null } = {}) {
  const key = memoryHippocoreId(row.id);
  const lookupField = (idProperty && String(idProperty).trim())
    ? String(idProperty).trim()
    : 'HippocoreId';
  const properties = buildMemoryProperties(row, { propertyMap });
  const existing = findPageByRichTextEqualsSync(client, dataSourceId, lookupField, key);

  if (!existing) {
    const created = client.createPageSync({
      parentDataSourceId: dataSourceId,
      properties,
    });
    return { pageId: created.id, created: true };
  }

  client.updatePageSync(existing.id, { properties });
  return { pageId: existing.id, created: false };
}

async function upsertRelationRow(client, dataSourceId, rel, pageIdMap) {
  return upsertRelationRowWithSchema(client, dataSourceId, rel, pageIdMap, {
    propertyMap: null,
    idProperty: 'HippocoreRelationId',
  });
}

async function upsertRelationRowWithSchema(
  client,
  dataSourceId,
  rel,
  pageIdMap,
  { propertyMap = null, idProperty = null } = {},
) {
  const fromPageId = pageIdMap.get(rel.from_item_id) || null;
  const toPageId = pageIdMap.get(rel.to_item_id) || null;
  if (!fromPageId || !toPageId) return { skipped: true };

  const key = relationHippocoreId(rel.from_item_id, rel.to_item_id, rel.relation_type);
  const properties = buildRelationProperties({
    fromPageId,
    toPageId,
    relationType: rel.relation_type,
    weight: rel.weight,
    evidenceRef: rel.evidence_ref,
    relationId: key,
  }, { propertyMap });

  const lookupField = (idProperty && String(idProperty).trim())
    ? String(idProperty).trim()
    : 'HippocoreRelationId';
  const existing = await findPageByRichTextEquals(client, dataSourceId, lookupField, key);
  if (!existing) {
    await client.createPage({
      parentDataSourceId: dataSourceId,
      properties,
    });
    return { skipped: false, created: true };
  }

  await client.updatePage(existing.id, { properties });
  return { skipped: false, created: false };
}

function upsertRelationRowSync(client, dataSourceId, rel, pageIdMap, { propertyMap = null, idProperty = null } = {}) {
  const fromPageId = pageIdMap.get(rel.from_item_id) || null;
  const toPageId = pageIdMap.get(rel.to_item_id) || null;
  if (!fromPageId || !toPageId) return { skipped: true };

  const key = relationHippocoreId(rel.from_item_id, rel.to_item_id, rel.relation_type);
  const properties = buildRelationProperties({
    fromPageId,
    toPageId,
    relationType: rel.relation_type,
    weight: rel.weight,
    evidenceRef: rel.evidence_ref,
    relationId: key,
  }, { propertyMap });

  const lookupField = (idProperty && String(idProperty).trim())
    ? String(idProperty).trim()
    : 'HippocoreRelationId';
  const existing = findPageByRichTextEqualsSync(client, dataSourceId, lookupField, key);
  if (!existing) {
    client.createPageSync({
      parentDataSourceId: dataSourceId,
      properties,
    });
    return { skipped: false, created: true };
  }

  client.updatePageSync(existing.id, { properties });
  return { skipped: false, created: false };
}

async function migrateAllToNotion({
  db,
  client,
  memoryDataSourceId,
  relationsDataSourceId,
  nowIso,
  schemaMaps = null,
} = {}) {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.type,
      m.title,
      m.body,
      m.state,
      m.scope_level,
      m.project_id,
      m.confidence,
      m.importance,
      m.source_authority,
      m.freshness_ts,
      (
        SELECT e.source_path
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id DESC
        LIMIT 1
      ) AS source_path,
      (
        SELECT e.line_start
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id DESC
        LIMIT 1
      ) AS line_start,
      (
        SELECT e.line_end
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id DESC
        LIMIT 1
      ) AS line_end
    FROM memory_items m
    ORDER BY m.id ASC
  `).all();

  let memoryCreated = 0;
  let memoryUpdated = 0;
  let relationCreated = 0;
  let relationUpdated = 0;
  const pageIdMap = new Map();
  const memoryPropertyMap = schemaMaps && schemaMaps.memory ? schemaMaps.memory : null;
  const relationPropertyMap = schemaMaps && schemaMaps.relation ? schemaMaps.relation : null;
  const memoryIdProperty = memoryPropertyMap && memoryPropertyMap.HippocoreId ? memoryPropertyMap.HippocoreId : 'HippocoreId';
  const relationIdProperty = relationPropertyMap && relationPropertyMap.HippocoreRelationId
    ? relationPropertyMap.HippocoreRelationId
    : 'HippocoreRelationId';

  for (const row of rows) {
    const out = await upsertMemoryRowWithSchema(client, memoryDataSourceId, row, {
      propertyMap: memoryPropertyMap,
      idProperty: memoryIdProperty,
    });
    pageIdMap.set(row.id, out.pageId);
    if (out.created) memoryCreated += 1;
    else memoryUpdated += 1;

    db.prepare(`
      UPDATE memory_items
      SET notion_page_id = ?, notion_last_synced_at = ?, remote_version = ?
      WHERE id = ?
    `).run(out.pageId, nowIso(), 'v1', row.id);
  }

  if (relationsDataSourceId) {
    const relations = db.prepare(`
      SELECT from_item_id, to_item_id, relation_type, weight, evidence_ref
      FROM relations
      ORDER BY id ASC
    `).all();

    for (const rel of relations) {
      const out = await upsertRelationRowWithSchema(client, relationsDataSourceId, rel, pageIdMap, {
        propertyMap: relationPropertyMap,
        idProperty: relationIdProperty,
      });
      if (out.skipped) continue;
      if (out.created) relationCreated += 1;
      else relationUpdated += 1;
    }
  }

  return {
    memory: {
      total: rows.length,
      created: memoryCreated,
      updated: memoryUpdated,
    },
    relations: {
      created: relationCreated,
      updated: relationUpdated,
    },
  };
}

function migrateAllToNotionSync({
  db,
  client,
  memoryDataSourceId,
  relationsDataSourceId,
  nowIso,
  schemaMaps = null,
} = {}) {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.type,
      m.title,
      m.body,
      m.state,
      m.scope_level,
      m.project_id,
      m.confidence,
      m.importance,
      m.source_authority,
      m.freshness_ts,
      (
        SELECT e.source_path
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id DESC
        LIMIT 1
      ) AS source_path,
      (
        SELECT e.line_start
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id DESC
        LIMIT 1
      ) AS line_start,
      (
        SELECT e.line_end
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id DESC
        LIMIT 1
      ) AS line_end
    FROM memory_items m
    ORDER BY m.id ASC
  `).all();

  let memoryCreated = 0;
  let memoryUpdated = 0;
  let relationCreated = 0;
  let relationUpdated = 0;
  const pageIdMap = new Map();
  const memoryPropertyMap = schemaMaps && schemaMaps.memory ? schemaMaps.memory : null;
  const relationPropertyMap = schemaMaps && schemaMaps.relation ? schemaMaps.relation : null;
  const memoryIdProperty = memoryPropertyMap && memoryPropertyMap.HippocoreId ? memoryPropertyMap.HippocoreId : 'HippocoreId';
  const relationIdProperty = relationPropertyMap && relationPropertyMap.HippocoreRelationId
    ? relationPropertyMap.HippocoreRelationId
    : 'HippocoreRelationId';

  for (const row of rows) {
    const out = upsertMemoryRowSync(client, memoryDataSourceId, row, {
      propertyMap: memoryPropertyMap,
      idProperty: memoryIdProperty,
    });
    pageIdMap.set(row.id, out.pageId);
    if (out.created) memoryCreated += 1;
    else memoryUpdated += 1;

    db.prepare(`
      UPDATE memory_items
      SET notion_page_id = ?, notion_last_synced_at = ?, remote_version = ?
      WHERE id = ?
    `).run(out.pageId, nowIso(), 'v1', row.id);
  }

  if (relationsDataSourceId) {
    const relations = db.prepare(`
      SELECT from_item_id, to_item_id, relation_type, weight, evidence_ref
      FROM relations
      ORDER BY id ASC
    `).all();

    for (const rel of relations) {
      const out = upsertRelationRowSync(client, relationsDataSourceId, rel, pageIdMap, {
        propertyMap: relationPropertyMap,
        idProperty: relationIdProperty,
      });
      if (out.skipped) continue;
      if (out.created) relationCreated += 1;
      else relationUpdated += 1;
    }
  }

  return {
    memory: {
      total: rows.length,
      created: memoryCreated,
      updated: memoryUpdated,
    },
    relations: {
      created: relationCreated,
      updated: relationUpdated,
    },
  };
}

module.exports = {
  migrateAllToNotion,
  upsertMemoryRow,
  migrateAllToNotionSync,
  upsertMemoryRowSync,
};
