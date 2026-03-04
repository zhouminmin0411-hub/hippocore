'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  resolveProjectRoot,
  loadConfig,
  saveConfig,
  initConfig,
  resolveConfiguredPath,
  ensureDir,
  getPreferredConfigPath,
  getLegacyConfigPath,
} = require('./config');
const { withDb } = require('./db');
const { collectSourceFiles, chunkText, makePromptSource } = require('./ingest');
const { distillChunk } = require('./distill');
const { retrieveRanked } = require('./retrieve');
const { composeContext } = require('./compose');
const { renderProjection } = require('./projection');
const { sha256 } = require('./hash');
const { enrichMemoryItemSync, blankStats: blankEnrichmentStats, normalizeSettings: normalizeEnrichmentSettings } = require('./enrichment');
const { NotionClient } = require('./notion/client');
const {
  validateNotionConfig,
  validateNotionDataSourceSchema,
  formatSchemaIssueMessage,
} = require('./notion/schema');
const { fetchNotionDocSourcesSync } = require('./notion/sync');
const { migrateAllToNotionSync, upsertMemoryRowSync } = require('./notion/migrate');

function nowIso() {
  return new Date().toISOString();
}

function createEnrichmentStats() {
  return blankEnrichmentStats();
}

function mergeEnrichmentStats(target, delta) {
  const out = target || createEnrichmentStats();
  const src = delta || {};
  out.llmSuccess += Number(src.llmSuccess || 0);
  out.llmFallback += Number(src.llmFallback || 0);
  out.ruleOnly += Number(src.ruleOnly || 0);

  const errors = Array.isArray(src.llmErrors) ? src.llmErrors : [];
  if (!Array.isArray(out.llmErrors)) out.llmErrors = [];
  for (const error of errors) {
    if (out.llmErrors.length >= 20) break;
    out.llmErrors.push(String(error));
  }
  return out;
}

function createNotionWriteThroughStats() {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    outboxEnqueued: 0,
    outboxFlushed: 0,
    outboxFlushFailed: 0,
    outboxPending: 0,
    errors: [],
  };
}

function mergeNotionWriteThroughStats(target, delta) {
  const out = target || createNotionWriteThroughStats();
  const src = delta || {};
  out.attempted += Number(src.attempted || 0);
  out.succeeded += Number(src.succeeded || 0);
  out.failed += Number(src.failed || 0);
  out.outboxEnqueued += Number(src.outboxEnqueued || 0);
  out.outboxFlushed += Number(src.outboxFlushed || 0);
  out.outboxFlushFailed += Number(src.outboxFlushFailed || 0);
  out.outboxPending = Number(src.outboxPending || out.outboxPending || 0);

  const errors = Array.isArray(src.errors) ? src.errors : [];
  if (!Array.isArray(out.errors)) out.errors = [];
  for (const error of errors) {
    if (out.errors.length >= 200) break;
    out.errors.push(error);
  }
  return out;
}

function statePriority(state) {
  if (state === 'archived') return 3;
  if (state === 'verified') return 2;
  return 1;
}

function mergeState(existingState, incomingState) {
  return statePriority(existingState) >= statePriority(incomingState)
    ? existingState
    : incomingState;
}

function stateToStatus(state) {
  return state === 'archived' ? 'archived' : 'verified';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeJsonWithBackup(filePath, payload) {
  const next = JSON.stringify(payload, null, 2) + '\n';
  let backupPath = null;

  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === next) {
      return { changed: false, backupPath: null };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${filePath}.bak-${stamp}`;
    fs.copyFileSync(filePath, backupPath);
  }

  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, next, 'utf8');
  return { changed: true, backupPath };
}

function resolveBundledScriptPath(scriptName) {
  const candidate = path.join(__dirname, '..', 'scripts', scriptName);
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function resolveBundledHookScripts() {
  const required = ['session_start.js', 'user_prompt_submit.js', 'session_end.js'];
  const scripts = {};

  for (const name of required) {
    const absPath = resolveBundledScriptPath(name);
    if (!absPath) {
      throw new Error(`Missing bundled hook script: ${name}. Please reinstall hippocore package.`);
    }
    scripts[name] = absPath;
  }

  return scripts;
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function findLatestBackupForFile(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  if (!fs.existsSync(dir)) return null;

  const candidates = fs.readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.bak-`))
    .sort()
    .reverse();

  if (!candidates.length) return null;
  return path.join(dir, candidates[0]);
}

function detectInstallMode({ mode = 'auto' } = {}) {
  const normalized = String(mode || 'auto').toLowerCase();
  if (normalized === 'local' || normalized === 'cloud') return normalized;
  return process.platform === 'darwin' ? 'local' : 'cloud';
}

