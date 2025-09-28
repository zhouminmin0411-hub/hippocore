'use strict';

const { compact, normalizeOneLine } = require('./types');

function tokenize(text) {
  return new Set(
    normalizeOneLine(text)
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token && token.length > 1),
  );
}

function similarity(a, b) {
  const aSet = tokenize(a);
  const bSet = tokenize(b);
  if (!aSet.size || !bSet.size) return 0;
  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(aSet.size, bSet.size);
}

function allowedTypeUpgrade(existingType, draftType) {
  return (
    (existingType === 'Insight' && draftType === 'Task')
    || (existingType === 'OpenQuestion' && (draftType === 'Insight' || draftType === 'Decision'))
    || (existingType === 'Event' && draftType === 'Decision')
  );
}

function loadExistingTopicRows(db, bundle) {
  return db.prepare(`
    SELECT id, type, title, topic_key, topic_status, missing_count
    FROM memory_items
    WHERE source_origin_key = ?
      AND source_bundle_type = ?
      AND COALESCE(topic_status, 'active') != 'archived'
    ORDER BY id ASC
  `).all(bundle.sourceOriginKey, bundle.bundleType);
}

function findWeakMatch(existingRows, draft) {
  let best = null;
  for (const row of existingRows) {
    if (row.topic_status === 'archived') continue;
    if (row.type !== draft.type && !allowedTypeUpgrade(row.type, draft.type)) continue;
    const score = similarity(row.title, draft.title);
    const overlap = tokenize(row.title);
    let common = 0;
    for (const token of tokenize(draft.title)) {
      if (overlap.has(token)) common += 1;
    }
    if (score >= 0.82 && common >= 2) {
      if (!best || score > best.score) best = { row, score };
    }
  }
  return best ? best.row : null;
}

function reconcileBundleCards(db, bundle, summary, drafts) {
  const existingRows = loadExistingTopicRows(db, bundle);
  const seenIds = new Set();
  const actions = [];

  for (const draft of drafts) {
    let match = existingRows.find((row) => row.topic_key === draft.topicKeyCandidate && row.topic_status !== 'archived') || null;
    if (!match && bundle.bundleType === 'document') {
      match = findWeakMatch(existingRows.filter((row) => !seenIds.has(row.id)), draft);
    }

    if (match) {
      seenIds.add(match.id);
      actions.push({
        kind: 'update',
        memoryItemId: match.id,
        revisionReason: 'updated_from_source',
        draft,
      });
    } else {
      actions.push({
        kind: 'create',
        revisionReason: 'created',
        draft,
      });
    }
  }

  if (bundle.bundleType === 'document') {
    for (const row of existingRows) {
      if (seenIds.has(row.id)) continue;
      const currentMissing = Number(row.missing_count || 0) + 1;
      actions.push({
        kind: currentMissing >= 2 ? 'archive' : 'mark_missing',
        memoryItemId: row.id,
        revisionReason: currentMissing >= 2 ? 'archived_missing' : 'missing_from_source',
        missingCount: currentMissing,
        summaryText: summary.summaryText,
        title: compact(row.title, 200),
      });
    }
  }

  return {
    bundle,
    summary,
    actions,
  };
}

module.exports = {
  reconcileBundleCards,
};
