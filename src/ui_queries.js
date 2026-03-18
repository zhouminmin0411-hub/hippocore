'use strict';

const { sourceCategoryLabel, buildSourceDecisionPath, parseNotionSourcePath } = require('./card');

function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function todayLocalDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function parseLocalDateInput(rawValue, { fallbackToday = false } = {}) {
  const input = String(rawValue || '').trim();
  if (!input) {
    if (fallbackToday) return todayLocalDateString();
    throw createHttpError(400, 'date must be in YYYY-MM-DD format');
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) throw createHttpError(400, 'date must be in YYYY-MM-DD format');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    throw createHttpError(400, 'date must be a valid calendar day');
  }

  return input;
}

function toLocalDateString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getLocalDayBounds(dateString) {
  const normalized = parseLocalDateInput(dateString);
  const [year, month, day] = normalized.split('-').map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return {
    date: normalized,
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function localTimestampForDate(dateString) {
  return getLocalDayBounds(dateString).start.getTime();
}

function shiftLocalDate(dateString, offsetDays) {
  const bounds = getLocalDayBounds(dateString);
  const shifted = new Date(bounds.start);
  shifted.setDate(shifted.getDate() + Number(offsetDays || 0));
  return toLocalDateString(shifted);
}

function formatLocalTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function normalizeStateFilter(state) {
  const value = String(state || 'all').trim().toLowerCase();
  if (!value || value === 'all') return 'all';
  if (!['candidate', 'verified', 'archived'].includes(value)) {
    throw createHttpError(400, 'state must be one of all,candidate,verified,archived');
  }
  return value;
}

function normalizeTypes(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .flatMap((value) => String(value || '').split(','))
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return String(input)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function notionPageUrl(pageId, blockId = null) {
  if (!pageId) return null;
  const pagePart = String(pageId).replace(/-/g, '');
  if (!blockId) return `https://www.notion.so/${pagePart}`;
  return `https://www.notion.so/${pagePart}#${String(blockId).replace(/-/g, '')}`;
}

function inferSourceInfo({
  sourceType = null,
  sourcePath = '',
  lineStart = null,
  lineEnd = null,
  sourceSummary = '',
  title = '',
  notionPageId = null,
} = {}) {
  const parsed = parseNotionSourcePath(sourcePath);
  const resolvedPageId = notionPageId || parsed.pageId || null;
  const notionPageUrlValue = notionPageUrl(resolvedPageId, null);
  const notionBlockUrl = notionPageUrl(resolvedPageId, parsed.blockId || null);
  const sourceUrl = notionBlockUrl || notionPageUrlValue || null;

  return {
    sourceType: sourceType || null,
    sourcePath: sourcePath || '',
    sourceLabel: sourceCategoryLabel(sourcePath, `${sourceSummary} ${title}`.trim()),
    sourceDecisionPath: buildSourceDecisionPath({ sourcePath, lineStart, lineEnd }),
    sourceUrl,
    notionPageUrl: notionPageUrlValue,
    notionBlockUrl,
  };
}

function buildTimelineItem(row) {
  const timestamp = row.updated_at || row.created_at || null;
  const source = inferSourceInfo({
    sourceType: row.source_type,
    sourcePath: row.source_path || '',
    lineStart: row.line_start,
    lineEnd: row.line_end,
    sourceSummary: row.source_summary || '',
    title: row.title || '',
    notionPageId: row.notion_page_id || null,
  });

  return {
    id: Number(row.id),
    time: formatLocalTime(timestamp),
    timestamp,
    type: row.type,
    title: row.title,
    body: row.body,
    displayBody: row.display_body || '',
    state: row.state,
    status: row.status,
    projectId: row.project_id || null,
    projectDisplayName: row.project_display_name || '',
    sourceSummary: row.source_summary || '',
    contextSummary: row.context_summary || '',
    meaningSummary: row.meaning_summary || '',
    actionabilitySummary: row.actionability_summary || '',
    nextAction: row.next_action || '',
    ownerHint: row.owner_hint || '',
    source,
  };
}

function getLatestSyncAt(db) {
  const row = db.prepare(`
    SELECT COALESCE(ended_at, started_at) AS ts
    FROM sync_runs
    ORDER BY id DESC
    LIMIT 1
  `).get();
  return row && row.ts ? row.ts : null;
}

function getUiHealth(db) {
  const counts = db.prepare(`
    SELECT COUNT(*) AS memory_item_count, MAX(updated_at) AS latest_memory_at
    FROM memory_items
  `).get();

  return {
    ok: true,
    dbReady: true,
    memoryItemCount: Number((counts && counts.memory_item_count) || 0),
    latestMemoryAt: counts && counts.latest_memory_at ? counts.latest_memory_at : null,
    latestSyncAt: getLatestSyncAt(db),
  };
}

function getUiOverview(db, { date = null, days = 7, projectId = null } = {}) {
  const normalizedDate = parseLocalDateInput(date, { fallbackToday: true });
  const normalizedDays = Math.max(1, Math.min(30, Number(days || 7) || 7));
  const selectedBounds = getLocalDayBounds(normalizedDate);
  const oldestDate = shiftLocalDate(normalizedDate, -(normalizedDays - 1));
  const oldestBounds = getLocalDayBounds(oldestDate);

  const params = [oldestBounds.startIso, selectedBounds.endIso];
  let where = 'updated_at >= ? AND updated_at < ?';
  if (projectId) {
    where += ' AND project_id = ?';
    params.push(projectId);
  }

  const rows = db.prepare(`
    SELECT id, type, state, updated_at
    FROM memory_items
    WHERE ${where}
    ORDER BY updated_at ASC, id ASC
  `).all(...params);

  const dayCounts = new Map();
  const byType = {};
  let dayTotal = 0;
  let candidateCount = 0;
  let verifiedCount = 0;
  let archivedCount = 0;
  let latestMemoryAt = null;

  for (const row of rows) {
    const updatedAt = row.updated_at || null;
    if (!updatedAt) continue;

    const localKey = toLocalDateString(new Date(updatedAt));
    dayCounts.set(localKey, Number(dayCounts.get(localKey) || 0) + 1);

    if (localKey === normalizedDate) {
      dayTotal += 1;
      byType[row.type] = Number(byType[row.type] || 0) + 1;
      if (row.state === 'candidate') candidateCount += 1;
      else if (row.state === 'archived') archivedCount += 1;
      else verifiedCount += 1;
      if (!latestMemoryAt || updatedAt > latestMemoryAt) latestMemoryAt = updatedAt;
    }
  }

  const trend = [];
  for (let i = normalizedDays - 1; i >= 0; i -= 1) {
    const dayKey = shiftLocalDate(normalizedDate, -i);
    trend.push({
      date: dayKey,
      count: Number(dayCounts.get(dayKey) || 0),
    });
  }

  return {
    date: normalizedDate,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    summary: {
      dayTotal,
      candidateCount,
      verifiedCount,
      archivedCount,
      byType,
      latestMemoryAt,
      latestSyncAt: getLatestSyncAt(db),
    },
    trend,
  };
}

function getUiTimeline(db, {
  date = null,
  projectId = null,
  state = 'all',
  types = [],
} = {}) {
  const normalizedDate = parseLocalDateInput(date, { fallbackToday: true });
  const normalizedState = normalizeStateFilter(state);
  const normalizedTypes = normalizeTypes(types);
  const bounds = getLocalDayBounds(normalizedDate);

  const params = [bounds.startIso, bounds.endIso];
  const whereParts = ['m.updated_at >= ?', 'm.updated_at < ?'];

  if (projectId) {
    whereParts.push('m.project_id = ?');
    params.push(projectId);
  }

  if (normalizedState !== 'all') {
    whereParts.push('m.state = ?');
    params.push(normalizedState);
  }

  if (normalizedTypes.length) {
    whereParts.push(`m.type IN (${normalizedTypes.map(() => '?').join(',')})`);
    params.push(...normalizedTypes);
  }

  const rows = db.prepare(`
    SELECT
      m.id,
      m.type,
      m.title,
      m.body,
      m.display_body,
      m.state,
      m.status,
      m.project_id,
      m.project_display_name,
      m.source_summary,
      m.context_summary,
      m.meaning_summary,
      m.actionability_summary,
      m.next_action,
      m.owner_hint,
      m.notion_page_id,
      m.created_at,
      m.updated_at,
      (
        SELECT e.source_type
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS source_type,
      (
        SELECT e.source_path
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS source_path,
      (
        SELECT e.line_start
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS line_start,
      (
        SELECT e.line_end
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS line_end
    FROM memory_items m
    WHERE ${whereParts.join(' AND ')}
    ORDER BY m.updated_at ASC, m.id ASC
  `).all(...params);

  return {
    date: normalizedDate,
    filters: {
      projectId: projectId || null,
      state: normalizedState,
      types: normalizedTypes,
    },
    items: rows.map(buildTimelineItem),
  };
}

function getUiMemoryDetail(db, { id } = {}) {
  const itemId = Number(id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw createHttpError(400, 'memory id must be a positive integer');
  }

  const row = db.prepare(`
    SELECT
      m.*,
      (
        SELECT e.source_type
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS source_type,
      (
        SELECT e.source_path
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS source_path,
      (
        SELECT e.line_start
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS line_start,
      (
        SELECT e.line_end
        FROM evidence e
        WHERE e.memory_item_id = m.id
        ORDER BY e.id ASC
        LIMIT 1
      ) AS line_end
    FROM memory_items m
    WHERE m.id = ?
  `).get(itemId);

  if (!row) throw createHttpError(404, `memory item ${itemId} not found`);

  const evidenceRows = db.prepare(`
    SELECT id, source_type, source_path, line_start, line_end, snippet, role, created_at
    FROM evidence
    WHERE memory_item_id = ?
    ORDER BY id ASC
    LIMIT 20
  `).all(itemId);

  const outgoingRows = db.prepare(`
    SELECT r.relation_type, r.weight, r.evidence_ref, m.id AS target_id, m.title AS target_title, m.type AS target_type
    FROM relations r
    JOIN memory_items m ON m.id = r.to_item_id
    WHERE r.from_item_id = ?
    ORDER BY r.weight DESC, r.id DESC
    LIMIT 10
  `).all(itemId);

  const incomingRows = db.prepare(`
    SELECT r.relation_type, r.weight, r.evidence_ref, m.id AS target_id, m.title AS target_title, m.type AS target_type
    FROM relations r
    JOIN memory_items m ON m.id = r.from_item_id
    WHERE r.to_item_id = ?
    ORDER BY r.weight DESC, r.id DESC
    LIMIT 10
  `).all(itemId);

  const primarySource = inferSourceInfo({
    sourceType: row.source_type,
    sourcePath: row.source_path || '',
    lineStart: row.line_start,
    lineEnd: row.line_end,
    sourceSummary: row.source_summary || '',
    title: row.title || '',
    notionPageId: row.notion_page_id || null,
  });

  return {
    item: {
      id: Number(row.id),
      type: row.type,
      title: row.title,
      body: row.body,
      displayBody: row.display_body || '',
      state: row.state,
      status: row.status,
      confidence: Number(row.confidence || 0),
      importance: Number(row.importance || 0),
      freshnessTs: Number(row.freshness_ts || 0),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      projectId: row.project_id || null,
      projectDisplayName: row.project_display_name || '',
      sourceSummary: row.source_summary || '',
      contextSummary: row.context_summary || '',
      meaningSummary: row.meaning_summary || '',
      actionabilitySummary: row.actionability_summary || '',
      nextAction: row.next_action || '',
      ownerHint: row.owner_hint || '',
      source: primarySource,
      evidence: evidenceRows.map((entry) => {
        const source = inferSourceInfo({
          sourceType: entry.source_type,
          sourcePath: entry.source_path || '',
          lineStart: entry.line_start,
          lineEnd: entry.line_end,
          sourceSummary: row.source_summary || '',
          title: row.title || '',
          notionPageId: row.notion_page_id || null,
        });
        return {
          id: Number(entry.id),
          sourceType: entry.source_type,
          sourcePath: entry.source_path,
          sourceLabel: source.sourceLabel,
          sourceDecisionPath: source.sourceDecisionPath,
          sourceUrl: source.sourceUrl,
          notionPageUrl: source.notionPageUrl,
          notionBlockUrl: source.notionBlockUrl,
          lineStart: entry.line_start == null ? null : Number(entry.line_start),
          lineEnd: entry.line_end == null ? null : Number(entry.line_end),
          snippet: entry.snippet,
          role: entry.role || null,
          createdAt: entry.created_at || null,
        };
      }),
      relations: {
        outgoing: outgoingRows.map((entry) => ({
          relationType: entry.relation_type,
          weight: Number(entry.weight || 1),
          evidenceRef: entry.evidence_ref || '',
          targetId: Number(entry.target_id),
          targetTitle: entry.target_title,
          targetType: entry.target_type,
        })),
        incoming: incomingRows.map((entry) => ({
          relationType: entry.relation_type,
          weight: Number(entry.weight || 1),
          evidenceRef: entry.evidence_ref || '',
          targetId: Number(entry.target_id),
          targetTitle: entry.target_title,
          targetType: entry.target_type,
        })),
      },
    },
  };
}

module.exports = {
  createHttpError,
  parseLocalDateInput,
  todayLocalDateString,
  getUiHealth,
  getUiOverview,
  getUiTimeline,
  getUiMemoryDetail,
  localTimestampForDate,
};