function buildMirrorRecommendation({ installMode, projectRoot }) {
  const remotePath = path.join(projectRoot, 'hippocore');
  const remoteHost = process.env.HIPPOCORE_REMOTE_HOST
    || process.env.OPENCLAW_REMOTE_HOST
    || process.env.HOSTNAME
    || '<server-host>';
  const remoteUser = process.env.HIPPOCORE_REMOTE_USER
    || process.env.USER
    || 'root';
  const localTarget = `~/hippocore-${path.basename(projectRoot) || 'workspace'}`;
  const remote = `${remoteUser}@${remoteHost}:${remotePath}`;
  const local = localTarget;

  if (installMode !== 'cloud') {
    return {
      shouldRecommend: false,
      reason: 'openclaw_local_environment',
      suggestedTiming: 'optional',
      suggestedCommand: null,
      remote,
      local,
      remotePath,
      localTarget,
    };
  }

  return {
    shouldRecommend: true,
    reason: 'openclaw_cloud_environment',
    suggestedTiming: 'after_setup_success',
    suggestedCommand: `node bin/hippocore.js mirror pull --remote ${remote} --local ${local}`,
    remote,
    local,
    remotePath,
    localTarget,
  };
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolveStorageMode(config) {
  const mode = String((config && config.storage && config.storage.mode) || 'local').toLowerCase();
  return mode === 'notion' ? 'notion' : 'local';
}

function isNotionMode(config) {
  return resolveStorageMode(config) === 'notion';
}

function resolveSetupStorageMode({
  explicitStorage = null,
  config,
  installMode = 'auto',
  hadConfigBeforeSetup = false,
} = {}) {
  if (explicitStorage != null) {
    return String(explicitStorage).toLowerCase() === 'notion' ? 'notion' : 'local';
  }

  if (hadConfigBeforeSetup) {
    return resolveStorageMode(config);
  }

  return installMode === 'cloud' ? 'notion' : resolveStorageMode(config);
}

function buildNotionClient(config, { requireDocSources = false } = {}) {
  const validation = validateNotionConfig(config, process.env, { requireDocSources });
  if (!validation.ok) {
    throw new Error(`Invalid notion config: ${validation.errors.join('; ')}`);
  }
  const token = process.env[validation.settings.tokenEnv];
  const client = new NotionClient({
    token,
    apiVersion: validation.settings.apiVersion,
    baseUrl: validation.settings.baseUrl,
  });
  const schema = buildNotionSchemaChecks(client, validation.settings);
  const memoryIssue = formatSchemaIssueMessage(schema.memory, 'memoryDataSourceId');
  if (memoryIssue) {
    throw new Error(memoryIssue);
  }
  if (requireDocSources) {
    for (const item of schema.docs) {
      const issue = formatSchemaIssueMessage(item.result, `docDataSourceId:${item.dataSourceId}`);
      if (issue) throw new Error(issue);
    }
  }
  return {
    client,
    settings: validation.settings,
    validation,
    schema,
    schemaMaps: {
      memory: (schema.memory && schema.memory.mapping) ? schema.memory.mapping : null,
      relation: (schema.relations && schema.relations.ok && schema.relations.mapping)
        ? schema.relations.mapping
        : null,
    },
  };
}

function buildNotionSchemaChecks(client, settings) {
  const memoryDataSource = client.getDataSourceSync(settings.memoryDataSourceId);
  const memorySchema = validateNotionDataSourceSchema(memoryDataSource, { kind: 'memory' });
  const docSchemas = [];
  for (const dataSourceId of settings.docDataSourceIds || []) {
    const docDataSource = client.getDataSourceSync(dataSourceId);
    docSchemas.push({
      dataSourceId,
      result: validateNotionDataSourceSchema(docDataSource, { kind: 'doc' }),
    });
  }
  const relationSchema = settings.relationsDataSourceId
    ? validateNotionDataSourceSchema(
      client.getDataSourceSync(settings.relationsDataSourceId),
      { kind: 'relation' },
    )
    : null;

  const errors = [];
  const warnings = [];
  const memoryIssue = formatSchemaIssueMessage(memorySchema, 'memoryDataSourceId');
  if (memoryIssue) errors.push(memoryIssue);
  for (const item of docSchemas) {
    const issue = formatSchemaIssueMessage(item.result, `docDataSourceId:${item.dataSourceId}`);
    if (issue) errors.push(issue);
  }
  if (relationSchema) {
    const relationIssue = formatSchemaIssueMessage(relationSchema, 'relationsDataSourceId');
    if (relationIssue) warnings.push(relationIssue);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    memory: memorySchema,
    docs: docSchemas,
    relations: relationSchema,
  };
}

function getNotionConnectivity(config, { requireDocSources = false } = {}) {
  const validation = validateNotionConfig(config, process.env, { requireDocSources });
  if (!validation.ok) {
    return {
      ok: false,
      checked: false,
      errors: validation.errors,
      warnings: validation.warnings,
      settings: validation.settings,
      docSourcesConfigured: validation.docSourcesReady,
      docSourcesValidated: false,
      schema: null,
    };
  }

  try {
    const token = process.env[validation.settings.tokenEnv];
    const client = new NotionClient({
      token,
      apiVersion: validation.settings.apiVersion,
      baseUrl: validation.settings.baseUrl,
    });
    const me = client.usersMeSync();
    const schema = buildNotionSchemaChecks(client, validation.settings);

    return {
      ok: schema.ok,
      checked: true,
      user: (me && me.name) ? me.name : null,
      settings: validation.settings,
      warnings: [...validation.warnings, ...schema.warnings],
      errors: schema.ok ? [] : schema.errors,
      docSourcesConfigured: validation.docSourcesReady,
      docSourcesValidated: validation.docSourcesReady && schema.ok,
      schema,
    };
  } catch (err) {
    return {
      ok: false,
      checked: true,
      errors: [err.message],
      warnings: validation.warnings,
      settings: validation.settings,
      docSourcesConfigured: validation.docSourcesReady,
      docSourcesValidated: false,
      schema: null,
    };
  }
}

function getNotionOnboardingStatus(config, { requireDocSources = true } = {}) {
  if (!isNotionMode(config)) return null;
  const connectivity = getNotionConnectivity(config, { requireDocSources });
  const settings = connectivity.settings || {};
  const docSourcesConfigured = Boolean(settings.docSourcesReady || ((settings.docDataSourceIds || []).length > 0));
  const docSourcesValidated = Boolean(connectivity.ok && docSourcesConfigured);
  const nextActions = [];
  if (!docSourcesConfigured) nextActions.push('configure_notion_doc_sources');
  if (connectivity.schema && connectivity.schema.ok === false) nextActions.push('fix_notion_schema_compatibility');
  if (!connectivity.ok) nextActions.push('configure_notion_and_retry');
  if (connectivity.ok && docSourcesConfigured) nextActions.push('notion_storage_ready');
  return {
    required: true,
    ready: Boolean(connectivity.ok && (!requireDocSources || docSourcesConfigured)),
    blocking: !connectivity.ok || (requireDocSources && !docSourcesConfigured),
    checked: Boolean(connectivity.checked),
    settings,
    docSourcesConfigured,
    docSourcesValidated,
    warnings: connectivity.warnings || [],
    errors: connectivity.ok
      ? []
      : (connectivity.errors || []),
    nextActions: nextActions.length ? nextActions : ['configure_notion_and_retry'],
    commands: {
      setup: 'node bin/hippocore.js setup --storage notion --notion-memory-datasource-id <memory_ds_id> --notion-doc-datasource-ids <docs_ds_id_1,docs_ds_id_2> [--notion-relations-datasource-id <relations_ds_id>]',
      status: 'node bin/hippocore.js notion status',
      sync: 'node bin/hippocore.js notion sync',
    },
  };
}

function setNotionSyncState(db, key, value) {
  db.prepare(`
    INSERT INTO notion_sync_state(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key)
    DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value == null ? null : String(value), nowIso());
}

function getLastEvidenceForItem(db, memoryItemId) {
  return db.prepare(`
    SELECT source_path, line_start, line_end
    FROM evidence
    WHERE memory_item_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(memoryItemId);
}

function loadMemoryRowForNotion(db, memoryItemId) {
  const row = db.prepare(`
    SELECT
      id,
      type,
      title,
      body,
      state,
      scope_level,
      project_id,
      confidence,
      importance,
      source_authority,
      freshness_ts,
      context_summary,
      meaning_summary,
      actionability_summary,
      next_action,
      owner_hint,
      project_display_name,
      enrichment_source,
      enrichment_version,
      llm_enriched_at
    FROM memory_items
    WHERE id = ?
  `).get(memoryItemId);
  if (!row) return null;
  const ev = getLastEvidenceForItem(db, memoryItemId) || {};
  return {
    ...row,
    source_path: ev.source_path || '',
    line_start: ev.line_start == null ? null : ev.line_start,
    line_end: ev.line_end == null ? null : ev.line_end,
  };
}

function enqueueNotionOutbox(db, { eventType, itemId = null, payload, error = null }) {
  db.prepare(`
    INSERT INTO notion_outbox(event_type, item_id, payload_json, status, attempt_count, last_error, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)
  `).run(
    eventType,
    itemId,
    JSON.stringify(payload || {}),
    error || null,
    nowIso(),
    nowIso(),
  );
}

function buildNotionWriteRuntime(config) {
  const runtime = buildNotionClient(config);
  return {
    client: runtime.client,
    settings: runtime.settings,
    schemaMaps: runtime.schemaMaps,
  };
}

function syncMemoryItemToNotionStrict(db, config, memoryItemId, targetState, runtime = null) {
  const resolvedRuntime = runtime || buildNotionWriteRuntime(config);
  const { client, settings, schemaMaps } = resolvedRuntime;
  const row = loadMemoryRowForNotion(db, memoryItemId);
  if (!row) {
    throw new Error(`Cannot sync memory item ${memoryItemId}: row not found`);
  }

  const out = upsertMemoryRowSync(client, settings.memoryDataSourceId, row, {
    propertyMap: schemaMaps && schemaMaps.memory ? schemaMaps.memory : null,
    idProperty: schemaMaps && schemaMaps.memory ? schemaMaps.memory.HippocoreId : null,
  });
  db.prepare(`
    UPDATE memory_items
    SET
      notion_page_id = ?,
      notion_last_synced_at = ?,
      remote_version = ?,
      state = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    out.pageId,
    nowIso(),
    'v1',
    targetState,
    stateToStatus(targetState),
    nowIso(),
    memoryItemId,
  );

  return out;
}

function attemptNotionWriteThrough(
  db,
  {
    config,
    runtime = null,
    runtimeError = null,
    memoryItemId,
    targetState,
    eventType = 'sync_write_through',
    payloadBase = {},
  } = {},
) {
  db.prepare(`
    UPDATE memory_items
    SET state = 'pending_remote', status = 'verified', updated_at = ?
    WHERE id = ?
  `).run(nowIso(), memoryItemId);

  if (runtimeError) {
    const errorMessage = String(runtimeError);
    enqueueNotionOutbox(db, {
      eventType,
      itemId: memoryItemId,
      payload: {
        ...payloadBase,
        targetState,
      },
      error: errorMessage,
    });
    return {
      ok: false,
      enqueued: true,
      error: errorMessage,
    };
  }

  try {
    const out = syncMemoryItemToNotionStrict(db, config, memoryItemId, targetState, runtime);
    return {
      ok: true,
      enqueued: false,
      pageId: out.pageId || null,
      created: Boolean(out.created),
    };
  } catch (err) {
    const errorMessage = String(err && err.message ? err.message : err);
    enqueueNotionOutbox(db, {
      eventType,
      itemId: memoryItemId,
      payload: {
        ...payloadBase,
        targetState,
      },
      error: errorMessage,
    });
    return {
      ok: false,
      enqueued: true,
      error: errorMessage,
    };
  }
}

function flushNotionOutbox(db, { config, runtime = null, runtimeError = null, limit = 100 } = {}) {
  const out = {
    outboxFlushed: 0,
    outboxFlushFailed: 0,
    errors: [],
  };
  const rows = db.prepare(`
    SELECT id, event_type, item_id, payload_json, attempt_count, status
    FROM notion_outbox
    WHERE status IN ('pending', 'failed')
    ORDER BY id ASC
    LIMIT ?
  `).all(Math.max(1, Number(limit || 100)));

  for (const row of rows) {
    let payload = {};
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : {};
    } catch {
      payload = {};
    }

    const sourcePath = payload.sourcePath || null;
    const targetState = payload.targetState || 'candidate';
    const itemId = row.item_id == null ? null : Number(row.item_id);
    if (!itemId) {
      const message = `Invalid outbox row ${row.id}: missing item_id`;
      db.prepare(`
        UPDATE notion_outbox
        SET status = 'failed', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(message, nowIso(), row.id);
      out.outboxFlushFailed += 1;
      out.errors.push({
        itemId: null,
        sourcePath,
        phase: 'outbox_flush',
        error: message,
      });
      continue;
    }

    if (runtimeError) {
      const message = String(runtimeError);
      db.prepare(`
        UPDATE notion_outbox
        SET status = 'failed', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(message, nowIso(), row.id);
      out.outboxFlushFailed += 1;
      out.errors.push({
        itemId,
        sourcePath,
        phase: 'outbox_flush',
        error: message,
      });
      continue;
    }

    try {
      syncMemoryItemToNotionStrict(db, config, itemId, targetState, runtime);
      db.prepare(`
        UPDATE notion_outbox
        SET status = 'done', last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), row.id);
      out.outboxFlushed += 1;
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      db.prepare(`
        UPDATE notion_outbox
        SET status = 'failed', attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(message, nowIso(), row.id);
      out.outboxFlushFailed += 1;
      out.errors.push({
        itemId,
        sourcePath,
        phase: 'outbox_flush',
        error: message,
      });
    }
  }

  const pending = db.prepare(`
    SELECT COUNT(*) AS c
    FROM notion_outbox
    WHERE status IN ('pending', 'failed')
  `).get();

  return {
    ...out,
    outboxPending: Number((pending && pending.c) || 0),
  };
}

function getMirrorOnboardingStatus({
  config,
  installMode = null,
  recommendation = null,
} = {}) {
  const mirror = (config && typeof config.mirror === 'object') ? config.mirror : {};
  const remote = normalizeOptionalString(mirror.remote)
    || normalizeOptionalString(recommendation && recommendation.remote);
  const local = normalizeOptionalString(mirror.local)
    || normalizeOptionalString(recommendation && recommendation.local);
  const inferredCloudMode = installMode === 'cloud'
    || (installMode === null && process.platform !== 'darwin' && Boolean(remote || local));
  const required = (typeof mirror.required === 'boolean')
    ? mirror.required
    : inferredCloudMode;
  const completedAt = normalizeOptionalString(mirror.completedAt);
  const ready = !required || Boolean(completedAt);
  const pullCommand = (remote && local)
    ? `node bin/hippocore.js mirror pull --remote ${remote} --local ${local}`
    : 'node bin/hippocore.js mirror pull --remote <user@host:/abs/path/to/hippocore> --local <local-dir>';
  const completeCommand = (remote && local)
    ? `node bin/hippocore.js mirror complete --remote ${remote} --local ${local}`
    : 'node bin/hippocore.js mirror complete --remote <user@host:/abs/path/to/hippocore> --local <local-dir>';

  return {
    required,
    ready,
    blocking: required && !ready,
    remote: remote || null,
    local: local || null,
    completedAt: completedAt || null,
    pullCommand,
    completeCommand,
  };
}

function buildMirrorBlockingContext(status) {
  return [
    '# HIPPOCORE MIRROR SETUP REQUIRED',
    '',
    'Installation is not complete until the local mirror is prepared.',
    '',
    '1) On your local machine, run:',
    `   ${status.pullCommand}`,
    '',
    '2) Back on this server, mark mirror onboarding complete:',
    `   ${status.completeCommand}`,
    '',
    'Until this is done, Hippocore setup remains blocked.',
    '',
  ].join('\n');
}

function buildNotionBlockingContext(status) {
  const tokenEnv = (status && status.settings && status.settings.tokenEnv)
    ? status.settings.tokenEnv
    : 'NOTION_API_KEY';
  const setupCommand = (status && status.commands && status.commands.setup)
    ? status.commands.setup
    : 'node bin/hippocore.js setup --storage notion --notion-memory-datasource-id <memory_ds_id>';
  const statusCommand = (status && status.commands && status.commands.status)
    ? status.commands.status
    : 'node bin/hippocore.js notion status';
  const syncCommand = (status && status.commands && status.commands.sync)
    ? status.commands.sync
    : 'node bin/hippocore.js notion sync';
  const errors = Array.isArray(status && status.errors) ? status.errors.filter(Boolean) : [];

  const lines = [
    '# HIPPOCORE NOTION SETUP REQUIRED',
    '',
    'Hippocore Notion mode is not ready. Session memory injection is blocked until setup is complete.',
    '',
    '1) Configure Notion API token in this runtime environment:',
    `   export ${tokenEnv}=<your_notion_token>`,
    '',
    '2) Complete Notion storage setup (memory + doc import data sources are both required):',
    `   ${setupCommand}`,
    '',
    '3) Verify connectivity and schema:',
    `   ${statusCommand}`,
    '',
    '4) Initialize local retrieval cache:',
    `   ${syncCommand}`,
  ];

  if (status && status.docSourcesConfigured === false) {
    lines.push(
      '',
      'Required fix:',
      '- Set --notion-doc-datasource-ids to one or more Notion Data Source IDs for historical/ongoing doc import.',
    );
  }

  if (errors.length) {
    lines.push('', 'Current errors:');
    for (const err of errors) lines.push(`- ${err}`);
  }

  return `${lines.join('\n')}\n`;
}

function stripHippocoreHooks(hooksPayload, { projectRoot }) {
  const original = hooksPayload && typeof hooksPayload === 'object' ? hooksPayload : {};
  const result = { ...original };
  const hooks = { ...(original.hooks || {}) };

  const targets = [
    path.join(projectRoot, 'scripts', 'session_start.js'),
    path.join(projectRoot, 'scripts', 'user_prompt_submit.js'),
    path.join(projectRoot, 'scripts', 'session_end.js'),
    'HIPPOCORE_PROJECT_ROOT=',
  ];

  const cleanEvent = (eventName) => {
    const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    const cleanedGroups = groups
      .map((group) => {
        const groupHooks = Array.isArray(group && group.hooks) ? group.hooks : [];
        const filtered = groupHooks.filter((entry) => {
          const command = String(entry && entry.command ? entry.command : '');
          return !targets.some((needle) => command.includes(needle));
        });
        return { ...(group || {}), hooks: filtered };
      })
      .filter((group) => Array.isArray(group.hooks) && group.hooks.length > 0);

    if (cleanedGroups.length > 0) {
      hooks[eventName] = cleanedGroups;
    } else {
      delete hooks[eventName];
    }
  };

  cleanEvent('SessionStart');
  cleanEvent('UserPromptSubmit');
  cleanEvent('SessionEnd');
  cleanEvent('session_start');
  cleanEvent('user_prompt_submit');
  cleanEvent('session_end');

  result.hooks = hooks;
  return result;
}

function mergeHippocoreHooks(existingPayload, { projectRoot, desiredHooks }) {
  const base = (existingPayload && typeof existingPayload === 'object')
    ? JSON.parse(JSON.stringify(existingPayload))
    : {};

  const existingHooksOnly = { hooks: (base.hooks && typeof base.hooks === 'object') ? base.hooks : {} };
  const cleanedHooks = stripHippocoreHooks(existingHooksOnly, { projectRoot }).hooks;
  const mergedHooks = { ...cleanedHooks };

  for (const [eventName, groups] of Object.entries(desiredHooks || {})) {
    const existingGroups = Array.isArray(mergedHooks[eventName]) ? mergedHooks[eventName] : [];
    const additions = Array.isArray(groups)
      ? JSON.parse(JSON.stringify(groups))
      : [];
    mergedHooks[eventName] = [...existingGroups, ...additions];
  }

  base.hooks = mergedHooks;
  return base;
}

function ensureWorkspaceReadme(projectRoot) {
  const readmePath = path.join(projectRoot, 'hippocore', 'README.md');
  if (fs.existsSync(readmePath)) return readmePath;

  const content = [
    '# Hippocore Workspace',
    '',
    'This folder is the Obsidian-friendly knowledge root for Hippocore.',
    '',
    '## Folders',
    '- `global/`: reusable cross-project knowledge',
    '- `projects/`: project-specific notes',
    '- `imports/obsidian/`: drop-in markdown imports',
    '- `imports/chats/`: chat transcript imports',
    '- `system/views/`: generated memory views and relation graph indexes',
    '',
    'Use `hippocore sync` to ingest and project memory views.',
    '',
  ].join('\n');

  fs.writeFileSync(readmePath, content, 'utf8');
  return readmePath;
}

function ensureObsidianScaffold(projectRoot) {
  const files = [
    {
      path: path.join(projectRoot, 'hippocore', 'global', 'README.md'),
      content: [
        '# Global Knowledge',
        '',
        'Store reusable, cross-project knowledge here.',
        'Suggested frontmatter: `memory_scope: global`.',
        '',
      ].join('\n'),
    },
    {
      path: path.join(projectRoot, 'hippocore', 'projects', 'README.md'),
      content: [
        '# Projects',
        '',
        'Create one folder per project under this directory.',
        'Suggested path: `hippocore/projects/<project_id>/`.',
        '',
      ].join('\n'),
    },
    {
      path: path.join(projectRoot, 'hippocore', 'projects', 'main', 'README.md'),
      content: [
        '# main',
        '',
        'Default project space for notes, decisions, and tasks.',
        'You can also create additional project folders in `../`.',
        '',
      ].join('\n'),
    },
    {
      path: path.join(projectRoot, 'hippocore', 'imports', 'obsidian', 'README.md'),
      content: [
        '# Obsidian Imports',
        '',
        'Drop markdown files here for ingestion.',
        '',
      ].join('\n'),
    },
    {
      path: path.join(projectRoot, 'hippocore', 'imports', 'chats', 'README.md'),
      content: [
        '# Chat Imports',
        '',
        'Drop chat transcripts here for ingestion.',
        '',
      ].join('\n'),
    },
  ];

  for (const file of files) {
    if (fs.existsSync(file.path)) continue;
    ensureDir(path.dirname(file.path));
    fs.writeFileSync(file.path, file.content, 'utf8');
  }
}

function initProject({ cwd = process.cwd() } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const { config, configPath, dbPath } = initConfig(projectRoot);

  ensureDir(path.join(projectRoot, 'hippocore', 'system', 'backups'));
  withDb(dbPath, () => undefined);
  ensureWorkspaceReadme(projectRoot);
  ensureObsidianScaffold(projectRoot);

  // Render empty views on first init for immediate Obsidian visibility.
  withDb(dbPath, (db) => {
    renderProjection(db, config, projectRoot);
  });

  return {
    projectRoot,
    configPath,
    dbPath,
    config,
  };
}

function connectSource({ cwd = process.cwd(), source, sourcePath }) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const absPath = path.resolve(sourcePath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  if (source === 'obsidian') {
    config.paths.obsidianVault = absPath;
  } else if (source === 'clawdbot' || source === 'chat') {
    config.paths.clawdbotTranscripts = absPath;
  } else {
    throw new Error('Source must be one of: obsidian, clawdbot');
  }

  const configPath = saveConfig(projectRoot, config, {
    configPath: config.__meta && config.__meta.configPath ? config.__meta.configPath : getPreferredConfigPath(projectRoot),
  });

  return {
    source,
    path: absPath,
    configPath,
  };
}

function detectOpenClawHome(openclawHome = null) {
  if (openclawHome) return path.resolve(openclawHome);
  if (process.env.OPENCLAW_HOME) return path.resolve(process.env.OPENCLAW_HOME);
  return path.join(os.homedir(), '.openclaw');
}

function detectOpenClawSessionsPath(openclawHome) {
  const candidates = [
    path.join(openclawHome, 'agents', 'main', 'sessions'),
    path.join(openclawHome, 'sessions'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function discoverOpenClawAgents(openclawHome) {
  const agentsRoot = path.join(openclawHome, 'agents');
  if (!fs.existsSync(agentsRoot)) return [];

  let entries = [];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    const name = entry.name;
    const agentDir = path.join(agentsRoot, name, 'agent');
    if (!fs.existsSync(agentDir)) continue;
    out.push({
      name,
      agentDir,
      hooksPath: path.join(agentDir, 'hooks.json'),
      exists: true,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function parseInstallAgents(input) {
  if (input == null) return { mode: 'all', values: [] };
  if (Array.isArray(input)) {
    const values = Array.from(new Set(input.map((x) => String(x || '').trim()).filter(Boolean)));
    if (!values.length) return { mode: 'all', values: [] };
    if (values.some((x) => x.toLowerCase() === 'all')) return { mode: 'all', values: [] };
    return { mode: 'subset', values };
  }

  const raw = String(input || '').trim();
  if (!raw) return { mode: 'all', values: [] };
  if (raw.toLowerCase() === 'all') return { mode: 'all', values: [] };
  const values = Array.from(new Set(raw.split(',').map((x) => x.trim()).filter(Boolean)));
  if (!values.length) return { mode: 'all', values: [] };
  if (values.some((x) => x.toLowerCase() === 'all')) return { mode: 'all', values: [] };
  return { mode: 'subset', values };
}

function resolveInstallAgentTargets({ openclawHome, installAgents = 'all' } = {}) {
  const parsed = parseInstallAgents(installAgents);
  const discovered = discoverOpenClawAgents(openclawHome);
  const warnings = [];

  if (parsed.mode === 'all') {
    if (discovered.length > 0) {
      return {
        mode: 'all',
        targets: discovered,
        warnings,
      };
    }

    const fallbackAgentDir = path.join(openclawHome, 'agents', 'main', 'agent');
    return {
      mode: 'all',
      targets: [{
        name: 'main',
        agentDir: fallbackAgentDir,
        hooksPath: path.join(fallbackAgentDir, 'hooks.json'),
        exists: false,
      }],
      warnings: ['No existing OpenClaw agents discovered; fallback target main created.'],
    };
  }

  const discoveredMap = new Map(discovered.map((item) => [item.name, item]));
  const targets = [];
  for (const name of parsed.values) {
    const hit = discoveredMap.get(name);
    if (hit) {
      targets.push(hit);
    } else {
      warnings.push(`Agent "${name}" not found under ${path.join(openclawHome, 'agents')}; skipped.`);
    }
  }

  return {
    mode: 'subset',
    targets,
    warnings,
  };
}

function detectObsidianVault({ projectRoot, explicitPath = null }) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Obsidian vault path does not exist: ${resolved}`);
    }
    return resolved;
  }

  const envCandidates = [
    process.env.HIPPOCORE_OBSIDIAN_VAULT,
    process.env.OBSIDIAN_VAULT,
    process.env.OBSIDIAN_VAULT_PATH,
  ].filter(Boolean);

  for (const maybe of envCandidates) {
    const resolved = path.resolve(maybe);
    if (fs.existsSync(path.join(resolved, '.obsidian'))) return resolved;
  }

  const localCandidates = [
    projectRoot,
    path.dirname(projectRoot),
  ];

  for (const candidate of localCandidates) {
    if (fs.existsSync(path.join(candidate, '.obsidian'))) {
      return candidate;
    }
  }

  return null;
}

