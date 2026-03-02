'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function tableHasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function addColumnIfMissing(db, tableName, columnDef) {
  const columnName = columnDef.trim().split(/\s+/)[0];
  if (tableHasColumn(db, tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef};`);
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_records (
      id INTEGER PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(source_type, source_path)
    );

    CREATE TABLE IF NOT EXISTS raw_chunks (
      id INTEGER PRIMARY KEY,
      source_record_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      chunk_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(source_record_id) REFERENCES source_records(id) ON DELETE CASCADE,
      UNIQUE(source_record_id, chunk_index, content_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      confidence REAL NOT NULL,
      state TEXT NOT NULL DEFAULT 'candidate',
      status TEXT NOT NULL DEFAULT 'verified',
      scope_level TEXT NOT NULL DEFAULT 'project',
      project_id TEXT,
      source_authority REAL NOT NULL DEFAULT 0.7,
      importance REAL NOT NULL DEFAULT 0.5,
      freshness_ts INTEGER NOT NULL,
      source_record_id INTEGER,
      chunk_id INTEGER,
      dedup_key TEXT NOT NULL UNIQUE,
      canonical_key TEXT,
      notion_page_id TEXT,
      notion_last_synced_at TEXT,
      remote_version TEXT,
      context_summary TEXT,
      meaning_summary TEXT,
      actionability_summary TEXT,
      next_action TEXT,
      owner_hint TEXT,
      project_display_name TEXT,
      enrichment_source TEXT,
      enrichment_version TEXT,
      llm_enriched_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      review_reason TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(source_record_id) REFERENCES source_records(id) ON DELETE SET NULL,
      FOREIGN KEY(chunk_id) REFERENCES raw_chunks(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY,
      memory_item_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      snippet TEXT NOT NULL,
      role TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY,
      from_item_id INTEGER NOT NULL,
      to_item_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      evidence_ref TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(from_item_id) REFERENCES memory_items(id) ON DELETE CASCADE,
      FOREIGN KEY(to_item_id) REFERENCES memory_items(id) ON DELETE CASCADE,
      UNIQUE(from_item_id, to_item_id, relation_type)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_rule TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      processed_sources INTEGER NOT NULL DEFAULT 0,
      created_items INTEGER NOT NULL DEFAULT 0,
      updated_items INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_jobs (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      session_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      UNIQUE(event_type, session_key, message_id)
    );

    CREATE TABLE IF NOT EXISTS retrieval_logs (
      id INTEGER PRIMARY KEY,
      query_hash TEXT NOT NULL,
      query_text TEXT,
      project_id TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      used_items INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_packs (
      id INTEGER PRIMARY KEY,
      pack_key TEXT NOT NULL UNIQUE,
      project_id TEXT,
      content_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notion_outbox (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      item_id INTEGER,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES memory_items(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS notion_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items(type);
    CREATE INDEX IF NOT EXISTS idx_memory_items_state ON memory_items(state);
    CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope_level, project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_items_freshness ON memory_items(freshness_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_canonical ON memory_items(canonical_key);
    CREATE INDEX IF NOT EXISTS idx_evidence_item ON evidence(memory_item_id);
    CREATE INDEX IF NOT EXISTS idx_raw_chunks_source ON raw_chunks(source_record_id);
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_item_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_item_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created_at ON retrieval_logs(created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title,
      body,
      content='memory_items',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
      INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
      INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
  `);

  // Legacy migrations for databases created before v0.2.
  addColumnIfMissing(db, 'memory_items', "state TEXT NOT NULL DEFAULT 'candidate'");
  addColumnIfMissing(db, 'memory_items', "scope_level TEXT NOT NULL DEFAULT 'project'");
  addColumnIfMissing(db, 'memory_items', 'project_id TEXT');
  addColumnIfMissing(db, 'memory_items', 'source_authority REAL NOT NULL DEFAULT 0.7');
  addColumnIfMissing(db, 'memory_items', 'canonical_key TEXT');
  addColumnIfMissing(db, 'memory_items', 'use_count INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'memory_items', 'last_used_at TEXT');
  addColumnIfMissing(db, 'memory_items', 'review_reason TEXT');
  addColumnIfMissing(db, 'memory_items', 'pinned INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'memory_items', 'notion_page_id TEXT');
  addColumnIfMissing(db, 'memory_items', 'notion_last_synced_at TEXT');
  addColumnIfMissing(db, 'memory_items', 'remote_version TEXT');
  addColumnIfMissing(db, 'memory_items', 'context_summary TEXT');
  addColumnIfMissing(db, 'memory_items', 'meaning_summary TEXT');
  addColumnIfMissing(db, 'memory_items', 'actionability_summary TEXT');
  addColumnIfMissing(db, 'memory_items', 'next_action TEXT');
  addColumnIfMissing(db, 'memory_items', 'owner_hint TEXT');
  addColumnIfMissing(db, 'memory_items', 'project_display_name TEXT');
  addColumnIfMissing(db, 'memory_items', 'enrichment_source TEXT');
  addColumnIfMissing(db, 'memory_items', 'enrichment_version TEXT');
  addColumnIfMissing(db, 'memory_items', 'llm_enriched_at TEXT');
  addColumnIfMissing(db, 'evidence', 'role TEXT');
  addColumnIfMissing(db, 'relations', 'weight REAL NOT NULL DEFAULT 1.0');
  addColumnIfMissing(db, 'relations', 'evidence_ref TEXT');

  // Backfill canonical fields from existing columns.
  db.exec(`
    UPDATE memory_items
    SET
      canonical_key = COALESCE(canonical_key, dedup_key),
      state = CASE
        WHEN state IS NOT NULL AND state != '' THEN state
        WHEN status = 'archived' THEN 'archived'
        ELSE 'verified'
      END,
      scope_level = COALESCE(NULLIF(scope_level, ''), 'project')
  `);
}

function withDb(dbPath, fn) {
  const db = openDb(dbPath);
  try {
    initSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

module.exports = {
  openDb,
  initSchema,
  withDb,
};
