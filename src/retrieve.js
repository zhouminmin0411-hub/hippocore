'use strict';

const { sha256 } = require('./hash');

function computeFreshnessScore(freshnessTs, nowTs = Date.now()) {
  const ageMs = Math.max(0, nowTs - Number(freshnessTs || nowTs));
  const halfLifeMs = 1000 * 60 * 60 * 24 * 30;
  return Math.exp(-ageMs / halfLifeMs);
}

function normalizeRelevance(bm25Value) {
  const raw = Number.isFinite(bm25Value) ? bm25Value : 100;
  const nonNegative = Math.max(0, raw);
  return 1 / (1 + nonNegative);
}

function parseTypes(types) {
  if (!types) return new Set();
  if (Array.isArray(types)) return new Set(types.filter(Boolean));
  if (typeof types === 'string') {
    return new Set(types.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return new Set();
}

function scopeBoost(row, projectId) {
  const sameProject = Boolean(projectId) && row.project_id === projectId;
  if (row.state === 'verified') {
    if (row.scope_level === 'project' && sameProject) return 1.0;
    if (row.scope_level === 'global') return 0.8;
    if (row.scope_level === 'project' && !sameProject) return 0.6;
    return 0.6;
  }

  // candidate / temp fallback.
  if (sameProject || row.scope_level === 'temp') return 0.7;
  return 0.4;
}

function writeRetrievalLog(db, payload) {
  db.prepare(`
    INSERT INTO retrieval_logs(
      query_hash,
      query_text,
      project_id,
      candidate_count,
      used_items,
      latency_ms,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.queryHash,
    payload.queryText,
    payload.projectId,
    payload.candidateCount,
    payload.usedItems,
    payload.latencyMs,
    payload.createdAt,
  );
}

function fetchRelationEdges(db, itemIds) {
  if (!itemIds.length) return [];
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      r.from_item_id,
      r.to_item_id,
      r.relation_type,
      r.weight,
      r.evidence_ref,
      t.title AS target_title,
      t.type AS target_type
    FROM relations r
    JOIN memory_items t ON t.id = r.to_item_id
    WHERE r.from_item_id IN (${placeholders})
    ORDER BY r.weight DESC, r.id DESC
    LIMIT 300
  `).all(...itemIds);

  return rows.map((row) => ({
    fromItemId: row.from_item_id,
    toItemId: row.to_item_id,
    relationType: row.relation_type,
    weight: Number(row.weight || 1),
    evidenceRef: row.evidence_ref,
    targetTitle: row.target_title,
    targetType: row.target_type,
  }));
}

function notionPageUrl(pageId) {
  if (!pageId) return null;
  return `https://www.notion.so/${String(pageId).replace(/-/g, '')}`;
}

function retrieveRanked(db, {
  query,
  projectId = null,
  types = [],
  tokenBudget = 1200,
  includeCandidate = true,
  scopePolicy = 'layered',
} = {}) {
  const start = Date.now();
  const searchText = (query || '').trim();
  const typeSet = parseTypes(types);
  const whereParts = [];
  const params = [];

  if (searchText) {
    whereParts.push('memory_fts MATCH ?');
    params.push(searchText);
  }

  if (typeSet.size > 0) {
    const placeholders = Array.from(typeSet).map(() => '?').join(',');
    whereParts.push(`m.type IN (${placeholders})`);
    for (const type of typeSet) params.push(type);
  }

  if (includeCandidate) {
    whereParts.push(`m.state IN ('verified', 'candidate')`);
  } else {
    whereParts.push(`m.state = 'verified'`);
  }

  const sql = `
    SELECT
      m.id,
      m.type,
      m.title,
      m.body,
      m.confidence,
      m.importance,
      m.freshness_ts,
      m.updated_at,
      m.state,
      m.scope_level,
      m.project_id,
      m.source_authority,
      m.notion_page_id,
      bm25(memory_fts) AS bm25,
      e.source_type,
      e.source_path,
      e.line_start,
      e.line_end,
      e.role
    FROM memory_fts
    JOIN memory_items m ON m.id = memory_fts.rowid
    LEFT JOIN evidence e ON e.memory_item_id = m.id
    ${whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''}
    ORDER BY ${searchText ? 'bm25(memory_fts), ' : ''} m.updated_at DESC
    LIMIT 300
  `;

  let rows = db.prepare(sql).all(...params);

  // Fallback: if strict full-text query returns nothing, do a scoped recency scan.
  if (searchText && rows.length === 0) {
    const fallbackWhere = [];
    const fallbackParams = [];

    if (typeSet.size > 0) {
      const placeholders = Array.from(typeSet).map(() => '?').join(',');
      fallbackWhere.push(`m.type IN (${placeholders})`);
      for (const type of typeSet) fallbackParams.push(type);
    }

    if (includeCandidate) {
      fallbackWhere.push(`m.state IN ('verified', 'candidate')`);
    } else {
      fallbackWhere.push(`m.state = 'verified'`);
    }

    const fallbackSql = `
      SELECT
        m.id,
        m.type,
        m.title,
        m.body,
        m.confidence,
        m.importance,
        m.freshness_ts,
        m.updated_at,
        m.state,
        m.scope_level,
        m.project_id,
        m.source_authority,
        m.notion_page_id,
        100 AS bm25,
        e.source_type,
        e.source_path,
        e.line_start,
        e.line_end,
        e.role
      FROM memory_items m
      LEFT JOIN evidence e ON e.memory_item_id = m.id
      ${fallbackWhere.length ? `WHERE ${fallbackWhere.join(' AND ')}` : ''}
      ORDER BY m.updated_at DESC
      LIMIT 300
    `;

    rows = db.prepare(fallbackSql).all(...fallbackParams);
  }

  const enriched = rows.map((row) => {
    const relevance = normalizeRelevance(row.bm25);
    const freshness = computeFreshnessScore(row.freshness_ts);
    const confidence = Math.max(0, Math.min(1, Number(row.confidence || 0)));
    const importance = Math.max(0, Math.min(1, Number(row.importance || 0.5)));
    const authority = Math.max(0, Math.min(1, Number(row.source_authority || 0.7)));
    const scope = scopePolicy === 'layered' ? scopeBoost(row, projectId) : 0.8;

    const score =
      relevance * 0.45
      + freshness * 0.2
      + confidence * 0.15
      + importance * 0.1
      + scope * 0.1;

    return {
      ...row,
      relevance,
      freshness,
      authority,
      scopeScore: scope,
      score,
    };
  });

  enriched.sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at));

  const selected = [];
  let budget = Number(tokenBudget) || 1200;

  for (const row of enriched) {
    const approxTokens = Math.ceil((row.title.length + row.body.length) / 4) + 35;
    if (selected.length && budget - approxTokens < 0) continue;

    selected.push({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      state: row.state,
      scopeLevel: row.scope_level,
      projectId: row.project_id,
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      sourceAuthority: Number(row.source_authority || 0.7),
      notionPageId: row.notion_page_id || null,
      notionPageUrl: notionPageUrl(row.notion_page_id),
      score: Number(row.score.toFixed(4)),
      scoreBreakdown: {
        relevance: Number(row.relevance.toFixed(4)),
        freshness: Number(row.freshness.toFixed(4)),
        scope: Number(row.scopeScore.toFixed(4)),
      },
      evidence: {
        sourceType: row.source_type,
        sourcePath: row.source_path,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        role: row.role,
        notionPageUrl: notionPageUrl(row.notion_page_id),
      },
    });

    budget -= approxTokens;
    if (budget <= 0) break;
  }

  const relations = fetchRelationEdges(db, selected.map((item) => item.id));

  const elapsed = Date.now() - start;
  writeRetrievalLog(db, {
    queryHash: sha256(searchText || '*'),
    queryText: searchText,
    projectId: projectId || null,
    candidateCount: enriched.length,
    usedItems: selected.length,
    latencyMs: elapsed,
    createdAt: new Date().toISOString(),
  });

  return {
    query: searchText,
    projectId,
    tokenBudget: Number(tokenBudget) || 1200,
    includeCandidate,
    scopePolicy,
    candidateCount: enriched.length,
    usedItems: selected.length,
    candidates: selected,
    relations,
  };
}

module.exports = {
  retrieveRanked,
};