function installOpenClawIntegration({ projectRoot, openclawHome, installAgents = 'all' }) {
  const resolvedOpenClawHome = detectOpenClawHome(openclawHome);
  const runtimeRoot = path.join(resolvedOpenClawHome, 'hippocore');
  const defaultMainHooksPath = path.join(resolvedOpenClawHome, 'agents', 'main', 'agent', 'hooks.json');
  const runtimeHooksPath = path.join(runtimeRoot, 'hooks.json');
  const runtimePluginManifestPath = path.join(runtimeRoot, 'openclaw.plugin.json');
  const runtimeInstallMetaPath = path.join(runtimeRoot, 'install.json');
  const runtimeEnvPath = path.join(runtimeRoot, 'env.sh');

  ensureDir(runtimeRoot);

  const bundledScripts = resolveBundledHookScripts();
  const sessionScript = bundledScripts['session_start.js'];
  const promptScript = bundledScripts['user_prompt_submit.js'];
  const sessionEndScript = bundledScripts['session_end.js'];
  const pluginEntrypoint = path.join(projectRoot, 'openclaw.plugin.js');

  const commandPrefix = `HIPPOCORE_PROJECT_ROOT=${shellQuote(projectRoot)}`;
  const hooksPayload = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `${commandPrefix} node ${shellQuote(sessionScript)}`,
              timeout: 8,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `${commandPrefix} node ${shellQuote(promptScript)}`,
              timeout: 8,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: `${commandPrefix} node ${shellQuote(sessionEndScript)}`,
              timeout: 12,
            },
          ],
        },
      ],
    },
  };

  const targetResolution = resolveInstallAgentTargets({
    openclawHome: resolvedOpenClawHome,
    installAgents,
  });
  const integrationWarnings = [...targetResolution.warnings];
  const integrationErrors = [];
  const agentTargets = [];
  const agentHookBackups = [];
  const agentHookChanges = {};
  const desiredHooks = hooksPayload.hooks;

  for (const target of targetResolution.targets) {
    ensureDir(target.agentDir);
    const existingHooks = readJsonSafe(target.hooksPath, { hooks: {} });
    const mergedHooks = mergeHippocoreHooks(existingHooks, {
      projectRoot,
      desiredHooks,
    });

    try {
      const writeResult = writeJsonWithBackup(target.hooksPath, mergedHooks);
      agentHookChanges[target.hooksPath] = writeResult.changed;
      agentTargets.push({
        name: target.name,
        hooksPath: target.hooksPath,
        changed: writeResult.changed,
        warning: null,
      });
      if (writeResult.backupPath) {
        agentHookBackups.push(writeResult.backupPath);
      }
    } catch (err) {
      const message = `Failed to write hooks for agent ${target.name}: ${err.message}`;
      integrationErrors.push(message);
      agentHookChanges[target.hooksPath] = false;
      agentTargets.push({
        name: target.name,
        hooksPath: target.hooksPath,
        changed: false,
        warning: message,
      });
    }
  }

  if (agentTargets.length === 0) {
    integrationWarnings.push('No valid agent targets resolved; no agent hooks were modified.');
  }

  const preferredMainTarget = agentTargets.find((item) => item.name === 'main') || null;
  const primaryHooksPath = preferredMainTarget
    ? preferredMainTarget.hooksPath
    : (agentTargets[0] ? agentTargets[0].hooksPath : defaultMainHooksPath);

  const pluginManifest = {
    id: 'hippocore',
    name: 'Hippocore',
    description: 'Hippocore (海马体): human + AI shared memory with layered retrieval and relation graph views.',
    version: '0.2.0',
    repository: `local:${projectRoot}`,
    extensions: [pluginEntrypoint],
    configSchema: {
      type: 'object',
      properties: {
        projectRoot: {
          type: 'string',
          default: projectRoot,
          description: 'Path containing hippocore workspace',
        },
      },
      additionalProperties: false,
    },
  };

  const installMeta = {
    installedAt: nowIso(),
    openclawHome: resolvedOpenClawHome,
    projectRoot,
    installAgents: targetResolution.mode === 'all'
      ? 'all'
      : targetResolution.targets.map((item) => item.name).join(','),
    agentTargets: agentTargets.map((item) => ({
      name: item.name,
      hooksPath: item.hooksPath,
      changed: item.changed,
      warning: item.warning,
    })),
    files: {
      hooksPath: primaryHooksPath,
      agentHookPaths: agentTargets.map((item) => item.hooksPath),
      runtimeHooksPath,
      runtimePluginManifestPath,
      runtimeEnvPath,
    },
    scriptBindings: {
      sessionStart: sessionScript,
      userPromptSubmit: promptScript,
      sessionEnd: sessionEndScript,
    },
  };

  const existingRuntimeHooks = readJsonSafe(runtimeHooksPath, { hooks: {} });
  const mergedRuntimeHooks = mergeHippocoreHooks(existingRuntimeHooks, {
    projectRoot,
    desiredHooks: hooksPayload.hooks,
  });

  let hookRuntimeResult = { changed: false, backupPath: null };
  let pluginResult = { changed: false, backupPath: null };
  let installResult = { changed: false, backupPath: null };

  try {
    hookRuntimeResult = writeJsonWithBackup(runtimeHooksPath, mergedRuntimeHooks);
  } catch (err) {
    integrationErrors.push(`Failed to write runtime hooks: ${err.message}`);
  }
  try {
    pluginResult = writeJsonWithBackup(runtimePluginManifestPath, pluginManifest);
  } catch (err) {
    integrationErrors.push(`Failed to write runtime plugin manifest: ${err.message}`);
  }
  try {
    installResult = writeJsonWithBackup(runtimeInstallMetaPath, installMeta);
  } catch (err) {
    integrationErrors.push(`Failed to write runtime install metadata: ${err.message}`);
  }

  const envContent = [
    '#!/usr/bin/env bash',
    `export HIPPOCORE_PROJECT_ROOT=${shellQuote(projectRoot)}`,
    `export CLAUDE_PLUGIN_ROOT=${shellQuote(projectRoot)}`,
    '',
  ].join('\n');
  fs.writeFileSync(runtimeEnvPath, envContent, 'utf8');
  try {
    fs.chmodSync(runtimeEnvPath, 0o755);
  } catch {
    // Non-fatal on platforms/filesystems that do not support chmod.
  }

  return {
    ok: integrationErrors.length === 0,
    openclawHome: resolvedOpenClawHome,
    hooksPath: primaryHooksPath,
    runtimeHooksPath,
    runtimePluginManifestPath,
    runtimeEnvPath,
    installAgents: targetResolution.mode === 'all'
      ? 'all'
      : targetResolution.targets.map((item) => item.name).join(','),
    agentTargets,
    warnings: integrationWarnings,
    errors: integrationErrors,
    changedFiles: {
      hooksPath: Boolean(agentHookChanges[primaryHooksPath]),
      agentHooks: agentHookChanges,
      runtimeHooksPath: hookRuntimeResult.changed,
      runtimePluginManifestPath: pluginResult.changed,
      runtimeInstallMetaPath: installResult.changed,
    },
    backups: [
      ...agentHookBackups,
      hookRuntimeResult.backupPath,
      pluginResult.backupPath,
      installResult.backupPath,
    ].filter(Boolean),
  };
}

function setupHippocore({
  cwd = process.cwd(),
  openclawHome = null,
  installAgents = 'all',
  obsidianVault = null,
  sessionsPath = null,
  runInitialSync = true,
  installHooks = true,
  mode = 'auto',
  storage = null,
  notionMemoryDataSourceId = null,
  notionRelationsDataSourceId = null,
  notionDocDataSourceIds = null,
  notionPollIntervalSec = null,
  llmBaseUrl = null,
  llmModel = null,
  llmApiKeyEnv = null,
  llmTimeoutMs = null,
  llmConcurrency = null,
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const installMode = detectInstallMode({ mode });
  const hadConfigBeforeSetup = fs.existsSync(getPreferredConfigPath(projectRoot))
    || fs.existsSync(getLegacyConfigPath(projectRoot));
  const mirror = buildMirrorRecommendation({ installMode, projectRoot });
  const startedAt = nowIso();
  const init = initProject({ cwd: projectRoot });
  const config = loadConfig(projectRoot);

  const detectedVault = detectObsidianVault({ projectRoot, explicitPath: obsidianVault });
  const resolvedOpenClawHome = detectOpenClawHome(openclawHome);
  const detectedSessions = sessionsPath
    ? path.resolve(sessionsPath)
    : detectOpenClawSessionsPath(resolvedOpenClawHome);

  if (detectedVault) config.paths.obsidianVault = detectedVault;
  if (detectedSessions && fs.existsSync(detectedSessions)) {
    config.paths.clawdbotTranscripts = detectedSessions;
  }

  const requestedStorageMode = resolveSetupStorageMode({
    explicitStorage: storage,
    config,
    installMode,
    hadConfigBeforeSetup,
  });
  config.storage = config.storage || { mode: 'local', notion: {} };
  config.storage.mode = requestedStorageMode === 'notion' ? 'notion' : 'local';
  config.storage.notion = {
    ...(config.storage.notion || {}),
    ...(notionMemoryDataSourceId ? { memoryDataSourceId: notionMemoryDataSourceId } : {}),
    ...(notionRelationsDataSourceId ? { relationsDataSourceId: notionRelationsDataSourceId } : {}),
    ...(notionDocDataSourceIds ? { docDataSourceIds: Array.isArray(notionDocDataSourceIds) ? notionDocDataSourceIds : String(notionDocDataSourceIds).split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    ...(notionPollIntervalSec ? { pollIntervalSec: Number(notionPollIntervalSec) } : {}),
  };
  config.quality = config.quality || {};
  config.quality.enrichment = config.quality.enrichment || {};
  config.quality.enrichment.llm = config.quality.enrichment.llm || {};
  if (llmBaseUrl) config.quality.enrichment.llm.baseUrl = String(llmBaseUrl);
  if (llmModel) config.quality.enrichment.llm.model = String(llmModel);
  if (llmApiKeyEnv) config.quality.enrichment.llm.apiKeyEnv = String(llmApiKeyEnv);
  if (llmTimeoutMs != null) config.quality.enrichment.llm.timeoutMs = Number(llmTimeoutMs);
  if (llmConcurrency != null) config.quality.enrichment.llm.concurrency = Number(llmConcurrency);

  const notionMode = isNotionMode(config);
  const existingMirror = (config.mirror && typeof config.mirror === 'object') ? config.mirror : {};
  const configuredRemote = (typeof existingMirror.remote === 'string' && existingMirror.remote.trim())
    ? existingMirror.remote.trim()
    : mirror.remote;
  const configuredLocal = (typeof existingMirror.local === 'string' && existingMirror.local.trim())
    ? existingMirror.local.trim()
    : mirror.local;
  const existingCompletedAt = normalizeOptionalString(existingMirror.completedAt);
  config.mirror = {
    ...existingMirror,
    remote: configuredRemote,
    local: configuredLocal,
    required: notionMode ? false : installMode === 'cloud',
    completedAt: existingCompletedAt,
  };

  const configPath = saveConfig(projectRoot, config, {
    configPath: config.__meta && config.__meta.configPath ? config.__meta.configPath : getPreferredConfigPath(projectRoot),
  });

  const integration = installHooks
    ? installOpenClawIntegration({ projectRoot, openclawHome: resolvedOpenClawHome, installAgents })
    : null;

  let syncSummary = null;
  if (runInitialSync) {
    syncSummary = notionMode
      ? syncNotionSources({ cwd: projectRoot, fullBackfill: true })
      : runSync({ cwd: projectRoot });
  }
  const doctor = runDoctor({ cwd: projectRoot });
  const notionOnboarding = getNotionOnboardingStatus(doctor.config, { requireDocSources: true });
  const notionConnectivity = notionOnboarding
    ? {
      ok: notionOnboarding.ready,
      checked: notionOnboarding.checked,
      settings: notionOnboarding.settings,
      docSourcesConfigured: notionOnboarding.docSourcesConfigured,
      docSourcesValidated: notionOnboarding.docSourcesValidated,
      warnings: notionOnboarding.warnings,
      errors: notionOnboarding.errors,
    }
    : null;
  const mirrorOnboarding = getMirrorOnboardingStatus({
    config: doctor.config,
    installMode,
    recommendation: mirror,
  });
  const blockedByNotion = notionMode && notionOnboarding && !notionOnboarding.ready;
  const blockedByInitialNotionSync = notionMode
    && runInitialSync
    && (!syncSummary || syncSummary.status !== 'success');
  const installStatus = doctor.ok && !blockedByNotion && !blockedByInitialNotionSync
    ? 'completed'
    : (blockedByNotion || blockedByInitialNotionSync
      ? 'blocked_notion_required'
      : (mirrorOnboarding.blocking ? 'blocked_mirror_required' : 'blocked_health_check'));
  const finishedAt = nowIso();
  const enrichmentStats = syncSummary && syncSummary.enrichmentStats
    ? syncSummary.enrichmentStats
    : createEnrichmentStats();

  return {
    ok: doctor.ok && !blockedByNotion && !blockedByInitialNotionSync,
    flow: 'guided_setup',
    startedAt,
    finishedAt,
    projectRoot,
    openclawHome: resolvedOpenClawHome,
    installMode,
    configPath,
    initialized: init,
    sources: {
      obsidianVault: config.paths.obsidianVault || null,
      clawdbotTranscripts: config.paths.clawdbotTranscripts || null,
    },
    integration,
    syncSummary,
    enrichmentStats,
    doctor,
    storage: doctor.config.storage || { mode: 'local' },
    notionConnectivity,
    notionOnboarding,
    onboarding: {
      installStatus,
      phases: [
        { name: 'install_integration', status: installHooks ? 'completed' : 'skipped' },
        { name: 'initialize_workspace', status: 'completed' },
        {
          name: 'mirror_setup',
          status: notionMode
            ? 'skipped'
            : (mirrorOnboarding.required
            ? (mirrorOnboarding.ready ? 'completed' : 'blocked')
            : 'optional'),
        },
        {
          name: 'notion_setup',
          status: notionMode
            ? (notionOnboarding.ready ? 'completed' : 'blocked')
            : 'skipped',
        },
        {
          name: 'initial_sync',
          status: runInitialSync
            ? ((blockedByInitialNotionSync || (syncSummary && syncSummary.status !== 'success')) ? 'blocked' : 'completed')
            : 'skipped',
        },
        { name: 'health_check', status: doctor.ok ? 'passed' : 'failed' },
      ],
      mirror,
      mirrorOnboarding,
      nextActions: notionMode
        ? (notionOnboarding.ready
          ? (blockedByInitialNotionSync ? ['run_notion_sync'] : ['notion_storage_ready'])
          : notionOnboarding.nextActions)
        : (mirrorOnboarding.blocking
        ? ['complete_required_local_mirror']
        : (mirror.shouldRecommend ? ['mirror_optional'] : ['mirror_optional'])),
    },
  };
}

function upgradeHippocore({
  cwd = process.cwd(),
  openclawHome = null,
  installAgents = 'all',
  obsidianVault = null,
  sessionsPath = null,
  runInitialSync = true,
  installHooks = true,
  mode = 'auto',
  createDataBackup = true,
  storage = null,
  notionMemoryDataSourceId = null,
  notionRelationsDataSourceId = null,
  notionDocDataSourceIds = null,
  notionPollIntervalSec = null,
  llmBaseUrl = null,
  llmModel = null,
  llmApiKeyEnv = null,
  llmTimeoutMs = null,
  llmConcurrency = null,
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const existingConfig = loadConfig(projectRoot);
  const existingDbPath = resolveConfiguredPath(projectRoot, existingConfig.paths.db);
  const backup = (createDataBackup && fs.existsSync(existingDbPath))
    ? createBackup({ cwd: projectRoot })
    : null;
  const setup = setupHippocore({
    cwd: projectRoot,
    openclawHome,
    installAgents,
    obsidianVault,
    sessionsPath,
    runInitialSync,
    installHooks,
    mode,
    storage,
    notionMemoryDataSourceId,
    notionRelationsDataSourceId,
    notionDocDataSourceIds,
    notionPollIntervalSec,
    llmBaseUrl,
    llmModel,
    llmApiKeyEnv,
    llmTimeoutMs,
    llmConcurrency,
  });

  return {
    ok: setup.ok,
    flow: 'upgrade',
    projectRoot,
    backup,
    setup,
    doctor: setup.doctor,
    completedAt: nowIso(),
  };
}

function uninstallHippocore({
  cwd = process.cwd(),
  openclawHome = null,
  keepData = true,
  keepHooks = false,
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const resolvedOpenClawHome = detectOpenClawHome(openclawHome);
  const runtimeRoot = path.join(resolvedOpenClawHome, 'hippocore');
  const defaultMainHooksPath = path.join(resolvedOpenClawHome, 'agents', 'main', 'agent', 'hooks.json');
  const workspacePath = path.join(projectRoot, 'hippocore');

  const summary = {
    ok: true,
    flow: 'uninstall',
    projectRoot,
    openclawHome: resolvedOpenClawHome,
    keepData: Boolean(keepData),
    keepHooks: Boolean(keepHooks),
    removedPaths: [],
    restoredFiles: [],
    notes: [],
    completedAt: nowIso(),
  };

  const cleanupHookFile = (hooksPath) => {
    try {
      const currentHooks = readJsonSafe(hooksPath, null);
      if (currentHooks && typeof currentHooks === 'object') {
        const cleaned = stripHippocoreHooks(currentHooks, { projectRoot });
        const writeResult = writeJsonWithBackup(hooksPath, cleaned);
        summary.restoredFiles.push({
          target: hooksPath,
          fromBackup: writeResult.backupPath || null,
          mode: 'strip_only_hippocore_entries',
        });
        return;
      }

      const latestBackup = findLatestBackupForFile(hooksPath);
      if (latestBackup && fs.existsSync(latestBackup)) {
        const backupHooks = readJsonSafe(latestBackup, { hooks: {} });
        const cleaned = stripHippocoreHooks(backupHooks, { projectRoot });
        const writeResult = writeJsonWithBackup(hooksPath, cleaned);
        summary.restoredFiles.push({
          target: hooksPath,
          fromBackup: latestBackup,
          appliedBackupCopy: writeResult.backupPath || null,
          mode: 'recover_from_backup_and_strip',
        });
      } else {
        summary.notes.push(`hooks_json_unparseable_and_no_backup_skip_hooks_cleanup:${hooksPath}`);
      }
    } catch (err) {
      summary.ok = false;
      summary.notes.push(`hooks_cleanup_failed:${hooksPath}:${err.message}`);
    }
  };

  if (!keepHooks) {
    const discoveredHooks = discoverOpenClawAgents(resolvedOpenClawHome).map((item) => item.hooksPath);
    const hookTargets = Array.from(new Set([
      ...discoveredHooks,
      ...(fs.existsSync(defaultMainHooksPath) ? [defaultMainHooksPath] : []),
    ]));

    for (const hooksPath of hookTargets) {
      if (!fs.existsSync(hooksPath)) continue;
      cleanupHookFile(hooksPath);
    }
  } else {
    summary.notes.push('hooks_kept_as_requested');
  }

  if (fs.existsSync(runtimeRoot)) {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    summary.removedPaths.push(runtimeRoot);
  }

  if (!keepData && fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    summary.removedPaths.push(workspacePath);
  } else if (keepData) {
    summary.notes.push('workspace_data_preserved');
  }

  return summary;
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: options.cwd || undefined,
  });

  if (result.error) {
    return {
      status: 1,
      signal: null,
      stdout: '',
      stderr: result.error.message,
      error: result.error.message,
      command: [cmd, ...args].join(' '),
    };
  }

  return {
    status: Number(result.status ?? 0),
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: [cmd, ...args].join(' '),
  };
}

function withTrailingSlash(rawPath) {
  return rawPath.endsWith('/') ? rawPath : `${rawPath}/`;
}

function ensureRsync(executor) {
  const out = executor('rsync', ['--version']);
  if (out.status !== 0) {
    throw new Error(`rsync is required for mirror operations. ${out.stderr || out.error || ''}`.trim());
  }
}

function mirrorOnce({ source, target, deleteExtra = false, dryRun = false, executor }) {
  const args = [
    '-az',
    '--human-readable',
    '--omit-dir-times',
    '--exclude=.DS_Store',
    '--exclude=system/logs',
    '--exclude=system/backups',
  ];

  if (deleteExtra) args.push('--delete');
  if (dryRun) args.push('--dry-run', '--itemize-changes');

  args.push(withTrailingSlash(source), withTrailingSlash(target));
  const out = executor('rsync', args);

  if (out.status !== 0) {
    throw new Error(`Mirror rsync failed (${source} -> ${target}): ${out.stderr || out.error || 'unknown error'}`);
  }

  return {
    source,
    target,
    command: out.command,
    stdout: out.stdout,
    stderr: out.stderr,
    status: out.status,
  };
}

function mirrorHippocore({
  cwd = process.cwd(),
  action = 'sync',
  remote,
  localPath = null,
  deleteExtra = false,
  dryRun = false,
  prefer = 'remote',
  executor = runCommand,
} = {}) {
  if (!remote || !String(remote).includes(':')) {
    throw new Error('Remote must be in ssh rsync format, e.g. user@host:/abs/path/to/hippocore');
  }

  const projectRoot = resolveProjectRoot(cwd);
  const localRoot = path.resolve(localPath || path.join(projectRoot, 'hippocore'));
  const normalizedAction = String(action || 'sync').toLowerCase();
  const normalizedPrefer = String(prefer || 'remote').toLowerCase();

  if (!['pull', 'push', 'sync'].includes(normalizedAction)) {
    throw new Error('Action must be one of: pull, push, sync');
  }
  if (!['local', 'remote'].includes(normalizedPrefer)) {
    throw new Error('Prefer must be one of: local, remote');
  }

  ensureRsync(executor);

  if ((normalizedAction === 'pull' || normalizedAction === 'sync') && !fs.existsSync(localRoot)) {
    ensureDir(localRoot);
  }

  if ((normalizedAction === 'push' || normalizedAction === 'sync') && !fs.existsSync(localRoot)) {
    throw new Error(`Local path does not exist: ${localRoot}`);
  }

  const operations = [];
  if (normalizedAction === 'pull') {
    operations.push({ source: remote, target: localRoot });
  } else if (normalizedAction === 'push') {
    operations.push({ source: localRoot, target: remote });
  } else {
    if (normalizedPrefer === 'local') {
      operations.push({ source: localRoot, target: remote });
      operations.push({ source: remote, target: localRoot });
    } else {
      operations.push({ source: remote, target: localRoot });
      operations.push({ source: localRoot, target: remote });
    }
  }

  const runs = [];
  for (const op of operations) {
    runs.push(mirrorOnce({
      source: op.source,
      target: op.target,
      deleteExtra,
      dryRun,
      executor,
    }));
  }

  let configPath = null;
  let mirrorOnboarding = null;
  if (!dryRun) {
    const config = loadConfig(projectRoot);
    const existingMirror = (config.mirror && typeof config.mirror === 'object') ? config.mirror : {};
    const required = (typeof existingMirror.required === 'boolean') ? existingMirror.required : false;
    config.mirror = {
      ...existingMirror,
      remote: remote,
      local: localRoot,
      required,
      completedAt: nowIso(),
      lastAction: normalizedAction,
      lastActionAt: nowIso(),
    };
    configPath = saveConfig(projectRoot, config, {
      configPath: config.__meta && config.__meta.configPath ? config.__meta.configPath : getPreferredConfigPath(projectRoot),
    });
    mirrorOnboarding = getMirrorOnboardingStatus({ config });
  } else {
    mirrorOnboarding = getMirrorOnboardingStatus({ config: loadConfig(projectRoot) });
  }

  return {
    ok: true,
    action: normalizedAction,
    prefer: normalizedPrefer,
    dryRun: Boolean(dryRun),
    deleteExtra: Boolean(deleteExtra),
    remote,
    localPath: localRoot,
    operations: runs,
    configPath,
    mirrorOnboarding,
  };
}

function completeMirrorOnboarding({
  cwd = process.cwd(),
  remote = null,
  localPath = null,
  note = null,
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const existingMirror = (config.mirror && typeof config.mirror === 'object') ? config.mirror : {};
  const nextRemote = normalizeOptionalString(remote) || normalizeOptionalString(existingMirror.remote);
  const nextLocal = normalizeOptionalString(localPath) || normalizeOptionalString(existingMirror.local);
  if (!nextRemote || !nextLocal) {
    throw new Error('Mirror completion requires both remote and local values. Run setup first or pass --remote/--local.');
  }

  const required = (typeof existingMirror.required === 'boolean') ? existingMirror.required : true;
  const normalizedNote = normalizeOptionalString(note);
  config.mirror = {
    ...existingMirror,
    remote: nextRemote,
    local: nextLocal,
    required,
    completedAt: nowIso(),
    completionSource: 'manual_ack',
    lastAction: 'complete',
    lastActionAt: nowIso(),
    note: normalizedNote || existingMirror.note || null,
  };

  const configPath = saveConfig(projectRoot, config, {
    configPath: config.__meta && config.__meta.configPath ? config.__meta.configPath : getPreferredConfigPath(projectRoot),
  });
  const doctor = runDoctor({ cwd: projectRoot });
  const mirrorOnboarding = getMirrorOnboardingStatus({ config: doctor.config });

  return {
    ok: doctor.ok,
    projectRoot,
    configPath,
    mirrorOnboarding,
    doctor,
  };
}

function getMirrorStatus({ cwd = process.cwd() } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const doctor = runDoctor({ cwd: projectRoot });
  const mirrorOnboarding = getMirrorOnboardingStatus({ config: doctor.config });
  return {
    ok: doctor.ok,
    projectRoot,
    mirrorOnboarding,
    doctor,
  };
}

function getNotionStatus({ cwd = process.cwd() } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const validation = validateNotionConfig(config, process.env, { requireDocSources: true });
  const connectivity = getNotionConnectivity(config, { requireDocSources: true });

  return {
    ok: validation.ok && connectivity.ok,
    projectRoot,
    storageMode: resolveStorageMode(config),
    validation,
    connectivity,
    configPath: (config.__meta && config.__meta.configPath) || getPreferredConfigPath(projectRoot),
  };
}

function syncNotionSources({ cwd = process.cwd(), fullBackfill = false } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  if (!isNotionMode(config)) {
    throw new Error('Notion sync is only available when storage.mode=notion');
  }
  const out = runSync({
    cwd: projectRoot,
    includeConfiguredSources: true,
    fullBackfill: Boolean(fullBackfill),
  });
  return {
    ok: out.status === 'success',
    fullBackfill: Boolean(fullBackfill),
    ...out,
  };
}

function migrateNotionMemory({ cwd = process.cwd(), full = false } = {}) {
  if (!full) {
    throw new Error('Notion migrate requires --full');
  }
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  if (!isNotionMode(config)) {
    throw new Error('Notion migrate is only available when storage.mode=notion');
  }

  const { client, settings, schemaMaps } = buildNotionClient(config);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  const migration = withDb(dbPath, (db) => migrateAllToNotionSync({
    db,
    client,
    memoryDataSourceId: settings.memoryDataSourceId,
    relationsDataSourceId: settings.relationsDataSourceId,
    schemaMaps,
    nowIso,
  }));

  return {
    ok: true,
    projectRoot,
    migration,
  };
}

function createSyncRun(db) {
  const startedAt = nowIso();
  db.prepare(`
    INSERT INTO sync_runs(started_at, status, processed_sources, created_items, updated_items)
    VALUES (?, 'running', 0, 0, 0)
  `).run(startedAt);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function finishSyncRun(db, syncRunId, payload) {
  db.prepare(`
    UPDATE sync_runs
    SET ended_at = ?, status = ?, processed_sources = ?, created_items = ?, updated_items = ?, errors_json = ?
    WHERE id = ?
  `).run(
    nowIso(),
    payload.status,
    payload.processedSources,
    payload.createdItems,
    payload.updatedItems,
    JSON.stringify(payload.errors || []),
    syncRunId,
  );
}

function upsertProjectRecord(db, projectId) {
  if (!projectId) return;
  db.prepare(`
    INSERT OR IGNORE INTO projects(id, name, source_rule, created_at)
    VALUES (?, ?, ?, ?)
  `).run(projectId, projectId, null, nowIso());
}

function upsertSourceRecord(db, source) {
  const existing = db.prepare(`
    SELECT id, content_hash, mtime_ms
    FROM source_records
    WHERE source_type = ? AND source_path = ?
  `).get(source.sourceType, source.sourcePath);

  if (!existing) {
    db.prepare(`
      INSERT INTO source_records(source_type, source_path, content_hash, mtime_ms, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(source.sourceType, source.sourcePath, source.contentHash, source.mtimeMs, nowIso());
    const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    return { id, changed: true };
  }

  const changed = existing.content_hash !== source.contentHash || Number(existing.mtime_ms) !== Number(source.mtimeMs);

  db.prepare(`
    UPDATE source_records
    SET content_hash = ?, mtime_ms = ?, last_seen_at = ?
    WHERE id = ?
  `).run(source.contentHash, source.mtimeMs, nowIso(), existing.id);

  return { id: existing.id, changed };
}

function replaceChunks(db, sourceRecordId, chunks) {
  db.prepare('DELETE FROM raw_chunks WHERE source_record_id = ?').run(sourceRecordId);

  const insert = db.prepare(`
    INSERT INTO raw_chunks(source_record_id, chunk_index, line_start, line_end, chunk_text, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const chunkIds = [];
  for (const chunk of chunks) {
    insert.run(sourceRecordId, chunk.chunkIndex, chunk.lineStart, chunk.lineEnd, chunk.text, chunk.contentHash, nowIso());
    const chunkId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    chunkIds.push({ ...chunk, id: chunkId });
  }

  return chunkIds;
}

function upsertMemoryItem(db, item, sourceRecordId, chunkId) {
  const canonicalKey = item.canonicalKey || item.dedupKey;
  const existing = db.prepare(`
    SELECT id, state, scope_level, project_id, source_authority, enrichment_version
    FROM memory_items
    WHERE dedup_key = ? OR canonical_key = ?
    LIMIT 1
  `).get(item.dedupKey, canonicalKey);

  if (!existing) {
    db.prepare(`
      INSERT INTO memory_items(
        type, title, body, confidence, state, status, scope_level, project_id, source_authority,
        importance, freshness_ts, source_record_id, chunk_id, dedup_key, canonical_key,
        context_summary, meaning_summary, actionability_summary, next_action, owner_hint, project_display_name,
        enrichment_source, enrichment_version, llm_enriched_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.type,
      item.title,
      item.body,
      item.confidence,
      item.state,
      stateToStatus(item.state),
      item.scopeLevel || 'project',
      item.projectId || null,
      item.sourceAuthority || 0.7,
      item.importance,
      item.freshnessTs,
      sourceRecordId,
      chunkId,
      item.dedupKey,
      canonicalKey,
      item.context_summary || null,
      item.meaning_summary || null,
      item.actionability_summary || null,
      item.next_action || null,
      item.owner_hint || null,
      item.project_display_name || null,
      item.enrichment_source || 'rule',
      item.enrichment_version || null,
      item.llm_enriched_at || null,
      nowIso(),
      nowIso(),
    );
    const memoryItemId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    return { id: memoryItemId, created: true, canonicalKey };
  }

  const mergedState = mergeState(existing.state || 'candidate', item.state || 'candidate');
  const mergedScope = existing.scope_level || item.scopeLevel || 'project';
  const mergedProject = existing.project_id || item.projectId || null;
  const mergedAuthority = Math.max(Number(existing.source_authority || 0.7), Number(item.sourceAuthority || 0.7));
  const shouldReplaceEnrichment = Boolean(item.enrichment_version)
    && String(item.enrichment_version || '') !== String(existing.enrichment_version || '');

  const enrichmentAssignments = shouldReplaceEnrichment
    ? `
      context_summary = NULLIF(?, ''),
      meaning_summary = NULLIF(?, ''),
      actionability_summary = NULLIF(?, ''),
      next_action = NULLIF(?, ''),
      owner_hint = NULLIF(?, ''),
      project_display_name = NULLIF(?, ''),
      enrichment_source = NULLIF(?, ''),
      enrichment_version = NULLIF(?, ''),
      llm_enriched_at = NULLIF(?, ''),
    `
    : `
      context_summary = COALESCE(NULLIF(?, ''), context_summary),
      meaning_summary = COALESCE(NULLIF(?, ''), meaning_summary),
      actionability_summary = COALESCE(NULLIF(?, ''), actionability_summary),
      next_action = COALESCE(NULLIF(?, ''), next_action),
      owner_hint = COALESCE(NULLIF(?, ''), owner_hint),
      project_display_name = COALESCE(NULLIF(?, ''), project_display_name),
      enrichment_source = COALESCE(NULLIF(?, ''), enrichment_source),
      enrichment_version = COALESCE(NULLIF(?, ''), enrichment_version),
      llm_enriched_at = COALESCE(NULLIF(?, ''), llm_enriched_at),
    `;

  db.prepare(`
    UPDATE memory_items
    SET
      type = ?,
      title = ?,
      body = ?,
      confidence = MAX(confidence, ?),
      state = ?,
      status = ?,
      scope_level = ?,
      project_id = ?,
      source_authority = ?,
      importance = MAX(importance, ?),
      freshness_ts = MAX(freshness_ts, ?),
      source_record_id = ?,
      chunk_id = ?,
      canonical_key = ?,
      ${enrichmentAssignments}
      updated_at = ?
    WHERE id = ?
  `).run(
    item.type,
    item.title,
    item.body,
    item.confidence,
    mergedState,
    stateToStatus(mergedState),
    mergedScope,
    mergedProject,
    mergedAuthority,
    item.importance,
    item.freshnessTs,
    sourceRecordId,
    chunkId,
    canonicalKey,
    item.context_summary || null,
    item.meaning_summary || null,
    item.actionability_summary || null,
    item.next_action || null,
    item.owner_hint || null,
    item.project_display_name || null,
    item.enrichment_source || null,
    item.enrichment_version || null,
    item.llm_enriched_at || null,
    nowIso(),
    existing.id,
  );

  return { id: existing.id, created: false, canonicalKey };
}

function upsertEvidence(db, memoryItemId, evidence) {
  db.prepare(`
    DELETE FROM evidence
    WHERE memory_item_id = ? AND source_type = ? AND source_path = ?
  `).run(memoryItemId, evidence.sourceType, evidence.sourcePath);

  db.prepare(`
    INSERT INTO evidence(memory_item_id, source_type, source_path, line_start, line_end, snippet, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memoryItemId,
    evidence.sourceType,
    evidence.sourcePath,
    evidence.lineStart,
    evidence.lineEnd,
    evidence.snippet,
    evidence.role || null,
    nowIso(),
  );
}

function findMemoryItemByCanonicalKey(db, canonicalKey) {
  return db.prepare(`
    SELECT id, type
    FROM memory_items
    WHERE canonical_key = ? OR dedup_key = ?
    LIMIT 1
  `).get(canonicalKey, canonicalKey);
}

function ensureRelationTarget(db, hint, source) {
  const existing = findMemoryItemByCanonicalKey(db, hint.targetCanonicalKey);
  if (existing) return existing.id;

  if (hint.targetCanonicalKey.startsWith('project:')) {
    const projectId = hint.targetCanonicalKey.slice('project:'.length) || source.projectId || 'main';
    upsertProjectRecord(db, projectId);

    const dedupKey = hint.targetCanonicalKey;
    db.prepare(`
      INSERT OR IGNORE INTO memory_items(
        type, title, body, confidence, state, status, scope_level, project_id, source_authority,
        importance, freshness_ts, source_record_id, chunk_id, dedup_key, canonical_key,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    `).run(
      'Project',
      `Project: ${projectId}`,
      `Project container for ${projectId}`,
      0.9,
      'verified',
      'verified',
      'project',
      projectId,
      1,
      0.8,
      Date.now(),
      dedupKey,
      dedupKey,
      nowIso(),
      nowIso(),
    );

    const row = findMemoryItemByCanonicalKey(db, dedupKey);
    return row ? row.id : null;
  }

  // Materialize lightweight relation target note when wikilink points to unknown entity.
  const dedupKey = hint.targetCanonicalKey;
  db.prepare(`
    INSERT OR IGNORE INTO memory_items(
      type, title, body, confidence, state, status, scope_level, project_id, source_authority,
      importance, freshness_ts, source_record_id, chunk_id, dedup_key, canonical_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
  `).run(
    'Entity',
    `Entity: ${hint.targetLabel || hint.targetCanonicalKey}`,
    hint.targetLabel || hint.targetCanonicalKey,
    0.45,
    'candidate',
    'verified',
    source.scopeLevel || 'project',
    source.projectId || null,
    0.5,
    0.4,
    Date.now(),
    dedupKey,
    dedupKey,
    nowIso(),
    nowIso(),
  );

  const row = findMemoryItemByCanonicalKey(db, dedupKey);
  return row ? row.id : null;
}

function upsertRelationsForItem(db, fromItemId, item, source) {
  db.prepare('DELETE FROM relations WHERE from_item_id = ?').run(fromItemId);
  const hints = item.relationHints || [];
  if (!hints.length) return;

  for (const hint of hints) {
    const toItemId = ensureRelationTarget(db, hint, source);
    if (!toItemId || toItemId === fromItemId) continue;

    db.prepare(`
      INSERT INTO relations(from_item_id, to_item_id, relation_type, weight, evidence_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_item_id, to_item_id, relation_type)
      DO UPDATE SET
        weight = excluded.weight,
        evidence_ref = excluded.evidence_ref,
        created_at = excluded.created_at
    `).run(
      fromItemId,
      toItemId,
      hint.relationType || 'related_to',
      Number(hint.weight || 1),
      hint.evidenceRef || '',
      nowIso(),
    );
  }
}

function pruneStaleSourceItems(db, sourceRecordId, dedupKeys) {
  const keys = Array.from(dedupKeys || []);
  if (!keys.length) {
    db.prepare('DELETE FROM memory_items WHERE source_record_id = ?').run(sourceRecordId);
    return;
  }

  const placeholders = keys.map(() => '?').join(',');
  db.prepare(`
    DELETE FROM memory_items
    WHERE source_record_id = ?
      AND dedup_key NOT IN (${placeholders})
  `).run(sourceRecordId, ...keys);
}

function resolveDistillOptions(config, source) {
  const quality = (config && config.quality && config.quality.distill)
    ? config.quality.distill
    : {};
  const baseWhitelist = Array.isArray(quality.typeWhitelist) && quality.typeWhitelist.length
    ? quality.typeWhitelist
    : ['Decision', 'Task', 'Insight', 'Area'];
  const rawMinConfidence = Number(quality.minConfidence);
  const baseMinConfidence = Number.isFinite(rawMinConfidence)
    ? Math.max(0, Math.min(1, rawMinConfidence))
    : 0.72;
  const sourceType = String((source && source.sourceType) || '').toLowerCase();
  const transcriptSource = sourceType === 'clawdbot' || sourceType === 'session';
  return {
    typeWhitelist: baseWhitelist,
    minConfidence: transcriptSource ? Math.max(baseMinConfidence, 0.74) : baseMinConfidence,
  };
}

function processSource(db, config, source, options = {}) {
  const notionMode = Boolean(options.notionMode);
  const notionWriteRuntime = options.notionWriteRuntime || null;
  const notionWriteRuntimeError = options.notionWriteRuntimeError || null;
  upsertProjectRecord(db, source.projectId);

  const src = upsertSourceRecord(db, source);
  if (!src.changed) {
    return {
      sourcePath: source.sourcePath,
      changed: false,
      createdItems: 0,
      updatedItems: 0,
      chunkCount: 0,
      enrichmentStats: createEnrichmentStats(),
      notionWrite: createNotionWriteThroughStats(),
    };
  }

  const chunks = chunkText(source.content, config.sync.maxChunkChars || 1800);
  const chunkRows = replaceChunks(db, src.id, chunks);
  const seenDedupKeys = new Set();
  const distillOptions = resolveDistillOptions(config, source);
  const enrichmentStats = createEnrichmentStats();
  const notionWrite = createNotionWriteThroughStats();

  let createdItems = 0;
  let updatedItems = 0;

  for (const chunk of chunkRows) {
    const items = distillChunk({ source, chunk, options: distillOptions });
    for (const item of items) {
      const enriched = enrichMemoryItemSync({ item, source, config });
      mergeEnrichmentStats(enrichmentStats, enriched.stats);
      const enrichedItem = enriched.item;
      seenDedupKeys.add(enrichedItem.dedupKey);
      const up = upsertMemoryItem(db, enrichedItem, src.id, chunk.id);
      upsertEvidence(db, up.id, enrichedItem.evidence);
      upsertRelationsForItem(db, up.id, enrichedItem, source);
      if (up.created) createdItems += 1;
      else updatedItems += 1;

      if (notionMode) {
        const targetState = enrichedItem.state || source.defaultState || 'candidate';
        const through = attemptNotionWriteThrough(db, {
          config,
          runtime: notionWriteRuntime,
          runtimeError: notionWriteRuntimeError,
          memoryItemId: up.id,
          targetState,
          eventType: 'sync_write_through',
          payloadBase: {
            sourcePath: source.sourcePath,
            sourceType: source.sourceType,
            targetState,
          },
        });
        notionWrite.attempted += 1;
        if (through.ok) {
          notionWrite.succeeded += 1;
        } else {
          notionWrite.failed += 1;
          if (through.enqueued) notionWrite.outboxEnqueued += 1;
          notionWrite.errors.push({
            itemId: up.id,
            sourcePath: source.sourcePath,
            phase: 'write_through',
            error: through.error || 'unknown write-through error',
          });
        }
      }
    }
  }

  pruneStaleSourceItems(db, src.id, seenDedupKeys);

  return {
    sourcePath: source.sourcePath,
    changed: true,
    createdItems,
    updatedItems,
    chunkCount: chunkRows.length,
    enrichmentStats,
    notionWrite,
  };
}

function fetchNotionConfiguredSources(config, { fullBackfill = false } = {}) {
  const { client, settings, validation } = buildNotionClient(config, { requireDocSources: true });
  const fetched = fetchNotionDocSourcesSync({
    client,
    docDataSourceIds: settings.docDataSourceIds,
    cursor: fullBackfill ? null : settings.cursor,
  });
  return {
    ...fetched,
    fullBackfill: Boolean(fullBackfill),
    cursorUsed: fullBackfill ? null : settings.cursor,
    settings,
    validation,
  };
}

function runSync({
  cwd = process.cwd(),
  explicitSources = null,
  includeConfiguredSources = true,
  fullBackfill = false,
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const notionMode = isNotionMode(config);

  const sources = [];
  let notionFetch = null;
  const preErrors = [];
  let notionWriteRuntime = null;
  let notionWriteRuntimeError = null;

  if (includeConfiguredSources) {
    if (notionMode) {
      try {
        notionFetch = fetchNotionConfiguredSources(config, { fullBackfill });
        sources.push(...notionFetch.sources);
      } catch (err) {
        preErrors.push({ sourcePath: 'notion:docs', error: err.message });
      }
    } else {
      sources.push(...collectSourceFiles(config, projectRoot));
    }
  }
  if (explicitSources && explicitSources.length) {
    sources.push(...explicitSources);
  }
  if (notionMode) {
    try {
      notionWriteRuntime = buildNotionWriteRuntime(config);
    } catch (err) {
      notionWriteRuntimeError = err.message;
      preErrors.push({
        sourcePath: 'notion:write_through',
        phase: 'runtime_init',
        error: err.message,
      });
    }
  }

  return withDb(dbPath, (db) => {
    const syncRunId = createSyncRun(db);
    const errors = [...preErrors];
    let createdItems = 0;
    let updatedItems = 0;
    let processedSources = 0;
    const enrichmentStats = createEnrichmentStats();
    const notionWrite = createNotionWriteThroughStats();

    for (const source of sources) {
      try {
        const result = processSource(db, config, source, {
          notionMode,
          notionWriteRuntime,
          notionWriteRuntimeError,
        });
        processedSources += 1;
        createdItems += result.createdItems;
        updatedItems += result.updatedItems;
        mergeEnrichmentStats(enrichmentStats, result.enrichmentStats);
        mergeNotionWriteThroughStats(notionWrite, result.notionWrite);
        if (result.notionWrite && Array.isArray(result.notionWrite.errors) && result.notionWrite.errors.length) {
          errors.push(...result.notionWrite.errors);
        }
      } catch (err) {
        errors.push({ sourcePath: source.sourcePath, error: err.message });
      }
    }

    if (notionMode) {
      const flushed = flushNotionOutbox(db, {
        config,
        runtime: notionWriteRuntime,
        runtimeError: notionWriteRuntimeError,
        limit: 100,
      });
      notionWrite.outboxFlushed += Number(flushed.outboxFlushed || 0);
      notionWrite.outboxFlushFailed += Number(flushed.outboxFlushFailed || 0);
      notionWrite.outboxPending = Number(flushed.outboxPending || 0);
      if (Array.isArray(flushed.errors) && flushed.errors.length) {
        notionWrite.errors.push(...flushed.errors);
        errors.push(...flushed.errors);
      }
    }

    const projection = notionMode
      ? { skipped: true, reason: 'storage_mode_notion' }
      : renderProjection(db, config, projectRoot);

    const status = errors.length ? 'partial' : 'success';
    if (notionMode) {
      const priorCursor = fullBackfill
        ? null
        : (((config.storage || {}).notion || {}).cursor || null);
      const cursor = notionFetch && notionFetch.newCursor
        ? notionFetch.newCursor
        : priorCursor;
      setNotionSyncState(db, 'doc_cursor', cursor || '');
      setNotionSyncState(db, 'last_run_status', status);
      setNotionSyncState(db, 'last_run_at', nowIso());
      setNotionSyncState(db, 'last_run_mode', fullBackfill ? 'full_backfill' : 'incremental');
      if (notionFetch && (fullBackfill || notionFetch.newCursor)) {
        const nextConfig = loadConfig(projectRoot);
        nextConfig.storage = nextConfig.storage || { mode: 'notion', notion: {} };
        nextConfig.storage.notion = nextConfig.storage.notion || {};
        nextConfig.storage.notion.cursor = cursor || null;
        saveConfig(projectRoot, nextConfig, {
          configPath: nextConfig.__meta && nextConfig.__meta.configPath ? nextConfig.__meta.configPath : getPreferredConfigPath(projectRoot),
        });
      }
    }

    finishSyncRun(db, syncRunId, {
      status,
      processedSources,
      createdItems,
      updatedItems,
      errors,
    });

    return {
      syncRunId,
      status,
      processedSources,
      createdItems,
      updatedItems,
      errors,
      enrichmentStats,
      projection,
      notion: notionMode
        ? {
          importedCount: notionFetch ? notionFetch.importedCount : 0,
          cursor: notionFetch ? notionFetch.newCursor : (((config.storage || {}).notion || {}).cursor || null),
          fullBackfill: Boolean(fullBackfill),
          writeThrough: notionWrite,
        }
        : null,
    };
  });
}

function retrieveMemory({
  cwd = process.cwd(),
  query,
  projectId = null,
  types = [],
  tokenBudget = 1200,
  includeCandidate = true,
  scopePolicy = 'layered',
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  return withDb(dbPath, (db) => retrieveRanked(db, {
    query,
    projectId,
    types,
    tokenBudget,
    includeCandidate,
    scopePolicy,
  }));
}

function composeMemory({
  cwd = process.cwd(),
  query,
  projectId = null,
  types = [],
  tokenBudget = 1200,
  includeCandidate = true,
  scopePolicy = 'layered',
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  return withDb(dbPath, (db) => composeContext(db, {
    query,
    projectId,
    types,
    tokenBudget,
    includeCandidate,
    scopePolicy,
  }));
}

function queryMemory({ cwd = process.cwd(), query, scope = [], tokenBudget = 1200, projectId = null } = {}) {
  const composed = composeMemory({
    cwd,
    query,
    types: scope,
    tokenBudget,
    projectId,
    includeCandidate: true,
    scopePolicy: 'layered',
  });

  return {
    query,
    tokenBudget: Number(tokenBudget) || 1200,
    usedItems: composed.retrieval.usedItems,
    context: composed.retrieval.candidates,
    contextText: composed.contextText,
    sections: composed.sections,
    citations: composed.citations,
  };
}

function writeMemory({ cwd = process.cwd(), projectId = null, items = [], statusHint = 'candidate' } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const notionMode = isNotionMode(config);

  if (!Array.isArray(items) || !items.length) {
    return { created: 0, updated: 0, rejected: 0, failed: 0, errors: [], enrichmentStats: createEnrichmentStats() };
  }

  return withDb(dbPath, (db) => {
    let created = 0;
    let updated = 0;
    let rejected = 0;
    let failed = 0;
    const errors = [];
    const enrichmentStats = createEnrichmentStats();
    let notionWriteRuntime = null;
    let notionWriteRuntimeError = null;

    if (notionMode) {
      try {
        notionWriteRuntime = buildNotionWriteRuntime(config);
      } catch (err) {
        notionWriteRuntimeError = err.message;
      }
    }

    for (const raw of items) {
      if (!raw || !raw.type || !raw.body) {
        rejected += 1;
        continue;
      }

      const title = raw.title || `${raw.type}: ${String(raw.body).slice(0, 80)}`;
      const canonicalText = `${raw.type}|${String(raw.body).toLowerCase().replace(/\s+/g, ' ').trim()}`;
      const dedupKey = sha256(canonicalText);

      const item = {
        type: raw.type,
        title,
        body: String(raw.body),
        confidence: Number(raw.confidence || 0.7),
        state: notionMode ? 'pending_remote' : (raw.state || statusHint || 'candidate'),
        importance: Number(raw.importance || 0.6),
        freshnessTs: Date.now(),
        dedupKey,
        canonicalKey: dedupKey,
        scopeLevel: raw.scopeLevel || 'project',
        projectId: raw.projectId || projectId || null,
        sourceAuthority: Number(raw.sourceAuthority || 0.85),
        evidence: {
          sourceType: 'manual',
          sourcePath: raw.sourcePath || 'api:memory_write',
          lineStart: raw.lineStart || null,
          lineEnd: raw.lineEnd || null,
          snippet: String(raw.body).slice(0, 320),
          role: raw.role || 'assistant',
        },
        relationHints: Array.isArray(raw.relationHints) ? raw.relationHints : [],
      };
      const enriched = enrichMemoryItemSync({
        item,
        source: { sourcePath: item.evidence.sourcePath, sourceType: item.evidence.sourceType },
        config,
      });
      mergeEnrichmentStats(enrichmentStats, enriched.stats);
      const enrichedItem = enriched.item;

      upsertProjectRecord(db, enrichedItem.projectId);
      const up = upsertMemoryItem(db, enrichedItem, null, null);
      upsertEvidence(db, up.id, enrichedItem.evidence);
      upsertRelationsForItem(db, up.id, enrichedItem, enrichedItem);
      if (!notionMode) {
        if (up.created) created += 1;
        else updated += 1;
        continue;
      }

      const targetState = raw.state || statusHint || 'candidate';
      const through = attemptNotionWriteThrough(db, {
        config,
        runtime: notionWriteRuntime,
        runtimeError: notionWriteRuntimeError,
        memoryItemId: up.id,
        targetState,
        eventType: 'memory_write',
        payloadBase: {
          raw,
          projectId: enrichedItem.projectId,
          sourcePath: item.evidence.sourcePath,
          targetState,
        },
      });
      if (through.ok) {
        if (up.created) created += 1;
        else updated += 1;
      } else {
        failed += 1;
        errors.push({
          itemId: up.id,
          sourcePath: item.evidence.sourcePath,
          phase: 'write_through',
          error: through.error || 'unknown write-through error',
        });
      }
    }

    return {
      created,
      updated,
      rejected,
      failed,
      ok: failed === 0,
      errors,
      enrichmentStats,
    };
  });
}

function reviewPromote({ cwd = process.cwd(), itemIds = [], reason = '' } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  if (!itemIds.length) return { promotedCount: 0 };

  return withDb(dbPath, (db) => {
    const placeholders = itemIds.map(() => '?').join(',');
    const result = db.prepare(`
      UPDATE memory_items
      SET state = 'verified', status = 'verified', review_reason = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `).run(reason || 'manual promote', nowIso(), ...itemIds);

    return { promotedCount: Number(result.changes || 0) };
  });
}

function reviewArchive({ cwd = process.cwd(), itemIds = [], reason = '' } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  if (!itemIds.length) return { archivedCount: 0 };

  return withDb(dbPath, (db) => {
    const placeholders = itemIds.map(() => '?').join(',');
    const result = db.prepare(`
      UPDATE memory_items
      SET state = 'archived', status = 'archived', review_reason = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `).run(reason || 'manual archive', nowIso(), ...itemIds);

    return { archivedCount: Number(result.changes || 0) };
  });
}

function buildMemoryPack({ cwd = process.cwd(), projectId = 'main', packType = 'startup' } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  return withDb(dbPath, (db) => {
    const composed = composeContext(db, {
      query: 'decision task constraint risk open question',
      projectId,
      tokenBudget: 1400,
      includeCandidate: true,
      scopePolicy: 'layered',
    });

    const packKey = `project:${projectId}:${packType}`;
    const contentJson = JSON.stringify({
      projectId,
      packType,
      contextText: composed.contextText,
      sections: composed.sections,
      citations: composed.citations,
    });

    db.prepare(`
      INSERT INTO memory_packs(pack_key, project_id, content_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pack_key)
      DO UPDATE SET
        project_id = excluded.project_id,
        content_json = excluded.content_json,
        updated_at = excluded.updated_at
    `).run(packKey, projectId, contentJson, nowIso());

    return {
      packKey,
      projectId,
      packType,
      itemCount: composed.retrieval.usedItems,
      updatedAt: nowIso(),
    };
  });
}

function buildStartupContext({ cwd = process.cwd(), tokenBudget = 600, projectId = null } = {}) {
  const composed = composeMemory({
    cwd,
    query: 'decision OR task OR insight OR area',
    projectId,
    types: ['Decision', 'Task', 'Insight', 'Area'],
    tokenBudget,
    includeCandidate: false,
    scopePolicy: 'layered',
  });

  return {
    text: composed.contextText || '# MEMORY CONTEXT\n\nNo memory context available yet.',
    items: composed.retrieval.candidates,
    citations: composed.citations,
  };
}

function sanitizeSessionMessageText(text) {
  const out = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
  return out;
}

function normalizeMessageRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'assistant' || value === 'ai') return 'assistant';
  if (value === 'user') return 'user';
  return null;
}

function normalizeMessageContent(message) {
  if (typeof message === 'string') return sanitizeSessionMessageText(message);
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return sanitizeSessionMessageText(message.text);
  if (typeof message.content === 'string') return sanitizeSessionMessageText(message.content);
  if (Array.isArray(message.content)) {
    const merged = message.content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return sanitizeSessionMessageText(merged);
  }
  return '';
}

function normalizeSessionMessages(rawMessages, fallbackRole = null) {
  if (!Array.isArray(rawMessages)) return [];
  const out = [];

  for (let i = 0; i < rawMessages.length; i += 1) {
    const raw = rawMessages[i];
    const role = normalizeMessageRole(
      (raw && raw.role) || (raw && raw.message && raw.message.role) || fallbackRole,
    );
    const text = normalizeMessageContent(raw && raw.message ? raw.message : raw);
    if (!role || !text) continue;

    out.push({
      role,
      text,
      messageId: (raw && (raw.messageId || raw.id || raw.message_id)) || `m-${i + 1}`,
      timestamp: (raw && (raw.timestamp || raw.createdAt || raw.time)) || nowIso(),
    });
  }

  return out;
}

function sessionLogsDir(projectRoot) {
  const dir = path.join(projectRoot, 'hippocore', 'system', 'logs', 'sessions');
  ensureDir(dir);
  return dir;
}

function sessionLogPath(projectRoot, sessionKey) {
  const safeSession = String(sessionKey || 'unknown-session')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'unknown-session';
  return path.join(sessionLogsDir(projectRoot), `${safeSession}.jsonl`);
}

function appendSessionMessage({
  projectRoot,
  sessionKey,
  messageId,
  role,
  text,
  projectId = null,
  timestamp = null,
}) {
  const normalizedRole = normalizeMessageRole(role);
  const normalizedText = sanitizeSessionMessageText(text);
  if (!normalizedRole || !normalizedText) return null;

  const logPath = sessionLogPath(projectRoot, sessionKey);
  const entry = {
    sessionKey,
    messageId: messageId || `m-${Date.now()}`,
    role: normalizedRole,
    text: normalizedText,
    projectId: projectId || null,
    timestamp: timestamp || nowIso(),
  };
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function readSessionMessages(projectRoot, sessionKey) {
  const logPath = sessionLogPath(projectRoot, sessionKey);
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  const messages = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const role = normalizeMessageRole(parsed.role);
      const text = sanitizeSessionMessageText(parsed.text);
      if (!role || !text) continue;
      messages.push({
        role,
        text,
        messageId: parsed.messageId || `m-${messages.length + 1}`,
        timestamp: parsed.timestamp || nowIso(),
      });
    } catch {
      // Ignore malformed lines in session logs.
    }
  }

  return messages;
}

function dedupeSessionMessages(messages) {
  const seen = new Set();
  const out = [];

  for (const message of messages || []) {
    const key = [
      message.role || '',
      message.messageId || '',
      String(message.text || '').replace(/\s+/g, ' ').trim(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

function overwriteSessionMessages(projectRoot, sessionKey, messages, projectId = null) {
  const logPath = sessionLogPath(projectRoot, sessionKey);
  const lines = dedupeSessionMessages(messages).map((message) => JSON.stringify({
    sessionKey,
    messageId: message.messageId || `m-${Date.now()}`,
    role: message.role,
    text: message.text,
    projectId: projectId || null,
    timestamp: message.timestamp || nowIso(),
  }));
  fs.writeFileSync(logPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

function buildSessionEndSource({ sessionKey, projectId = null, messages = [] }) {
  const userMessages = messages.filter((m) => m.role === 'user');
  const assistantMessages = messages.filter((m) => m.role === 'assistant');

  const userLines = userMessages.map((m) => `USER: ${m.text}`);
  const assistantLines = assistantMessages.map((m) => `AI_SUPPLEMENT: ${m.text}`);

  const content = [
    `# Session ${sessionKey}`,
    `session_key: ${sessionKey}`,
    `project_id: ${projectId || 'none'}`,
    `user_message_count: ${userMessages.length}`,
    `assistant_message_count: ${assistantMessages.length}`,
    '',
    '## User Messages (primary memory source)',
    ...(userLines.length ? userLines : ['USER: (none)']),
    '',
    '## Assistant Supplemental Context (do not treat as user memory)',
    ...(assistantLines.length ? assistantLines : ['AI_SUPPLEMENT: (none)']),
    '',
  ].join('\n');

  return {
    sourceType: 'session',
    sourcePath: `session_end:${sessionKey}:${Date.now()}`,
    mtimeMs: Date.now(),
    content,
    contentHash: sha256(content),
    scopeLevel: projectId ? 'project' : 'temp',
    projectId: projectId || null,
    sourceAuthority: 0.8,
    defaultState: 'candidate',
    metadata: {
      sessionKey,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      sessionDistillPolicy: 'user_primary_ai_supplement',
    },
  };
}

function enqueueJob(db, { eventType, sessionKey, messageId, payload }) {
  db.prepare(`
    INSERT OR IGNORE INTO memory_jobs(event_type, session_key, message_id, payload_json, created_at, status)
    VALUES (?, ?, ?, ?, ?, 'queued')
  `).run(eventType, sessionKey, messageId, JSON.stringify(payload || {}), nowIso());

  return db.prepare(`
    SELECT id, status
    FROM memory_jobs
    WHERE event_type = ? AND session_key = ? AND message_id = ?
  `).get(eventType, sessionKey, messageId);
}

function markJob(db, jobId, status, error = null) {
  const startedAt = status === 'running' ? nowIso() : null;
  const finishedAt = status === 'done' || status === 'failed' ? nowIso() : null;

  db.prepare(`
    UPDATE memory_jobs
    SET
      status = ?,
      started_at = COALESCE(?, started_at),
      finished_at = COALESCE(?, finished_at),
      error = COALESCE(?, error)
    WHERE id = ?
  `).run(status, startedAt, finishedAt, error, jobId);
}

function triggerSessionStart({ cwd = process.cwd(), sessionKey = 'unknown-session', tokenBudget = 600, projectId = null } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const notionOnboarding = getNotionOnboardingStatus(config);
  const notionBlocking = Boolean(notionOnboarding && notionOnboarding.blocking);

  let syncSummary = null;
  if (notionBlocking) {
    syncSummary = {
      status: 'blocked_notion_required',
      storageMode: 'notion',
    };
  } else if (isNotionMode(config)) {
    syncSummary = {
      status: 'background_notion_sync_started',
      storageMode: 'notion',
    };
    setTimeout(() => {
      try {
        runSync({ cwd: projectRoot });
      } catch {
        // Non-fatal background sync failure for session start path.
      }
    }, 0);
  } else {
    syncSummary = runSync({ cwd: projectRoot });
  }
  const jobInfo = withDb(dbPath, (db) => {
    const job = enqueueJob(db, {
      eventType: 'session_start',
      sessionKey,
      messageId: 'session-start',
      payload: { tokenBudget, projectId },
    });
    if (!job) return { jobId: null };
    markJob(db, job.id, 'running');
    return { jobId: job.id };
  });

  const context = buildStartupContext({ cwd: projectRoot, tokenBudget, projectId });
  const mirrorOnboarding = getMirrorOnboardingStatus({ config });
  if (notionBlocking) {
    context.text = buildNotionBlockingContext(notionOnboarding);
  } else if (mirrorOnboarding.blocking) {
    context.text = `${buildMirrorBlockingContext(mirrorOnboarding)}\n${context.text}`;
  }

  if (jobInfo.jobId) {
    withDb(dbPath, (db) => {
      markJob(db, jobInfo.jobId, 'done');
    });
  }

  return {
    ok: true,
    event: 'session_start',
    sessionKey,
    projectId,
    syncSummary,
    context,
    notionOnboarding,
    mirrorOnboarding,
  };
}

function triggerUserPromptSubmit({ cwd = process.cwd(), sessionKey, messageId, text, projectId = null } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  appendSessionMessage({
    projectRoot,
    sessionKey,
    messageId,
    role: 'user',
    text,
    projectId,
  });

  const promptSource = makePromptSource({ sessionKey, messageId, text, projectId });
  const jobInfo = withDb(dbPath, (db) => {
    const job = enqueueJob(db, {
      eventType: 'user_prompt_submit',
      sessionKey,
      messageId,
      payload: { size: text.length, projectId },
    });

    if (!job || job.status === 'done') {
      return { deduped: true, jobId: null };
    }

    markJob(db, job.id, 'running');
    return { deduped: false, jobId: job.id };
  });

  if (jobInfo.deduped) {
    return {
      event: 'user_prompt_submit',
      sessionKey,
      messageId,
      projectId,
      ok: true,
      deduped: true,
      syncSummary: null,
    };
  }

  try {
    const syncSummary = runSync({
      cwd: projectRoot,
      explicitSources: [promptSource],
      includeConfiguredSources: false,
    });

    if (jobInfo.jobId) {
      withDb(dbPath, (db) => {
        markJob(db, jobInfo.jobId, 'done');
      });
    }

    return {
      event: 'user_prompt_submit',
      sessionKey,
      messageId,
      projectId,
      ok: true,
      deduped: false,
      syncSummary,
    };
  } catch (err) {
    if (jobInfo.jobId) {
      withDb(dbPath, (db) => {
        markJob(db, jobInfo.jobId, 'failed', err.message);
      });
    }
    throw err;
  }
}

function triggerAssistantMessage({ cwd = process.cwd(), sessionKey, messageId, text, projectId = null } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  const normalizedText = sanitizeSessionMessageText(text);
  if (!normalizedText) {
    return {
      event: 'assistant_message',
      sessionKey,
      messageId,
      projectId,
      ok: true,
      skipped: true,
      reason: 'empty_text',
    };
  }

  const jobInfo = withDb(dbPath, (db) => {
    const job = enqueueJob(db, {
      eventType: 'assistant_message',
      sessionKey,
      messageId,
      payload: { size: normalizedText.length, projectId },
    });

    if (!job || job.status === 'done') {
      return { deduped: true, jobId: null };
    }

    markJob(db, job.id, 'running');
    return { deduped: false, jobId: job.id };
  });

  if (jobInfo.deduped) {
    return {
      event: 'assistant_message',
      sessionKey,
      messageId,
      projectId,
      ok: true,
      deduped: true,
      logged: false,
    };
  }

  appendSessionMessage({
    projectRoot,
    sessionKey,
    messageId,
    role: 'assistant',
    text: normalizedText,
    projectId,
  });

  if (jobInfo.jobId) {
    withDb(dbPath, (db) => {
      markJob(db, jobInfo.jobId, 'done');
    });
  }

  return {
    event: 'assistant_message',
    sessionKey,
    messageId,
    projectId,
    ok: true,
    deduped: false,
    logged: true,
  };
}

function triggerSessionEnd({
  cwd = process.cwd(),
  sessionKey = 'unknown-session',
  projectId = null,
  messages = null,
} = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  const normalizedInputMessages = normalizeSessionMessages(messages);
  if (normalizedInputMessages.length > 0) {
    overwriteSessionMessages(projectRoot, sessionKey, normalizedInputMessages, projectId);
  }

  const sessionMessages = dedupeSessionMessages(
    normalizedInputMessages.length > 0
      ? normalizedInputMessages
      : readSessionMessages(projectRoot, sessionKey),
  );

  const userCount = sessionMessages.filter((m) => m.role === 'user').length;
  const assistantCount = sessionMessages.filter((m) => m.role === 'assistant').length;
  const sessionDigest = sha256(JSON.stringify(sessionMessages.map((m) => ({
    role: m.role,
    messageId: m.messageId || '',
    text: m.text,
  }))));
  const sessionMessageId = `session-end:${sessionDigest.slice(0, 16)}`;

  if (userCount === 0) {
    return {
      event: 'session_end',
      sessionKey,
      messageId: sessionMessageId,
      projectId,
      ok: true,
      skipped: true,
      reason: 'no_user_messages',
      messageCounts: { total: sessionMessages.length, user: userCount, assistant: assistantCount },
      syncSummary: null,
    };
  }

  const sessionSource = buildSessionEndSource({
    sessionKey,
    projectId,
    messages: sessionMessages,
  });

  const jobInfo = withDb(dbPath, (db) => {
    const job = enqueueJob(db, {
      eventType: 'session_end',
      sessionKey,
      messageId: sessionMessageId,
      payload: {
        messageCount: sessionMessages.length,
        userCount,
        assistantCount,
        projectId,
      },
    });

    if (!job || job.status === 'done') {
      return { deduped: true, jobId: null };
    }

    markJob(db, job.id, 'running');
    return { deduped: false, jobId: job.id };
  });

  if (jobInfo.deduped) {
    return {
      event: 'session_end',
      sessionKey,
      messageId: sessionMessageId,
      projectId,
      ok: true,
      deduped: true,
      messageCounts: { total: sessionMessages.length, user: userCount, assistant: assistantCount },
      syncSummary: null,
    };
  }

  try {
    const syncSummary = runSync({
      cwd: projectRoot,
      explicitSources: [sessionSource],
      includeConfiguredSources: false,
    });

    if (jobInfo.jobId) {
      withDb(dbPath, (db) => {
        markJob(db, jobInfo.jobId, 'done');
      });
    }

    return {
      event: 'session_end',
      sessionKey,
      messageId: sessionMessageId,
      projectId,
      ok: true,
      deduped: false,
      messageCounts: { total: sessionMessages.length, user: userCount, assistant: assistantCount },
      syncSummary,
      distillPolicy: 'user_primary_ai_supplement',
    };
  } catch (err) {
    if (jobInfo.jobId) {
      withDb(dbPath, (db) => {
        markJob(db, jobInfo.jobId, 'failed', err.message);
      });
    }
    throw err;
  }
}

function runDoctor({ cwd = process.cwd() } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const preferredConfigPath = getPreferredConfigPath(projectRoot);
  const configExists = fs.existsSync(preferredConfigPath);

  const checks = [];
  checks.push({
    name: 'config_exists',
    ok: configExists,
    detail: configExists ? preferredConfigPath : 'hippocore config not found',
  });

  const config = loadConfig(projectRoot);
  const storageMode = resolveStorageMode(config);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const dbExists = fs.existsSync(dbPath);

  checks.push({ name: 'db_exists', ok: dbExists, detail: dbPath });

  let canOpenDb = false;
  try {
    withDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS count FROM memory_items').get());
    canOpenDb = true;
  } catch {
    canOpenDb = false;
  }

  checks.push({ name: 'db_access', ok: canOpenDb, detail: canOpenDb ? 'OK' : 'Cannot open db' });

  const requiredDirs = [
    config.paths.workspaceRoot,
    config.paths.globalDir,
    config.paths.projectsDir,
    config.paths.importsObsidian,
    config.paths.importsChats,
    path.dirname(config.paths.db),
    config.paths.projectionDir,
  ];

  for (const rel of requiredDirs) {
    const abs = resolveConfiguredPath(projectRoot, rel);
    checks.push({
      name: `dir:${rel}`,
      ok: fs.existsSync(abs),
      detail: abs,
    });
  }

  const obsidianOk = !config.paths.obsidianVault || fs.existsSync(config.paths.obsidianVault);
  const clawdbotOk = !config.paths.clawdbotTranscripts || fs.existsSync(config.paths.clawdbotTranscripts);

  checks.push({ name: 'obsidian_path', ok: obsidianOk, detail: config.paths.obsidianVault || 'not configured' });
  checks.push({ name: 'clawdbot_path', ok: clawdbotOk, detail: config.paths.clawdbotTranscripts || 'not configured' });

  const enrichmentCfg = normalizeEnrichmentSettings(config);
  const llmNeeded = Boolean(
    enrichmentCfg.enabled
    && enrichmentCfg.strategy === 'hybrid_rule_llm_full'
    && enrichmentCfg.llm.provider === 'openai_compatible',
  );
  const llmTokenEnv = String((enrichmentCfg.llm && enrichmentCfg.llm.apiKeyEnv) || 'OPENAI_API_KEY');
  const llmTokenPresent = Boolean(process.env[llmTokenEnv]);
  checks.push({
    name: 'llm_enrichment',
    ok: true,
    warning: llmNeeded && !llmTokenPresent,
    detail: llmNeeded
      ? (llmTokenPresent
        ? `enabled(model=${enrichmentCfg.llm.model}, baseUrl=${enrichmentCfg.llm.baseUrl})`
        : `warning: ${llmTokenEnv} not set, fallback to rule-only`)
      : 'disabled_or_non_llm_strategy',
  });

  let mirrorOnboarding = getMirrorOnboardingStatus({ config });
  let notionConnectivity = null;

  if (storageMode === 'notion') {
    mirrorOnboarding = {
      required: false,
      ready: true,
      blocking: false,
      remote: null,
      local: null,
      completedAt: null,
      pullCommand: null,
      completeCommand: null,
    };

    const notionConfigCheck = validateNotionConfig(config, process.env, { requireDocSources: true });
    checks.push({
      name: 'notion_config',
      ok: notionConfigCheck.ok,
      detail: notionConfigCheck.ok
        ? `memory=${notionConfigCheck.settings.memoryDataSourceId || 'unset'}; docSources=${notionConfigCheck.settings.docSourcesCount || 0}`
        : notionConfigCheck.errors.join('; '),
    });

    checks.push({
      name: 'notion_doc_sources',
      ok: notionConfigCheck.settings.docSourcesReady,
      detail: notionConfigCheck.settings.docSourcesReady
        ? `${notionConfigCheck.settings.docSourcesCount} configured`
        : 'storage.notion.docDataSourceIds is required',
    });

    notionConnectivity = getNotionConnectivity(config, { requireDocSources: true });
    checks.push({
      name: 'notion_connectivity',
      ok: notionConnectivity.ok,
      detail: notionConnectivity.ok
        ? `${notionConnectivity.user || 'connected'}; docSourcesValidated=${notionConnectivity.docSourcesValidated ? 'yes' : 'no'}`
        : ((notionConnectivity.errors || []).join('; ') || 'not connected'),
    });
    checks.push({
      name: 'notion_schema_compatibility',
      ok: notionConnectivity.schema ? notionConnectivity.schema.ok : false,
      detail: notionConnectivity.schema
        ? (notionConnectivity.schema.ok
          ? 'memory/doc schema compatible'
          : (notionConnectivity.schema.errors || []).join('; '))
        : 'schema not checked',
    });
  } else {
    checks.push({
      name: 'mirror_onboarding',
      ok: mirrorOnboarding.ready,
      detail: mirrorOnboarding.ready
        ? (mirrorOnboarding.completedAt || (mirrorOnboarding.required ? 'completed' : 'optional'))
        : `pending: ${mirrorOnboarding.pullCommand}`,
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, projectRoot, checks, config, mirrorOnboarding, notionConnectivity };
}

function createBackup({ cwd = process.cwd(), targetDir = null } = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const configPath = config.__meta && config.__meta.configPath
    ? config.__meta.configPath
    : getPreferredConfigPath(projectRoot);

  const root = targetDir || path.join(projectRoot, 'hippocore', 'system', 'backups');
  ensureDir(root);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, `backup-${stamp}`);
  ensureDir(backupDir);

  const dbTarget = path.join(backupDir, 'hippocore.db');
  const configTarget = path.join(backupDir, 'hippocore.config.json');

  fs.copyFileSync(dbPath, dbTarget);
  fs.copyFileSync(configPath, configTarget);

  return { backupDir, files: [dbTarget, configTarget] };
}

function restoreBackup({ cwd = process.cwd(), backupDir } = {}) {
  const projectRoot = resolveProjectRoot(cwd);

  const backupConfigPath = path.join(backupDir, 'hippocore.config.json');
  const backupDbPath = path.join(backupDir, 'hippocore.db');

  if (!fs.existsSync(backupConfigPath) || !fs.existsSync(backupDbPath)) {
    throw new Error(`Invalid backup directory: ${backupDir}`);
  }

  const targetConfigPath = getPreferredConfigPath(projectRoot);
  ensureDir(path.dirname(targetConfigPath));
  fs.copyFileSync(backupConfigPath, targetConfigPath);

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  ensureDir(path.dirname(dbPath));
  fs.copyFileSync(backupDbPath, dbPath);

  return { backupDir, restored: [targetConfigPath, dbPath] };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function startServer({ cwd = process.cwd(), host = '127.0.0.1', port = 31337 } = {}) {
  const projectRoot = resolveProjectRoot(cwd);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true, now: nowIso() });
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/context') {
        const body = await parseJsonBody(req);
        const result = composeMemory({
          cwd: projectRoot,
          query: body.query || '',
          projectId: body.projectId || null,
          types: body.scope || body.types || [],
          tokenBudget: Number(body.tokenBudget || 1200),
          includeCandidate: body.includeCandidate !== false,
          scopePolicy: body.scopePolicy || 'layered',
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/retrieve') {
        const body = await parseJsonBody(req);
        const result = retrieveMemory({
          cwd: projectRoot,
          query: body.query || '',
          projectId: body.projectId || null,
          types: body.types || [],
          tokenBudget: Number(body.tokenBudget || 1200),
          includeCandidate: body.includeCandidate !== false,
          scopePolicy: body.scopePolicy || 'layered',
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/compose') {
        const body = await parseJsonBody(req);
        const result = composeMemory({
          cwd: projectRoot,
          query: body.query || '',
          projectId: body.projectId || null,
          types: body.types || [],
          tokenBudget: Number(body.tokenBudget || 1200),
          includeCandidate: body.includeCandidate !== false,
          scopePolicy: body.scopePolicy || 'layered',
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/write') {
        const body = await parseJsonBody(req);
        const result = writeMemory({
          cwd: projectRoot,
          projectId: body.projectId || null,
          items: body.items || [],
          statusHint: body.statusHint || 'candidate',
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/review/promote') {
        const body = await parseJsonBody(req);
        const result = reviewPromote({
          cwd: projectRoot,
          itemIds: body.itemIds || [],
          reason: body.reason || '',
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/review/archive') {
        const body = await parseJsonBody(req);
        const result = reviewArchive({
          cwd: projectRoot,
          itemIds: body.itemIds || [],
          reason: body.reason || '',
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/sync') {
        const body = await parseJsonBody(req);
        const result = runSync({
          cwd: projectRoot,
          includeConfiguredSources: body.includeConfiguredSources !== false,
          fullBackfill: body.fullBackfill === true,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/memory/pack/build') {
        const body = await parseJsonBody(req);
        const result = buildMemoryPack({
          cwd: projectRoot,
          projectId: body.projectId || 'main',
          packType: body.packType || 'startup',
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  server.listen(port, host);
  return server;
}

module.exports = {
  initProject,
  setupHippocore,
  upgradeHippocore,
  uninstallHippocore,
  connectSource,
  runSync,
  queryMemory,
  retrieveMemory,
  composeMemory,
  writeMemory,
  reviewPromote,
  reviewArchive,
  buildMemoryPack,
  runDoctor,
  createBackup,
  restoreBackup,
  triggerSessionStart,
  triggerUserPromptSubmit,
  triggerAssistantMessage,
  triggerSessionEnd,
  buildStartupContext,
  mirrorHippocore,
  completeMirrorOnboarding,
  getMirrorStatus,
  getNotionStatus,
  syncNotionSources,
  migrateNotionMemory,
  installOpenClawIntegration,
  detectOpenClawHome,
  detectOpenClawSessionsPath,
  detectInstallMode,
  buildMirrorRecommendation,
  stripHippocoreHooks,
  mergeHippocoreHooks,
  startServer,
};
