'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  initProject,
  setupHippocore,
  upgradeHippocore,
  uninstallHippocore,
  runSync,
  retrieveMemory,
  composeMemory,
  writeMemory,
  reviewPromote,
  reviewArchive,
  triggerSessionStart,
  triggerUserPromptSubmit,
  triggerAssistantMessage,
  triggerSessionCheckpoint,
  triggerSessionEnd,
  createBackup,
  restoreBackup,
  mirrorHippocore,
  completeMirrorOnboarding,
  getMirrorStatus,
  getNotionStatus,
  runDoctor,
  migrateNotionMemory,
  startServer,
} = require('../src/service');
const { withDb } = require('../src/db');
const { loadConfig, saveConfig, resolveConfiguredPath } = require('../src/config');
const { NotionClient } = require('../src/notion/client');
const { distillChunk } = require('../src/distill');
const { buildRuleEnrichment } = require('../src/enrichment/rule');
const { OpenAICompatibleLlmClient } = require('../src/enrichment/llm_client');
const { buildMemoryProperties } = require('../src/notion/mapper');
const { detectCheckpointAnchor } = require('../src/checkpoint');

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippocore-'));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeAgentHooks(openclawHome, agentName, hooksPayload) {
  const agentDir = path.join(openclawHome, 'agents', agentName, 'agent');
  const hooksPath = path.join(agentDir, 'hooks.json');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(hooksPayload, null, 2) + '\n', 'utf8');
  return hooksPath;
}

function readHooksJson(hooksPath) {
  return JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
}

function listHookCommands(hooksJson, eventName) {
  return (((hooksJson || {}).hooks || {})[eventName] || [])
    .flatMap((group) => group.hooks || [])
    .map((entry) => String(entry.command || ''));
}

function countHippocoreHookCommands(hooksJson, scriptName) {
  return Object.values(((hooksJson || {}).hooks || {}))
    .flatMap((groups) => groups || [])
    .flatMap((group) => group.hooks || [])
    .filter((entry) => {
      const command = String(entry.command || '');
      return command.includes('HIPPOCORE_PROJECT_ROOT=') && command.includes(scriptName);
    })
    .length;
}

async function withEnv(overrides, fn) {
  const old = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    old[key] = process.env[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(overrides || {})) {
      if (old[key] == null) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

async function withMockLlmClient(handler, fn) {
  const previous = global.__HIPPOCORE_LLM_MOCK__;
  global.__HIPPOCORE_LLM_MOCK__ = handler;
  try {
    return await fn();
  } finally {
    global.__HIPPOCORE_LLM_MOCK__ = previous;
  }
}

function richTextValue(prop) {
  if (!prop || typeof prop !== 'object') return '';
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((x) => x.plain_text || x.text?.content || '').join(' ').trim();
  if (Array.isArray(prop.title)) return prop.title.map((x) => x.plain_text || x.text?.content || '').join(' ').trim();
  return '';
}

function makeProperty(type) {
  return {
    id: `${type}_id`,
    type,
    [type]: {},
  };
}

function defaultMemorySchemaProperties() {
  return {
    Title: makeProperty('title'),
    HippocoreId: makeProperty('rich_text'),
    Type: makeProperty('select'),
    Body: makeProperty('rich_text'),
    State: makeProperty('select'),
    ScopeLevel: makeProperty('select'),
    ProjectId: makeProperty('rich_text'),
    Confidence: makeProperty('number'),
    Importance: makeProperty('number'),
    SourceAuthority: makeProperty('number'),
    FreshnessTs: makeProperty('number'),
    SourcePath: makeProperty('rich_text'),
    LineStart: makeProperty('number'),
    LineEnd: makeProperty('number'),
  };
}

function defaultRelationSchemaProperties() {
  return {
    HippocoreRelationId: makeProperty('rich_text'),
    RelationType: makeProperty('select'),
    From: makeProperty('relation'),
    To: makeProperty('relation'),
    Weight: makeProperty('number'),
    EvidenceRef: makeProperty('rich_text'),
  };
}

function defaultDocSchemaProperties() {
  return {
    Title: makeProperty('title'),
    Body: makeProperty('rich_text'),
  };
}

function inferDefaultSchemaProperties(dataSourceId) {
  const key = String(dataSourceId || '').toLowerCase();
  if (key.includes('relation')) return defaultRelationSchemaProperties();
  if (key.includes('doc')) return defaultDocSchemaProperties();
  return defaultMemorySchemaProperties();
}

function notionIdKey(value) {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

async function withMockNotionApi({
  seedPagesByDataSource = {},
  seedBlocksByParent = {},
  schemaByDataSource = {},
  failCreate = false,
} = {}, fn) {
  const pagesByDataSource = new Map();
  const pagesById = new Map();
  const blocksByParent = new Map();
  const schemas = new Map();
  let nextId = 1;

  const putPage = (dataSourceId, page) => {
    const ds = String(dataSourceId);
    const list = pagesByDataSource.get(ds) || [];
    const normalized = {
      object: 'page',
      id: page.id,
      last_edited_time: page.last_edited_time || new Date().toISOString(),
      properties: page.properties || {},
      url: page.url || `https://www.notion.so/${String(page.id).replace(/-/g, '')}`,
    };
    const idx = list.findIndex((item) => item.id === normalized.id);
    if (idx >= 0) list[idx] = normalized;
    else list.push(normalized);
    pagesByDataSource.set(ds, list);
    pagesById.set(normalized.id, { dataSourceId: ds, page: normalized });
    pagesById.set(notionIdKey(normalized.id), { dataSourceId: ds, page: normalized });
    return normalized;
  };

  for (const [dataSourceId, pages] of Object.entries(seedPagesByDataSource || {})) {
    for (const page of pages || []) {
      putPage(dataSourceId, page);
    }
  }

  for (const [parentId, blocks] of Object.entries(seedBlocksByParent || {})) {
    blocksByParent.set(String(parentId), cloneJson(blocks || []));
  }

  for (const [dataSourceId, schema] of Object.entries(schemaByDataSource || {})) {
    schemas.set(String(dataSourceId), cloneJson(schema || {}));
  }

  const originals = {
    usersMeSync: NotionClient.prototype.usersMeSync,
    queryDataSourceSync: NotionClient.prototype.queryDataSourceSync,
    getDataSourceSync: NotionClient.prototype.getDataSourceSync,
    createPageSync: NotionClient.prototype.createPageSync,
    updatePageSync: NotionClient.prototype.updatePageSync,
    retrieveBlockChildrenSync: NotionClient.prototype.retrieveBlockChildrenSync,
    getPageSync: NotionClient.prototype.getPageSync,
  };

  NotionClient.prototype.usersMeSync = function usersMeSync() {
    return {
      object: 'user',
      id: 'mock-user-id',
      name: 'Mock Notion User',
    };
  };

  NotionClient.prototype.queryDataSourceSync = function queryDataSourceSync(dataSourceId, body = {}) {
    const pages = pagesByDataSource.get(String(dataSourceId)) || [];
    const filter = body && body.filter;

    let results = pages;
    if (
      filter
      && typeof filter.property === 'string'
      && filter.rich_text
      && typeof filter.rich_text.equals === 'string'
    ) {
      const expected = filter.rich_text.equals;
      results = pages.filter((page) => richTextValue((page.properties || {})[filter.property]) === expected);
    }

    return {
      object: 'list',
      results: results.map((page) => cloneJson(page)),
      has_more: false,
      next_cursor: null,
    };
  };

  NotionClient.prototype.getDataSourceSync = function getDataSourceSync(dataSourceId) {
    const dsId = String(dataSourceId);
    const schema = schemas.get(dsId) || {
      object: 'data_source',
      id: dsId,
      properties: inferDefaultSchemaProperties(dsId),
    };
    return cloneJson(schema);
  };

  NotionClient.prototype.createPageSync = function createPageSync({ parentDataSourceId, properties }) {
    if (failCreate) {
      throw new Error('Notion API error: mock_create_failure mock create failure');
    }
    if (!parentDataSourceId) {
      throw new Error('Notion API error: validation_error missing parent.data_source_id');
    }

    const id = `11111111-1111-1111-1111-${String(nextId).padStart(12, '0')}`;
    nextId += 1;
    return cloneJson(putPage(parentDataSourceId, {
      id,
      last_edited_time: new Date().toISOString(),
      properties: properties || {},
    }));
  };

  NotionClient.prototype.updatePageSync = function updatePageSync(pageId, payload = {}) {
    const existing = pagesById.get(pageId) || pagesById.get(notionIdKey(pageId));
    if (!existing) {
      throw new Error('Notion API error: object_not_found page not found');
    }
    const merged = {
      ...existing.page,
      properties: payload.properties || existing.page.properties,
      last_edited_time: new Date().toISOString(),
    };
    return cloneJson(putPage(existing.dataSourceId, merged));
  };

  NotionClient.prototype.getPageSync = function getPageSync(pageId) {
    const existing = pagesById.get(pageId) || pagesById.get(notionIdKey(pageId));
    if (!existing) {
      throw new Error('Notion API error: object_not_found page not found');
    }
    return cloneJson(existing.page);
  };

  NotionClient.prototype.retrieveBlockChildrenSync = function retrieveBlockChildrenSync(blockId) {
    const rows = blocksByParent.get(String(blockId)) || [];
    return {
      object: 'list',
      results: cloneJson(rows),
      has_more: false,
      next_cursor: null,
    };
  };

  try {
    return await fn({
      pagesByDataSource,
      pagesById,
    });
  } finally {
    NotionClient.prototype.usersMeSync = originals.usersMeSync;
    NotionClient.prototype.queryDataSourceSync = originals.queryDataSourceSync;
    NotionClient.prototype.getDataSourceSync = originals.getDataSourceSync;
    NotionClient.prototype.createPageSync = originals.createPageSync;
    NotionClient.prototype.updatePageSync = originals.updatePageSync;
    NotionClient.prototype.retrieveBlockChildrenSync = originals.retrieveBlockChildrenSync;
    NotionClient.prototype.getPageSync = originals.getPageSync;
  }
}

test('init creates hippocore workspace layout', () => {
  const projectRoot = mkTempProject();
  const out = initProject({ cwd: projectRoot });
  const config = loadConfig(projectRoot);

  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/global')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/projects')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/imports/obsidian')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/imports/chats')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/system/config/hippocore.config.json')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/system/db/hippocore.db')), true);
  assert.equal(path.basename(out.configPath), 'hippocore.config.json');
  assert.equal(config.mirror.remote, null);
  assert.equal(config.mirror.local, null);
});

test('sync + retrieve + compose works with layered scope and Area classification', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  write(path.join(projectRoot, 'hippocore/global/platform.md'), [
    '---',
    'memory_scope: global',
    '---',
    '# Platform Constraints',
    'Decision: keep SQLite as canonical store.',
    'Area: reliability engineering and oncall ownership.',
  ].join('\n'));

  write(path.join(projectRoot, 'hippocore/projects/alpha/plan.md'), [
    '---',
    'project_id: alpha',
    '---',
    '# Alpha Sprint',
    'Decision: adopt event-triggered sync for alpha.',
    '- [ ] TODO: add retry logic for sync timeout.',
    'Insight: weekly batch release reduces risk.',
  ].join('\n'));

  write(path.join(projectRoot, 'hippocore/imports/chats/s1.txt'), [
    'Need to investigate timeout errors before release.',
    'Decision: postpone risky migration.',
  ].join('\n'));

  const sync = runSync({ cwd: projectRoot });
  assert.equal(sync.status, 'success');
  assert.ok(sync.createdItems > 0);

  const retrieval = retrieveMemory({
    cwd: projectRoot,
    query: 'retry reliability area decision',
    projectId: 'alpha',
    types: ['Decision', 'Task', 'Area', 'Insight'],
    tokenBudget: 800,
  });

  assert.ok(retrieval.usedItems > 0);
  assert.ok(retrieval.candidates.some((item) => item.type === 'Area'));
  assert.ok(retrieval.candidates.some((item) => item.projectId === 'alpha'));

  const composed = composeMemory({
    cwd: projectRoot,
    query: 'what should we do next for reliability',
    projectId: 'alpha',
    tokenBudget: 900,
  });

  assert.match(composed.contextText, /MEMORY CONTEXT/);
  assert.ok(composed.citations.length > 0);
  assert.ok(composed.sections.decisions.length + composed.sections.tasks.length > 0);
});

test('relation extraction is written and projected into Obsidian views', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  write(path.join(projectRoot, 'hippocore/projects/alpha/relations.md'), [
    '---',
    'project_id: alpha',
    '---',
    'Decision: [[API Gateway]] depends on [[Rate Limit Service]] before rollout.',
  ].join('\n'));

  runSync({ cwd: projectRoot });

  const relationsView = fs.readFileSync(path.join(projectRoot, 'hippocore/system/views/Relations.md'), 'utf8');
  assert.match(relationsView, /depends_on|related_to|Relations/);

  const itemsDir = path.join(projectRoot, 'hippocore/system/views/items');
  const notes = fs.readdirSync(itemsDir).filter((name) => name.endsWith('.md'));
  assert.ok(notes.length > 0);

  const firstNote = fs.readFileSync(path.join(itemsDir, notes[0]), 'utf8');
  assert.match(firstNote, /relations_out:/);
  assert.match(firstNote, /relations_in:/);
});

test('distill applies default type whitelist and confidence threshold', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  write(path.join(projectRoot, 'hippocore/projects/alpha/noise.md'), [
    '---',
    'project_id: alpha',
    '---',
    'Project: schedule v3 roadmap and milestone planning.',
    'Event: timeout error happened during deployment.',
    'Decision: keep rollout gated by tests.',
  ].join('\n'));

  const sync = runSync({ cwd: projectRoot });
  assert.equal(sync.status, 'success');

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const projectTypedRows = withDb(dbPath, (db) => db.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_items m
    JOIN source_records s ON s.id = m.source_record_id
    WHERE s.source_path LIKE '%noise.md'
      AND m.type = 'Project'
  `).get());
  assert.equal(projectTypedRows.c, 0);

  const decision = retrieveMemory({
    cwd: projectRoot,
    query: 'rollout gated tests',
    projectId: 'alpha',
    types: ['Decision'],
    includeCandidate: true,
    tokenBudget: 800,
  });
  assert.equal(decision.usedItems > 0, true);
});

test('rule enrichment generates structured fields for task memory', () => {
  const out = buildRuleEnrichment({
    type: 'Task',
    body: 'Task: owner:alice add retry policy and alert thresholds before rollout.',
    projectId: 'alpha',
  }, {
    sourcePath: 'session:abc:user',
    projectNameMap: { alpha: 'Alpha Project' },
  });

  assert.ok(out.context_summary.length > 0);
  assert.ok(out.meaning_summary.length > 0);
  assert.ok(out.actionability_summary.length > 0);
  assert.ok(out.next_action.length > 0);
  assert.equal(out.owner_hint, 'alice');
  assert.equal(out.project_display_name, 'Alpha Project');
});

test('rule enrichment uses quote-first context for notion-origin memory', () => {
  const out = buildRuleEnrichment({
    type: 'Insight',
    body: '少攻击自己，多复盘为什么没有理解孩子。',
    projectId: 'family',
    evidence: {
      sourcePath: 'notion:44444444-4444-4444-4444-000000000001#55555555-5555-5555-5555-000000000001',
      snippet: '少攻击自己，多复盘“为什么没能理解孩子”',
    },
  }, {
    sourcePath: 'notion:44444444-4444-4444-4444-000000000001#55555555-5555-5555-5555-000000000001',
  });

  assert.match(out.context_summary, /Quoted evidence:|证据摘录：/);
  assert.match(out.context_summary, /https:\/\/www\.notion\.so\//);
  assert.equal(out.meaning_summary !== out.context_summary, true);
  assert.equal(out.actionability_summary !== out.context_summary, true);
});

test('distill keeps notion product-idea open question as insight instead of task', () => {
  const source = {
    sourceType: 'notion',
    sourcePath: 'notion:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa#bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    mtimeMs: Date.now(),
    scopeLevel: 'global',
    projectId: null,
    sourceAuthority: 1,
    defaultState: 'verified',
  };
  const chunk = {
    lineStart: 1,
    lineEnd: 3,
    text: [
      '# 产品灵感',
      '把碎片日程/待办收口到单一真相源（SSOT），并自动分发提醒。',
      '无明确时间的待办：固定 17:00 追踪 / 22:00 追踪 / 我来判断？',
    ].join('\n'),
  };

  const items = distillChunk({
    source,
    chunk,
    options: {
      typeWhitelist: ['Decision', 'Task', 'Insight', 'Area'],
      minConfidence: 0.72,
    },
  });

  const openQuestion = items.find((item) => item.body.includes('无明确时间的待办'));
  assert.ok(openQuestion);
  assert.equal(openQuestion.type, 'Insight');
  assert.match(openQuestion.title, /待决策/);
  assert.equal(openQuestion.title.includes('/'), false);
  assert.match(openQuestion.body, /产品灵感/);
  assert.equal(
    items.some((item) => item.type === 'Task' && item.body.includes('无明确时间的待办')),
    false,
  );
});

test('rule enrichment marks exploratory planning question as non-actionable', () => {
  const out = buildRuleEnrichment({
    type: 'Task',
    body: '无明确时间的待办：固定 17:00 追踪 / 22:00 追踪 / 我来判断？',
  }, {
    sourcePath: 'notion:cccccccc-cccc-cccc-cccc-cccccccccccc#dddddddd-dddd-dddd-dddd-dddddddddddd',
  });

  assert.equal(out.next_action, '');
  assert.match(out.meaning_summary, /open planning idea\/question|待决策的规划灵感/i);
  assert.match(out.actionability_summary, /not directly executable yet|当前不可直接执行/i);
});

test('resync with newer enrichment version replaces stale actionable fields', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const notePath = path.join(projectRoot, 'hippocore', 'global', 'idea.md');
  write(notePath, [
    '# 产品灵感',
    '把碎片日程/待办收口到单一真相源（SSOT），并自动分发提醒。',
    '无明确时间的待办：固定 17:00 追踪 / 22:00 追踪 / 我来判断？',
  ].join('\n'));

  runSync({ cwd: projectRoot });

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  withDb(dbPath, (db) => {
    db.prepare(`
      UPDATE memory_items
      SET
        enrichment_version = 'rule-v1',
        next_action = 'Force stale next action',
        actionability_summary = 'Actionable now: Force stale next action'
      WHERE body LIKE '%无明确时间的待办%'
    `).run();
  });

  write(notePath, [
    '# 产品灵感',
    '把碎片日程/待办收口到单一真相源（SSOT），并自动分发提醒。',
    '无明确时间的待办：固定 17:00 追踪 / 22:00 追踪 / 我来判断？',
    '补充：该策略仍在探索中。',
  ].join('\n'));
  runSync({ cwd: projectRoot });

  const row = withDb(dbPath, (db) => db.prepare(`
    SELECT next_action, actionability_summary, enrichment_version
    FROM memory_items
    WHERE body LIKE '%无明确时间的待办%'
    ORDER BY id DESC
    LIMIT 1
  `).get());

  assert.ok(row);
  assert.equal(row.enrichment_version, 'bundle-v1');
  assert.equal(!row.next_action, true);
  assert.match(row.actionability_summary, /not directly executable yet|当前不可直接执行/i);
});

test('llm enrichment success overrides rule fields and persists to memory columns', async () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const requests = [];
  await withMockLlmClient((request) => {
    requests.push(request);
    return {
      status: 200,
      body: {
        id: 'resp-1',
        output_text: JSON.stringify({
          context_summary: 'LLM context: from integration workflow.',
          meaning_summary: 'LLM meaning: this determines release reliability.',
          actionability_summary: 'LLM actionability: execute staged rollout.',
          next_action: 'Assign rollout checklist.',
          owner_hint: 'qa-lead',
        }),
      },
    };
  }, async () => {
    await withEnv({
      OPENAI_API_KEY: 'llm-test-token',
    }, async () => {
      const cfg = loadConfig(projectRoot);
      cfg.quality.enrichment.llm.baseUrl = 'http://mock-llm.local/v1';
      cfg.quality.enrichment.llm.model = 'mock-model';
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const out = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Decision',
            body: 'Decision: staged rollout for payment webhook changes.',
          },
        ],
      });

      assert.equal(out.ok, true);
      assert.equal(out.enrichmentStats.llmSuccess, 1);
      assert.equal(requests.length >= 1, true);

      const refreshed = loadConfig(projectRoot);
      const dbPath = resolveConfiguredPath(projectRoot, refreshed.paths.db);
      const row = withDb(dbPath, (db) => db.prepare(`
        SELECT
          context_summary,
          meaning_summary,
          actionability_summary,
          next_action,
          owner_hint,
          enrichment_source,
          llm_enriched_at
        FROM memory_items
        WHERE body LIKE '%payment webhook%'
        ORDER BY id DESC
        LIMIT 1
      `).get());

      assert.ok(row);
      assert.equal(row.enrichment_source, 'rule+llm');
      assert.match(row.context_summary, /LLM context/i);
      assert.match(row.meaning_summary, /LLM meaning/i);
      assert.equal(row.owner_hint, 'qa-lead');
      assert.ok(row.llm_enriched_at);
    });
  });
});

test('llm enrichment failure falls back to rule output without blocking writes', async () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  await withMockLlmClient(() => ({
    status: 500,
    body: { error: { message: 'mock llm internal error' } },
  }), async () => {
    await withEnv({
      OPENAI_API_KEY: 'llm-test-token',
    }, async () => {
      const cfg = loadConfig(projectRoot);
      cfg.quality.enrichment.llm.baseUrl = 'http://mock-llm.local/v1';
      cfg.quality.enrichment.llm.maxRetries = 0;
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const out = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Task',
            body: 'Task: add canary alerts for payment webhooks.',
          },
        ],
      });

      assert.equal(out.ok, true);
      assert.equal(out.failed, 0);
      assert.equal(out.enrichmentStats.llmFallback, 1);
      assert.equal(out.enrichmentStats.ruleOnly, 1);
      assert.equal(out.enrichmentStats.llmErrors.length >= 1, true);

      const refreshed = loadConfig(projectRoot);
      const dbPath = resolveConfiguredPath(projectRoot, refreshed.paths.db);
      const row = withDb(dbPath, (db) => db.prepare(`
        SELECT context_summary, enrichment_source, llm_enriched_at
        FROM memory_items
        WHERE body LIKE '%canary alerts%'
        ORDER BY id DESC
        LIMIT 1
      `).get());

      assert.ok(row);
      assert.equal(row.enrichment_source, 'rule');
      assert.equal(row.llm_enriched_at, null);
      assert.equal((row.context_summary || '').length > 0, true);
    });
  });
});

test('llm timeout-style exception falls back to rule output', async () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  await withMockLlmClient(() => ({ throw: 'LLM request failed: timeout' }), async () => {
    await withEnv({
      OPENAI_API_KEY: 'llm-test-token',
    }, async () => {
      const cfg = loadConfig(projectRoot);
      cfg.quality.enrichment.llm.baseUrl = 'http://mock-llm.local/v1';
      cfg.quality.enrichment.llm.maxRetries = 0;
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const out = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Task',
            body: 'Task: simulate llm timeout fallback path.',
          },
        ],
      });
      assert.equal(out.ok, true);
      assert.equal(out.enrichmentStats.llmFallback, 1);
      assert.equal(out.enrichmentStats.ruleOnly, 1);
    });
  });
});

test('llm enrichment retries once on server error and then succeeds', async () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const requests = [];
  let sequence = 0;
  await withMockLlmClient((request) => {
    requests.push(request);
    sequence += 1;
    if (sequence === 1) {
      return { status: 500, body: { error: { message: 'temporary unavailable' } } };
    }
    return {
      status: 200,
      body: {
        id: 'resp-retry-ok',
        output_text: JSON.stringify({
          context_summary: 'Retry context',
          meaning_summary: 'Retry meaning',
          actionability_summary: 'Retry actionability',
          next_action: 'Retry next action',
          owner_hint: '',
        }),
      },
    };
  }, async () => {
    await withEnv({
      OPENAI_API_KEY: 'llm-test-token',
    }, async () => {
      const cfg = loadConfig(projectRoot);
      cfg.quality.enrichment.llm.baseUrl = 'http://mock-llm.local/v1';
      cfg.quality.enrichment.llm.maxRetries = 1;
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const out = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Insight',
            body: 'Insight: retry path should survive one transient provider failure.',
          },
        ],
      });

      assert.equal(out.ok, true);
      assert.equal(out.enrichmentStats.llmSuccess, 1);
      assert.equal(requests.length, 2);
    });
  });
});

test('llm client falls back from /responses to chat json_schema', async () => {
  const calls = [];
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      context_summary: { type: 'string' },
      meaning_summary: { type: 'string' },
    },
    required: ['context_summary', 'meaning_summary'],
  };

  await withMockLlmClient((request) => {
    calls.push({ path: request.path, responseFormat: request.payload && request.payload.response_format });
    if (request.path === '/responses') {
      return { status: 404, body: { error: { message: 'responses endpoint unavailable' } } };
    }
    if (request.path === '/chat/completions' && request.payload && request.payload.response_format && request.payload.response_format.type === 'json_schema') {
      return {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  context_summary: 'fallback context',
                  meaning_summary: 'fallback meaning',
                }),
              },
            },
          ],
        },
      };
    }
    return { status: 500, body: { error: { message: 'unexpected path in test' } } };
  }, async () => {
    const client = new OpenAICompatibleLlmClient({
      apiKey: 'mock-key',
      baseUrl: 'http://mock-llm.local/v1',
      model: 'mock-model',
      maxRetries: 0,
    });

    const out = client.createStructuredOutputSync({
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonSchema: schema,
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.context_summary, 'fallback context');
    assert.equal(parsed.meaning_summary, 'fallback meaning');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, '/responses');
    assert.equal(calls[1].path, '/chat/completions');
    assert.equal(calls[1].responseFormat.type, 'json_schema');
  });
});

test('llm client parses fenced json with prefix from chat json_object fallback', async () => {
  const calls = [];
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      context_summary: { type: 'string' },
      meaning_summary: { type: 'string' },
    },
    required: ['context_summary', 'meaning_summary'],
  };

  await withMockLlmClient((request) => {
    calls.push({ path: request.path, responseFormat: request.payload && request.payload.response_format });
    if (request.path === '/responses') {
      return { status: 404, body: { error: { message: 'responses missing' } } };
    }
    if (request.path === '/chat/completions' && request.payload && request.payload.response_format && request.payload.response_format.type === 'json_schema') {
      return { status: 400, body: { error: { message: 'json_schema unsupported' } } };
    }
    if (request.path === '/chat/completions' && request.payload && request.payload.response_format && request.payload.response_format.type === 'json_object') {
      return {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: 'Here is the result:\n```json\n{\"context_summary\":\"fenced context\",\"meaning_summary\":\"fenced meaning\"}\n```',
              },
            },
          ],
        },
      };
    }
    return { status: 500, body: { error: { message: 'unexpected path in test' } } };
  }, async () => {
    const client = new OpenAICompatibleLlmClient({
      apiKey: 'mock-key',
      baseUrl: 'http://mock-llm.local/v1',
      model: 'mock-model',
      maxRetries: 0,
    });

    const out = client.createStructuredOutputSync({
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonSchema: schema,
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.context_summary, 'fenced context');
    assert.equal(parsed.meaning_summary, 'fenced meaning');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].responseFormat.type, 'json_object');
  });
});

test('llm client reports labeled aggregated errors when all fallback paths fail', async () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      context_summary: { type: 'string' },
      meaning_summary: { type: 'string' },
    },
    required: ['context_summary', 'meaning_summary'],
  };

  await withMockLlmClient((request) => {
    if (request.path === '/responses') {
      return { status: 500, body: { error: { message: 'responses down' } } };
    }
    if (request.path === '/chat/completions' && request.payload && request.payload.response_format && request.payload.response_format.type === 'json_schema') {
      return { status: 400, body: { error: { message: 'json_schema unsupported' } } };
    }
    if (request.path === '/chat/completions' && request.payload && request.payload.response_format && request.payload.response_format.type === 'json_object') {
      return {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({ wrong: 'shape' }),
              },
            },
          ],
        },
      };
    }
    if (request.path === '/chat/completions') {
      return { throw: 'chat plain timeout' };
    }
    return { status: 500, body: { error: { message: 'unexpected path in test' } } };
  }, async () => {
    const client = new OpenAICompatibleLlmClient({
      apiKey: 'mock-key',
      baseUrl: 'http://mock-llm.local/v1',
      model: 'mock-model',
      maxRetries: 0,
    });

    assert.throws(
      () => client.createStructuredOutputSync({
        systemPrompt: 'system',
        userPrompt: 'user',
        jsonSchema: schema,
      }),
      (err) => (
        /responses:/.test(String(err && err.message))
        && /chat:json_schema:/.test(String(err && err.message))
        && /chat:json_object: schema mismatch/.test(String(err && err.message))
        && /chat:plain: chat plain timeout/.test(String(err && err.message))
      ),
    );
  });
});

test('new writes do not backfill historical memories', async () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const first = writeMemory({
    cwd: projectRoot,
    projectId: 'alpha',
    items: [
      {
        type: 'Decision',
        body: 'Decision: initial historical record before llm token setup.',
      },
    ],
  });
  assert.equal(first.ok, true);

  await withMockLlmClient(() => ({
    status: 200,
    body: {
      id: 'resp-later',
      output_text: JSON.stringify({
        context_summary: 'Later LLM context',
        meaning_summary: 'Later LLM meaning',
        actionability_summary: 'Later LLM actionability',
        next_action: 'Later next action',
        owner_hint: '',
      }),
    },
  }), async () => {
    await withEnv({
      OPENAI_API_KEY: 'llm-test-token',
    }, async () => {
      const cfg = loadConfig(projectRoot);
      cfg.quality.enrichment.llm.baseUrl = 'http://mock-llm.local/v1';
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const second = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Decision',
            body: 'Decision: new memory after llm setup should be llm-enhanced.',
          },
        ],
      });
      assert.equal(second.ok, true);
    });
  });

  const refreshed = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, refreshed.paths.db);
  const rows = withDb(dbPath, (db) => db.prepare(`
    SELECT body, enrichment_source, llm_enriched_at
    FROM memory_items
    WHERE body LIKE '%historical record%' OR body LIKE '%new memory after llm setup%'
    ORDER BY id ASC
  `).all());

  assert.equal(rows.length, 2);
  assert.equal(rows[0].enrichment_source, 'rule');
  assert.equal(rows[0].llm_enriched_at, null);
  assert.equal(rows[1].enrichment_source, 'rule+llm');
  assert.ok(rows[1].llm_enriched_at);
});

test('notion mapper renders readable fallback body when optional fields are unavailable', () => {
  const row = {
    id: 9,
    type: 'Task',
    title: 'Task: finalize launch checklist',
    body: 'Finalize launch checklist.',
    state: 'candidate',
    scope_level: 'project',
    project_id: 'alpha',
    confidence: 0.8,
    importance: 0.7,
    source_authority: 0.9,
    freshness_ts: Date.now(),
    source_path: 'notion:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa#bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    line_start: 1,
    line_end: 1,
    context_summary: 'From launch prep thread',
    meaning_summary: 'Prevents release regressions',
    actionability_summary: 'Can execute immediately',
    next_action: 'Assign checklist owner',
    owner_hint: 'release-manager',
    project_display_name: 'Alpha Project',
  };
  const basicMap = {
    Title: 'Title',
    HippocoreId: 'HippocoreId',
    Type: 'Type',
    Body: 'Body',
    State: 'State',
  };
  const propsWithFallback = buildMemoryProperties(row, { propertyMap: basicMap });
  const bodyWithFallback = richTextValue(propsWithFallback.Body);
  const titleWithFallback = richTextValue(propsWithFallback.Title);
  assert.equal(titleWithFallback.startsWith('Task:'), false);
  assert.equal(/\[Hippocore Enrichment\]/.test(bodyWithFallback), false);
  assert.match(bodyWithFallback, /^Finalize launch checklist\./);
  assert.match(bodyWithFallback, /\nContext\nFrom launch prep thread/);
  assert.match(bodyWithFallback, /\nMeaning\nPrevents release regressions/);
  assert.match(bodyWithFallback, /\nActionability\nCan execute immediately/);
  assert.match(bodyWithFallback, /\nNext Action\nAssign checklist owner/);
  assert.match(bodyWithFallback, /\nSource\nhttps:\/\/www\.notion\.so\//);
  assert.match(bodyWithFallback, /https:\/\/www\.notion\.so\//);

  const fullMap = {
    ...basicMap,
    ContextSummary: 'ContextSummary',
    MeaningSummary: 'MeaningSummary',
    ActionabilitySummary: 'ActionabilitySummary',
    NextAction: 'NextAction',
    OwnerHint: 'OwnerHint',
    ProjectDisplayName: 'ProjectDisplayName',
    ReadableTitle: 'ReadableTitle',
    SourceCategory: 'SourceCategory',
    SourceDecisionPath: 'SourceDecisionPath',
    SourceUrl: 'SourceUrl',
  };
  const propsWithoutFallback = buildMemoryProperties(row, { propertyMap: fullMap });
  const bodyWithoutFallback = richTextValue(propsWithoutFallback.Body);
  assert.equal(/\[Hippocore Enrichment\]/.test(bodyWithoutFallback), false);
  assert.equal(richTextValue(propsWithoutFallback.ReadableTitle).length > 0, true);
  assert.match(richTextValue(propsWithoutFallback.SourceCategory), /Notion/i);
  assert.match(richTextValue(propsWithoutFallback.SourceDecisionPath), /Notion > page:/);
  assert.equal(typeof propsWithoutFallback.SourceUrl.url, 'string');
  assert.match(propsWithoutFallback.SourceUrl.url, /https:\/\/www\.notion\.so\//);
});

test('doctor reports llm enrichment warning without blocking health check', async () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  await withEnv({
    OPENAI_API_KEY: null,
  }, async () => {
    const doctor = runDoctor({ cwd: projectRoot });
    const check = doctor.checks.find((x) => x.name === 'llm_enrichment');
    assert.ok(check);
    assert.equal(check.ok, true);
    assert.match(check.detail, /fallback to rule-only|enabled/i);
    assert.equal(doctor.ok, true);
  });
});

test('write + review promote/archive lifecycle works', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const writeResult = writeMemory({
    cwd: projectRoot,
    projectId: 'alpha',
    items: [
      {
        type: 'Decision',
        body: 'Use staged rollout for alpha to reduce deployment risk.',
        confidence: 0.82,
      },
    ],
  });

  assert.equal(writeResult.created, 1);

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  const row = withDb(dbPath, (db) => db.prepare(`
    SELECT id, state FROM memory_items WHERE body LIKE '%staged rollout%'
  `).get());

  assert.ok(row.id > 0);
  assert.equal(row.state, 'candidate');

  const promoted = reviewPromote({ cwd: projectRoot, itemIds: [row.id], reason: 'validated by user' });
  assert.equal(promoted.promotedCount, 1);

  const archived = reviewArchive({ cwd: projectRoot, itemIds: [row.id], reason: 'outdated decision' });
  assert.equal(archived.archivedCount, 1);
});

test('trigger flows and backup/restore remain functional', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const start = triggerSessionStart({
    cwd: projectRoot,
    sessionKey: 'session-a',
    projectId: 'alpha',
    tokenBudget: 500,
  });

  assert.equal(start.ok, true);
  assert.match(start.context.text, /MEMORY CONTEXT/);

  const submit = triggerUserPromptSubmit({
    cwd: projectRoot,
    sessionKey: 'session-a',
    projectId: 'alpha',
    messageId: 'm-1',
    text: 'Decision: prioritize sync reliability and add retry logic.',
  });

  assert.equal(submit.ok, true);

  const backup = createBackup({ cwd: projectRoot });
  assert.ok(fs.existsSync(path.join(backup.backupDir, 'hippocore.db')));

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  fs.unlinkSync(dbPath);

  const restored = restoreBackup({ cwd: projectRoot, backupDir: backup.backupDir });
  assert.equal(path.resolve(restored.backupDir), path.resolve(backup.backupDir));
  assert.ok(fs.existsSync(dbPath));
});

test('setup installs hooks in openclaw home and wires sources', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-'));
  const obsidianVault = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-vault-'));
  const sessionsDir = path.join(openclawHome, 'agents', 'main', 'sessions');
  const hooksPath = path.join(openclawHome, 'agents', 'main', 'agent', 'hooks.json');

  fs.mkdirSync(path.join(obsidianVault, '.obsidian'), { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: 'echo legacy-session-start',
            },
          ],
        },
      ],
    },
  }, null, 2) + '\n', 'utf8');

  const result = setupHippocore({
    cwd: projectRoot,
    openclawHome,
    obsidianVault,
    sessionsPath: sessionsDir,
    mode: 'cloud',
    storage: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.onboarding.installStatus, 'blocked_mirror_required');
  assert.equal(result.sources.obsidianVault, obsidianVault);
  assert.equal(result.sources.clawdbotTranscripts, sessionsDir);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore', 'projects', 'main', 'README.md')), true);
  assert.equal(fs.existsSync(hooksPath), true);
  assert.equal(fs.existsSync(path.join(openclawHome, 'hippocore', 'openclaw.plugin.json')), true);
  assert.equal(result.onboarding.mirror.shouldRecommend, true);
  assert.equal(result.onboarding.mirror.suggestedTiming, 'after_setup_success');
  assert.equal(result.onboarding.mirrorOnboarding.required, true);
  assert.equal(result.onboarding.mirrorOnboarding.ready, false);
  const configAfterSetup = loadConfig(projectRoot);
  assert.equal(configAfterSetup.mirror.remote, result.onboarding.mirror.remote);
  assert.equal(configAfterSetup.mirror.local, result.onboarding.mirror.local);
  assert.equal(configAfterSetup.mirror.required, true);
  assert.equal(configAfterSetup.mirror.completedAt, null);

  const hooksAfterSetup = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const allSessionStartCommands = hooksAfterSetup.hooks.SessionStart
    .flatMap((group) => group.hooks || [])
    .map((entry) => String(entry.command || ''));
  const allPromptCommands = hooksAfterSetup.hooks.UserPromptSubmit
    .flatMap((group) => group.hooks || [])
    .map((entry) => String(entry.command || ''));
  const allSessionEndCommands = hooksAfterSetup.hooks.SessionEnd
    .flatMap((group) => group.hooks || [])
    .map((entry) => String(entry.command || ''));

  const assertBundledScriptBinding = (commands, scriptName) => {
    const expectedProjectScriptPath = path.join(projectRoot, 'scripts', scriptName);
    const command = commands.find((cmd) => cmd.includes(scriptName) && cmd.includes('HIPPOCORE_PROJECT_ROOT='));
    assert.ok(command, `missing hippocore hook command for ${scriptName}`);
    assert.equal(command.includes(expectedProjectScriptPath), false);

    const scriptPathMatch = command.match(/node\s+'([^']+)'/);
    assert.ok(scriptPathMatch, `missing script path in command for ${scriptName}`);
    assert.equal(path.basename(scriptPathMatch[1]), scriptName);
    assert.equal(fs.existsSync(scriptPathMatch[1]), true);
  };

  assert.ok(allSessionStartCommands.some((cmd) => cmd.includes('echo legacy-session-start')));
  assert.ok(allSessionStartCommands.some((cmd) => cmd.includes('session_start.js')));
  assertBundledScriptBinding(allSessionStartCommands, 'session_start.js');
  assertBundledScriptBinding(allPromptCommands, 'user_prompt_submit.js');
  assertBundledScriptBinding(allSessionEndCommands, 'session_end.js');
});

test('setup defaults to installing hooks for all discovered agents', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-multi-all-'));
  const agentNames = ['main', 'friday_ch_xxx', 'trouble_ch_xxx'];
  const hooksByAgent = new Map();

  for (const agentName of agentNames) {
    const hooksPath = writeAgentHooks(openclawHome, agentName, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `echo legacy-${agentName}`,
              },
            ],
          },
        ],
      },
    });
    hooksByAgent.set(agentName, hooksPath);
  }

  const result = setupHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  assert.equal(result.ok, true);
  assert.ok(result.integration);
  assert.equal(result.integration.installAgents, 'all');
  assert.equal(result.integration.hooksPath, hooksByAgent.get('main'));
  assert.deepEqual(
    result.integration.agentTargets.map((item) => item.name).sort(),
    [...agentNames].sort(),
  );
  assert.deepEqual(result.integration.warnings, []);

  for (const agentName of agentNames) {
    const hooks = readHooksJson(hooksByAgent.get(agentName));
    assert.equal(countHippocoreHookCommands(hooks, 'session_start.js'), 1);
    assert.equal(countHippocoreHookCommands(hooks, 'user_prompt_submit.js'), 1);
    assert.equal(countHippocoreHookCommands(hooks, 'session_end.js'), 1);
    assert.equal(
      listHookCommands(hooks, 'SessionStart').some((command) => command.includes(`echo legacy-${agentName}`)),
      true,
    );
  }

  const installMetaPath = path.join(openclawHome, 'hippocore', 'install.json');
  const installMeta = readHooksJson(installMetaPath);
  assert.deepEqual(
    (installMeta.files.agentHookPaths || []).slice().sort(),
    Array.from(hooksByAgent.values()).sort(),
  );
});

test('setup supports install-agents subset and skips other agents', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-multi-subset-'));
  const mainHooksPath = writeAgentHooks(openclawHome, 'main', {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo legacy-main' }] }] },
  });
  const fridayHooksPath = writeAgentHooks(openclawHome, 'friday_ch_xxx', {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo legacy-friday' }] }] },
  });
  const troubleHooksPath = writeAgentHooks(openclawHome, 'trouble_ch_xxx', {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo legacy-trouble' }] }] },
  });

  const result = setupHippocore({
    cwd: projectRoot,
    openclawHome,
    installAgents: 'main,friday_ch_xxx',
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  assert.equal(result.ok, true);
  assert.ok(result.integration);
  assert.equal(result.integration.installAgents, 'main,friday_ch_xxx');
  assert.deepEqual(
    result.integration.agentTargets.map((item) => item.name).sort(),
    ['main', 'friday_ch_xxx'].sort(),
  );

  const mainHooks = readHooksJson(mainHooksPath);
  const fridayHooks = readHooksJson(fridayHooksPath);
  const troubleHooks = readHooksJson(troubleHooksPath);

  assert.equal(countHippocoreHookCommands(mainHooks, 'session_start.js'), 1);
  assert.equal(countHippocoreHookCommands(fridayHooks, 'session_start.js'), 1);
  assert.equal(countHippocoreHookCommands(troubleHooks, 'session_start.js'), 0);
});

test('setup install-agents missing targets warn but does not block install', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-multi-missing-'));
  const mainHooksPath = writeAgentHooks(openclawHome, 'main', {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo legacy-main' }] }] },
  });

  const result = setupHippocore({
    cwd: projectRoot,
    openclawHome,
    installAgents: 'main,not_exist_agent',
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  assert.equal(result.ok, true);
  assert.ok(result.integration);
  assert.equal(result.integration.ok, true);
  assert.equal(result.integration.agentTargets.length, 1);
  assert.equal(result.integration.agentTargets[0].name, 'main');
  assert.equal(
    result.integration.warnings.some((entry) => entry.includes('not_exist_agent') && entry.includes('skipped')),
    true,
  );
  const mainHooks = readHooksJson(mainHooksPath);
  assert.equal(countHippocoreHookCommands(mainHooks, 'session_start.js'), 1);
});

test('cloud mirror onboarding blocks session startup until complete is acknowledged', () => {
  const projectRoot = mkTempProject();
  const setup = setupHippocore({
    cwd: projectRoot,
    mode: 'cloud',
    storage: 'local',
    runInitialSync: false,
    installHooks: false,
  });

  assert.equal(setup.ok, false);
  assert.equal(setup.onboarding.installStatus, 'blocked_mirror_required');

  const blockedStart = triggerSessionStart({
    cwd: projectRoot,
    sessionKey: 'mirror-gate-1',
    tokenBudget: 300,
    projectId: 'alpha',
  });
  assert.equal(blockedStart.mirrorOnboarding.blocking, true);
  assert.match(blockedStart.context.text, /HIPPOCORE MIRROR SETUP REQUIRED/);

  const complete = completeMirrorOnboarding({ cwd: projectRoot });
  assert.equal(complete.ok, true);
  assert.equal(complete.mirrorOnboarding.ready, true);
  assert.ok(complete.mirrorOnboarding.completedAt);

  const status = getMirrorStatus({ cwd: projectRoot });
  assert.equal(status.mirrorOnboarding.ready, true);
  assert.equal(status.ok, true);

  const readyStart = triggerSessionStart({
    cwd: projectRoot,
    sessionKey: 'mirror-gate-2',
    tokenBudget: 300,
    projectId: 'alpha',
  });
  assert.equal(readyStart.mirrorOnboarding.blocking, false);
  assert.equal(/HIPPOCORE MIRROR SETUP REQUIRED/.test(readyStart.context.text), false);
});

test('cloud setup without explicit storage prefers notion path', async () => {
  const projectRoot = mkTempProject();

  await withEnv({
    NOTION_API_KEY: null,
    HIPPOCORE_NOTION_BASE_URL: null,
  }, async () => {
    const setup = setupHippocore({
      cwd: projectRoot,
      mode: 'cloud',
      runInitialSync: false,
      installHooks: false,
    });

    assert.equal(setup.storage.mode, 'notion');
    assert.equal(setup.ok, false);
    assert.equal(setup.onboarding.installStatus, 'blocked_notion_required');
    assert.equal(setup.onboarding.mirrorOnboarding.required, false);
    assert.equal(setup.onboarding.mirrorOnboarding.blocking, false);
    assert.equal(setup.onboarding.phases.find((x) => x.name === 'mirror_setup').status, 'skipped');
    assert.equal(setup.onboarding.phases.find((x) => x.name === 'notion_setup').status, 'blocked');
    assert.equal(setup.onboarding.nextActions.includes('configure_notion_and_retry'), true);
    assert.equal(setup.onboarding.nextActions.includes('configure_notion_doc_sources'), true);
  });
});

test('cloud notion setup requires docDataSourceIds and doctor fails when missing', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      const setup = setupHippocore({
        cwd: projectRoot,
        mode: 'cloud',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        runInitialSync: false,
        installHooks: false,
      });

      assert.equal(setup.ok, false);
      assert.equal(setup.onboarding.installStatus, 'blocked_notion_required');
      assert.equal(setup.notionOnboarding.docSourcesConfigured, false);
      assert.equal(setup.onboarding.nextActions.includes('configure_notion_doc_sources'), true);
      assert.match((setup.notionOnboarding.errors || []).join('\n'), /docDataSourceIds/i);

      const doctor = runDoctor({ cwd: projectRoot });
      const notionConfig = doctor.checks.find((check) => check.name === 'notion_config');
      const notionDocSources = doctor.checks.find((check) => check.name === 'notion_doc_sources');
      assert.ok(notionConfig);
      assert.equal(notionConfig.ok, false);
      assert.match(notionConfig.detail, /docDataSourceIds/i);
      assert.ok(notionDocSources);
      assert.equal(notionDocSources.ok, false);
    });
  });
});

test('cloud notion setup accepts watchRoots without docDataSourceIds', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      const setup = setupHippocore({
        cwd: projectRoot,
        mode: 'cloud',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionWatchRoots: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        runInitialSync: false,
        installHooks: false,
      });

      assert.equal(setup.ok, true);
      assert.equal(setup.notionOnboarding.docSourcesConfigured, true);
      assert.equal(setup.onboarding.nextActions.includes('notion_storage_ready'), true);

      const doctor = runDoctor({ cwd: projectRoot });
      const notionDocSources = doctor.checks.find((check) => check.name === 'notion_doc_sources');
      assert.ok(notionDocSources);
      assert.equal(notionDocSources.ok, true);
    });
  });
});

test('cloud notion setup blocks completion when runtime env token is not durable', async () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-'));

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      OPENCLAW_HOME: openclawHome,
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      const firstSetup = setupHippocore({
        cwd: projectRoot,
        mode: 'cloud',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: true,
      });

      assert.equal(firstSetup.ok, false);
      assert.equal(firstSetup.onboarding.installStatus, 'blocked_notion_required');
      assert.ok(firstSetup.notionRuntimeToken);
      assert.equal(firstSetup.notionRuntimeToken.required, true);
      assert.equal(firstSetup.notionRuntimeToken.ok, false);
      assert.equal(firstSetup.onboarding.nextActions.includes('configure_notion_runtime_token'), true);

      const runtimeEnvPath = path.join(openclawHome, 'hippocore', 'env.sh');
      const runtimeEnvBefore = fs.readFileSync(runtimeEnvPath, 'utf8');
      assert.equal(/export\s+NOTION_API_KEY=/.test(runtimeEnvBefore), false);

      fs.writeFileSync(
        runtimeEnvPath,
        `${runtimeEnvBefore.trimEnd()}\nexport NOTION_API_KEY=mock-token\n`,
        'utf8',
      );

      const secondSetup = setupHippocore({
        cwd: projectRoot,
        mode: 'cloud',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: true,
      });

      assert.equal(secondSetup.ok, true);
      assert.equal(secondSetup.onboarding.installStatus, 'completed');
      assert.ok(secondSetup.notionRuntimeToken);
      assert.equal(secondSetup.notionRuntimeToken.ok, true);

      const runtimeEnvAfter = fs.readFileSync(runtimeEnvPath, 'utf8');
      assert.match(runtimeEnvAfter, /export NOTION_API_KEY=mock-token/);
    });
  });
});

test('notion onboarding blocks session startup until notion storage is ready', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: null,
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      const setup = setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        runInitialSync: false,
        installHooks: false,
      });
      assert.equal(setup.ok, false);
      assert.equal(setup.onboarding.installStatus, 'blocked_notion_required');

      const blockedStart = triggerSessionStart({
        cwd: projectRoot,
        sessionKey: 'notion-gate-1',
        tokenBudget: 300,
        projectId: 'alpha',
      });
      assert.equal(blockedStart.syncSummary.status, 'blocked_notion_required');
      assert.equal(blockedStart.notionOnboarding.blocking, true);
      assert.match(blockedStart.context.text, /HIPPOCORE NOTION SETUP REQUIRED/);
      assert.match(blockedStart.context.text, /NOTION_API_KEY/);
      assert.match(blockedStart.context.text, /notion-doc-datasource-ids/i);
      assert.match(blockedStart.context.text, /hippocore\.js notion status/);
    });
  });
});

test('mirror sync builds rsync pull+push plan with local preference', () => {
  const projectRoot = mkTempProject();
  const localMirror = path.join(projectRoot, 'hippocore');
  fs.mkdirSync(localMirror, { recursive: true });

  const calls = [];
  const executor = (cmd, args) => {
    calls.push({ cmd, args });
    return {
      status: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
      command: [cmd, ...args].join(' '),
    };
  };

  const result = mirrorHippocore({
    cwd: projectRoot,
    action: 'sync',
    remote: 'user@example.com:/srv/hippocore',
    localPath: localMirror,
    prefer: 'local',
    dryRun: true,
    executor,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3); // one for rsync --version, two for sync operations
  assert.equal(calls[0].cmd, 'rsync');
  assert.equal(calls[1].cmd, 'rsync');
  assert.equal(calls[2].cmd, 'rsync');
  assert.ok(calls[1].args.includes('--dry-run'));
  assert.ok(calls[2].args.includes('--dry-run'));
});

test('upgrade keeps workflow no-touch and produces backup when db exists', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-upgrade-'));
  initProject({ cwd: projectRoot });

  const upgraded = upgradeHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
    createDataBackup: true,
  });

  assert.equal(upgraded.ok, true);
  assert.ok(upgraded.backup && upgraded.backup.backupDir);
  assert.equal(fs.existsSync(path.join(upgraded.backup.backupDir, 'hippocore.db')), true);
  assert.equal(upgraded.setup.ok, true);
});

test('uninstall restores previous hooks and optionally removes workspace data', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-uninstall-'));
  const agentDir = path.join(openclawHome, 'agents', 'main', 'agent');
  const hooksPath = path.join(agentDir, 'hooks.json');
  fs.mkdirSync(agentDir, { recursive: true });

  const originalHooks = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: 'echo legacy-hook',
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(hooksPath, JSON.stringify(originalHooks, null, 2) + '\n', 'utf8');

  setupHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  const keepDataResult = uninstallHippocore({
    cwd: projectRoot,
    openclawHome,
    keepData: true,
  });

  assert.equal(keepDataResult.ok, true);
  assert.equal(fs.existsSync(path.join(openclawHome, 'hippocore')), false);
  const restoredHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.deepEqual(restoredHooks, originalHooks);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore')), true);

  const dropDataResult = uninstallHippocore({
    cwd: projectRoot,
    openclawHome,
    keepData: false,
  });
  assert.equal(dropDataResult.ok, true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore')), false);
});

test('uninstall scans all agents and only removes hippocore-managed hooks', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-uninstall-multi-'));
  const agentNames = ['main', 'friday_ch_xxx', 'trouble_ch_xxx'];
  const originalByAgent = new Map();
  const hooksByAgent = new Map();

  for (const agentName of agentNames) {
    const originalHooks = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `echo legacy-${agentName}`,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: `echo prompt-${agentName}`,
              },
            ],
          },
        ],
      },
    };
    const hooksPath = writeAgentHooks(openclawHome, agentName, originalHooks);
    originalByAgent.set(agentName, originalHooks);
    hooksByAgent.set(agentName, hooksPath);
  }

  setupHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  const result = uninstallHippocore({
    cwd: projectRoot,
    openclawHome,
    keepData: true,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(openclawHome, 'hippocore')), false);

  for (const agentName of agentNames) {
    const hooks = readHooksJson(hooksByAgent.get(agentName));
    assert.equal(countHippocoreHookCommands(hooks, 'session_start.js'), 0);
    assert.equal(countHippocoreHookCommands(hooks, 'user_prompt_submit.js'), 0);
    assert.equal(countHippocoreHookCommands(hooks, 'session_end.js'), 0);
    assert.deepEqual(hooks, originalByAgent.get(agentName));
  }
});

test('setup is idempotent and does not duplicate hippocore hooks', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-idempotent-'));
  const hooksPath = path.join(openclawHome, 'agents', 'main', 'agent', 'hooks.json');

  setupHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  setupHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const sessionStartMatches = hooks.hooks.SessionStart
    .flatMap((group) => group.hooks || [])
    .filter((entry) => String(entry.command || '').includes('session_start.js'));
  const promptMatches = hooks.hooks.UserPromptSubmit
    .flatMap((group) => group.hooks || [])
    .filter((entry) => String(entry.command || '').includes('user_prompt_submit.js'));

  assert.equal(sessionStartMatches.length, 1);
  assert.equal(promptMatches.length, 1);
});

test('setup is idempotent across multiple agents', () => {
  const projectRoot = mkTempProject();
  const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-home-idempotent-multi-'));
  const mainHooksPath = writeAgentHooks(openclawHome, 'main', {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo legacy-main' }] }] },
  });
  const fridayHooksPath = writeAgentHooks(openclawHome, 'friday_ch_xxx', {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo legacy-friday' }] }] },
  });

  setupHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });
  setupHippocore({
    cwd: projectRoot,
    openclawHome,
    mode: 'local',
    runInitialSync: false,
    installHooks: true,
  });

  const mainHooks = readHooksJson(mainHooksPath);
  const fridayHooks = readHooksJson(fridayHooksPath);
  for (const hooks of [mainHooks, fridayHooks]) {
    assert.equal(countHippocoreHookCommands(hooks, 'session_start.js'), 1);
    assert.equal(countHippocoreHookCommands(hooks, 'user_prompt_submit.js'), 1);
    assert.equal(countHippocoreHookCommands(hooks, 'session_end.js'), 1);
  }
});

test('session end distillation uses user messages as primary and AI as supplemental only', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const endResult = triggerSessionEnd({
    cwd: projectRoot,
    sessionKey: 'session-end-1',
    projectId: 'alpha',
    messages: [
      { role: 'user', content: 'Decision: pause rollout until integration tests pass.' },
      { role: 'assistant', content: 'Decision: migrate everything to Rust immediately.' },
      { role: 'user', content: 'Task: add integration tests and retry tomorrow.' },
    ],
  });

  assert.equal(endResult.ok, true);
  assert.equal(endResult.messageCounts.user, 2);
  assert.equal(endResult.messageCounts.assistant, 1);

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  const sessionRows = withDb(dbPath, (db) => db.prepare(`
    SELECT m.body AS body
    FROM memory_items m
    JOIN source_records s ON s.id = m.source_record_id
    WHERE s.source_path LIKE 'session_end:session-end-1:%'
  `).all());

  const bodies = sessionRows.map((row) => String(row.body || '').toLowerCase());
  assert.ok(bodies.some((body) => body.includes('pause rollout')));
  assert.ok(bodies.some((body) => body.includes('integration tests')));
  assert.equal(bodies.some((body) => body.includes('migrate everything to rust immediately')), false);
});

test('prompt + session_end keep one decision memory when session transcript includes USER prefix', () => {
  const projectRoot = mkTempProject();
  setupHippocore({
    cwd: projectRoot,
    mode: 'local',
    runInitialSync: false,
    installHooks: false,
  });

  const sessionKey = 'session-dedup-1';
  const projectId = 'im-sample';
  const decision = '决定：本次评审先只覆盖召回模块，排序模块延期到下个迭代。';

  const promptResult = triggerUserPromptSubmit({
    cwd: projectRoot,
    sessionKey,
    messageId: 'u2',
    text: decision,
    projectId,
  });
  assert.equal(promptResult.ok, true);
  assert.equal(promptResult.syncSummary, null);

  const endResult = triggerSessionEnd({
    cwd: projectRoot,
    sessionKey,
    projectId,
    messages: [
      { role: 'user', messageId: 'u2', content: decision },
    ],
  });
  assert.equal(endResult.ok, true);

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const rows = withDb(dbPath, (db) => db.prepare(`
    SELECT m.id, m.body
    FROM memory_items m
    WHERE m.body LIKE '%本次评审先只覆盖召回模块%'
    ORDER BY m.id ASC
  `).all());
  assert.equal(rows.length, 1);
  assert.equal(/^USER\s*[:：]/i.test(rows[0].body), false);

  const evidenceRows = withDb(dbPath, (db) => db.prepare(`
    SELECT source_type
    FROM evidence
    WHERE memory_item_id = ?
    ORDER BY id ASC
  `).all(rows[0].id));
  assert.equal(evidenceRows.some((row) => row.source_type === 'prompt'), false);
  assert.equal(evidenceRows.some((row) => row.source_type === 'session'), true);
});

test('clawdbot transcript defaults to user-primary and assistant-signal-only filtering', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippocore-clawdbot-'));
  const transcriptPath = path.join(transcriptDir, 'session-1.jsonl');
  const lines = [
    JSON.stringify({
      type: 'message',
      timestamp: '2026-03-01T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: 'I will run a command and inspect stdout, stderr, and exit code.',
      },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-03-01T10:00:10.000Z',
      message: {
        role: 'assistant',
        content: 'Decision: use queue-based retries for webhook delivery.',
      },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-03-01T10:00:20.000Z',
      message: {
        role: 'user',
        content: 'Task: add retry backoff and jitter policy.',
      },
    }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8');

  const config = loadConfig(projectRoot);
  config.paths.clawdbotTranscripts = transcriptDir;
  saveConfig(projectRoot, config, {
    configPath: config.__meta && config.__meta.configPath ? config.__meta.configPath : undefined,
  });

  const syncResult = runSync({ cwd: projectRoot });
  assert.equal(syncResult.status, 'success');

  const refreshedConfig = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, refreshedConfig.paths.db);
  const noisyRows = withDb(dbPath, (db) => db.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_items m
    JOIN source_records s ON s.id = m.source_record_id
    WHERE s.source_path LIKE '%session-1.jsonl%'
      AND (LOWER(m.body) LIKE '%stdout%' OR LOWER(m.body) LIKE '%stderr%' OR LOWER(m.body) LIKE '%exit code%')
  `).get());
  assert.equal(noisyRows.c, 0);

  const useful = retrieveMemory({
    cwd: projectRoot,
    query: 'queue retries webhook backoff jitter',
    tokenBudget: 800,
    includeCandidate: true,
  });
  assert.equal(useful.usedItems > 0, true);
});

test('assistant message trigger logs to session and session_end can consume without explicit messages', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  triggerUserPromptSubmit({
    cwd: projectRoot,
    sessionKey: 'session-log-1',
    projectId: 'alpha',
    messageId: 'u-1',
    text: 'Decision: keep current architecture and reduce risk first.',
  });

  triggerAssistantMessage({
    cwd: projectRoot,
    sessionKey: 'session-log-1',
    projectId: 'alpha',
    messageId: 'a-1',
    text: 'You may also consider moving to a service mesh now.',
  });

  const result = triggerSessionEnd({
    cwd: projectRoot,
    sessionKey: 'session-log-1',
    projectId: 'alpha',
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageCounts.user >= 1, true);
  assert.equal(result.messageCounts.assistant >= 1, true);
});

test('checkpoint detector ignores ordinary assistant replies', () => {
  const result = detectCheckpointAnchor({}, 'You can try one more option here if needed.', {
    sessionKey: 's-1',
    messageId: 'a-1',
  }, loadConfig(mkTempProject()));
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'no_match');
});

test('assistant message job payload records non-match checkpoint telemetry', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  const result = triggerAssistantMessage({
    cwd: projectRoot,
    sessionKey: 'assistant-observe-1',
    projectId: 'alpha',
    messageId: 'a-1',
    text: 'You can try one more option here if needed.',
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkpointDetected, false);

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const row = withDb(dbPath, (db) => db.prepare(`
    SELECT payload_json
    FROM memory_jobs
    WHERE event_type = 'assistant_message'
      AND session_key = 'assistant-observe-1'
      AND message_id = 'a-1'
    LIMIT 1
  `).get());
  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.checkpointDetected, false);
  assert.equal(payload.checkpointReason, 'no_match');
  assert.equal(typeof payload.checkpointConfidence, 'number');
});

test('assistant summary anchor triggers checkpoint without waiting for session_end', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  triggerUserPromptSubmit({
    cwd: projectRoot,
    sessionKey: 'session-anchor-1',
    projectId: 'alpha',
    messageId: 'u-1',
    text: 'We should first validate whether the new workflow increases note capture frequency.',
  });

  const assistant = triggerAssistantMessage({
    cwd: projectRoot,
    sessionKey: 'session-anchor-1',
    projectId: 'alpha',
    messageId: 'a-1',
    text: 'Summary\n- Current conclusion: validate whether note capture frequency improves first.\n- Next steps: define a simple watch-based experiment and success metric.\n- Decisions: do not build new hardware before validation.',
  });

  assert.equal(assistant.ok, true);
  assert.equal(assistant.checkpointDetected, true);
  assert.equal(assistant.checkpointTriggered, true);
  assert.equal(assistant.checkpointReason === 'summary_heading' || assistant.checkpointReason === 'shape_score', true);

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const checkpointRow = withDb(dbPath, (db) => db.prepare(`
    SELECT trigger_source, trigger_message_id, source_bundle_id
    FROM conversation_checkpoints
    WHERE session_key = 'session-anchor-1'
    ORDER BY id DESC
    LIMIT 1
  `).get());
  assert.equal(checkpointRow.trigger_source, 'assistant_anchor');
  assert.equal(checkpointRow.trigger_message_id, 'a-1');
  assert.equal(Boolean(checkpointRow.source_bundle_id), true);

  const jobRow = withDb(dbPath, (db) => db.prepare(`
    SELECT payload_json
    FROM memory_jobs
    WHERE event_type = 'assistant_message'
      AND session_key = 'session-anchor-1'
      AND message_id = 'a-1'
    LIMIT 1
  `).get());
  const jobPayload = JSON.parse(jobRow.payload_json);
  assert.equal(jobPayload.checkpointDetected, true);
  assert.equal(jobPayload.checkpointTriggered, true);
  assert.equal(jobPayload.checkpointTriggerSource, 'assistant_anchor');
  assert.equal(Boolean(jobPayload.checkpointKey), true);
  assert.equal(Boolean(jobPayload.checkpointBundleId), true);
});

test('session_end only processes tail after assistant-anchor checkpoint', () => {
  const projectRoot = mkTempProject();
  initProject({ cwd: projectRoot });

  triggerUserPromptSubmit({
    cwd: projectRoot,
    sessionKey: 'session-anchor-tail-1',
    projectId: 'alpha',
    messageId: 'u-1',
    text: 'Decision: keep retries enabled while we validate the callback flow.',
  });

  triggerAssistantMessage({
    cwd: projectRoot,
    sessionKey: 'session-anchor-tail-1',
    projectId: 'alpha',
    messageId: 'a-1',
    text: 'Summary\n- Current conclusion: keep retries enabled.\n- Next steps: validate callback observability.\n- Decisions: do not remove retry logic yet.',
  });

  triggerUserPromptSubmit({
    cwd: projectRoot,
    sessionKey: 'session-anchor-tail-1',
    projectId: 'alpha',
    messageId: 'u-2',
    text: 'Task: instrument callback failures with a dedicated alert.',
  });

  const end = triggerSessionEnd({
    cwd: projectRoot,
    sessionKey: 'session-anchor-tail-1',
    projectId: 'alpha',
  });

  assert.equal(end.ok, true);
  assert.equal(end.syncSummary.status, 'success');

  const config = loadConfig(projectRoot);
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
  const checkpointCount = withDb(dbPath, (db) => db.prepare(`
    SELECT COUNT(*) AS c
    FROM conversation_checkpoints
    WHERE session_key = 'session-anchor-tail-1'
  `).get());
  assert.equal(checkpointCount.c, 2);

  const rows = withDb(dbPath, (db) => db.prepare(`
    SELECT checkpoint_key, trigger_source, source_bundle_id
    FROM conversation_checkpoints
    WHERE session_key = 'session-anchor-tail-1'
    ORDER BY id ASC
  `).all());
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => Boolean(row.source_bundle_id)), true);
  assert.equal(rows.some((row) => row.trigger_source === 'assistant_anchor'), true);
  assert.equal(rows.some((row) => row.trigger_source === 'session_end_fallback'), true);
});

test('notion mode setup skips mirror gate and doctor uses notion checks', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      const setup = setupHippocore({
        cwd: projectRoot,
        mode: 'cloud',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      assert.equal(setup.ok, true);
      assert.equal(setup.storage.mode, 'notion');
      assert.equal(setup.onboarding.installStatus, 'completed');
      assert.equal(setup.onboarding.mirrorOnboarding.required, false);
      assert.equal(setup.onboarding.mirrorOnboarding.blocking, false);
      assert.equal(setup.onboarding.phases.find((x) => x.name === 'mirror_setup').status, 'skipped');
      assert.equal(setup.onboarding.phases.find((x) => x.name === 'notion_setup').status, 'completed');

      const doctor = runDoctor({ cwd: projectRoot });
      assert.equal(doctor.ok, true);
      assert.equal(doctor.checks.some((x) => x.name === 'mirror_onboarding'), false);
      assert.equal(doctor.checks.some((x) => x.name === 'notion_config' && x.ok), true);
      assert.equal(doctor.checks.some((x) => x.name === 'notion_connectivity' && x.ok), true);
    });
  });
});

test('notion doctor accepts compatible alias schema and write path uses mapped properties', async () => {
  const projectRoot = mkTempProject();
  const aliasMemorySchema = {
    object: 'data_source',
    id: 'memory-ds',
    properties: {
      Name: makeProperty('title'),
      MemoryId: makeProperty('rich_text'),
      MemoryType: makeProperty('select'),
      Content: makeProperty('rich_text'),
      Status: makeProperty('select'),
      Scope: makeProperty('select'),
      Project: makeProperty('rich_text'),
      Score: makeProperty('number'),
    },
  };

  await withMockNotionApi({
    schemaByDataSource: {
      'memory-ds': aliasMemorySchema,
    },
  }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      const setup = setupHippocore({
        cwd: projectRoot,
        mode: 'cloud',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      assert.equal(setup.ok, true);
      const doctor = runDoctor({ cwd: projectRoot });
      assert.equal(doctor.checks.some((x) => x.name === 'notion_schema_compatibility' && x.ok), true);

      const writeResult = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Decision',
            body: 'Use alias-schema compatible memory datasource mapping.',
          },
        ],
      });
      assert.equal(writeResult.ok, true);
      assert.equal(writeResult.failed, 0);
    });
  });
});

test('notion setup runs full backfill during onboarding and persists cursor', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({
    seedPagesByDataSource: {
      'docs-ds': [
        {
          id: '33333333-3333-3333-3333-000000000001',
          last_edited_time: '2026-01-04T08:00:00.000Z',
          properties: {
            Title: { title: [{ plain_text: 'Backfill Doc' }] },
            Body: { rich_text: [{ plain_text: 'Decision: import this page during setup backfill.' }] },
          },
        },
      ],
    },
  }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      const setup = setupHippocore({
        cwd: projectRoot,
        mode: 'cloud',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: true,
        installHooks: false,
      });

      assert.equal(setup.ok, true);
      assert.equal(setup.syncSummary.status, 'success');
      assert.equal(setup.syncSummary.notion.fullBackfill, true);
      assert.equal(setup.syncSummary.notion.importedCount, 1);
      assert.ok(setup.syncSummary.enrichmentStats);
      assert.equal(setup.syncSummary.enrichmentStats.ruleOnly >= 1, true);
      assert.equal(setup.onboarding.phases.find((x) => x.name === 'initial_sync').status, 'completed');

      const configAfter = loadConfig(projectRoot);
      assert.equal(configAfter.storage.notion.cursor, '2026-01-04T08:00:00.000Z');
      const dbPath = resolveConfiguredPath(projectRoot, configAfter.paths.db);
      const row = withDb(dbPath, (db) => db.prepare(`
        SELECT context_summary, meaning_summary, actionability_summary
        FROM memory_items
        WHERE source_record_id IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `).get());
      assert.ok(row);
      assert.equal(Boolean(row.context_summary || row.meaning_summary || row.actionability_summary), true);
    });
  });
});

test('notion mode write succeeds only after remote upsert and citation includes notionPageUrl', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const writeResult = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Decision',
            body: 'Use Notion as source of truth for memory.',
            confidence: 0.91,
          },
        ],
      });

      assert.equal(writeResult.ok, true);
      assert.equal(writeResult.failed, 0);
      assert.equal(writeResult.created, 1);

      const config = loadConfig(projectRoot);
      const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
      const row = withDb(dbPath, (db) => db.prepare(`
        SELECT id, state, notion_page_id
        FROM memory_items
        WHERE body LIKE '%source of truth%'
        ORDER BY id DESC
        LIMIT 1
      `).get());

      assert.ok(row);
      assert.equal(row.state, 'candidate');
      assert.ok(row.notion_page_id);

      const composed = composeMemory({
        cwd: projectRoot,
        query: 'source of truth memory notion',
        projectId: 'alpha',
        tokenBudget: 800,
      });
      assert.ok(composed.citations.length > 0);
      assert.equal(
        composed.citations.some((citation) => String(citation.notionPageUrl || '').startsWith('https://www.notion.so/')),
        true,
      );
      assert.equal(
        composed.citations.some((citation) => citation.contextSummary || citation.meaningSummary || citation.actionabilitySummary),
        true,
      );
    });
  });
});

test('notion mode session-end runtime ingestion writes through to notion automatically', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const end = triggerSessionEnd({
        cwd: projectRoot,
        sessionKey: 'runtime-write-through-1',
        projectId: 'alpha',
        messages: [
          { role: 'user', content: 'Decision: enable webhook retries and keep the current backoff policy.' },
        ],
      });

      assert.equal(end.ok, true);
      assert.equal(end.syncSummary.status, 'success');
      assert.ok(end.syncSummary.notion);
      assert.equal(end.syncSummary.notion.writeThrough.attempted >= 1, true);
      assert.equal(end.syncSummary.notion.writeThrough.failed, 0);
      assert.equal(end.syncSummary.notion.writeThrough.succeeded >= 1, true);

      const config = loadConfig(projectRoot);
      const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
      const row = withDb(dbPath, (db) => db.prepare(`
        SELECT m.id, m.notion_page_id
        FROM memory_items m
        JOIN source_records s ON s.id = m.source_record_id
        WHERE s.source_path LIKE 'session_end:runtime-write-through-1:%'
        ORDER BY m.id DESC
        LIMIT 1
      `).get());
      assert.ok(row);
      assert.ok(row.notion_page_id);
    });
  });
});

test('notion mode checkpoint write-through failures are partial and enqueue outbox entries', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({ failCreate: true }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const checkpoint = triggerSessionCheckpoint({
        cwd: projectRoot,
        sessionKey: 'runtime-write-through-fail-1',
        projectId: 'alpha',
        checkpointId: 'cp-1',
        messages: [
          { role: 'user', messageId: 'u-1', content: 'Decision: keep retry queue enabled for webhook delivery.' },
        ],
      });

      assert.equal(checkpoint.ok, true);
      assert.equal(checkpoint.syncSummary.status, 'partial');
      assert.ok(checkpoint.syncSummary.notion);
      assert.equal(checkpoint.syncSummary.notion.writeThrough.attempted >= 1, true);
      assert.equal(checkpoint.syncSummary.notion.writeThrough.failed >= 1, true);
      assert.equal(checkpoint.syncSummary.notion.writeThrough.outboxEnqueued >= 1, true);
      assert.equal(
        (checkpoint.syncSummary.errors || []).some((entry) => entry.phase === 'write_through'),
        true,
      );

      const config = loadConfig(projectRoot);
      const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
      const stateRow = withDb(dbPath, (db) => db.prepare(`
        SELECT m.state
        FROM memory_items m
        JOIN source_records s ON s.id = m.source_record_id
        WHERE s.source_path LIKE 'session_checkpoint:runtime-write-through-fail-1:%'
        ORDER BY m.id DESC
        LIMIT 1
      `).get());
      assert.ok(stateRow);
      assert.equal(stateRow.state, 'pending_remote');

      const outboxCount = withDb(dbPath, (db) => db.prepare(`
        SELECT COUNT(*) AS c
        FROM notion_outbox
        WHERE status IN ('pending', 'failed')
      `).get().c);
      assert.equal(outboxCount >= 1, true);
    });
  });
});

test('notion runSync auto-flushes outbox and recovers pending_remote checkpoint memories', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const originalCreatePageSync = NotionClient.prototype.createPageSync;
      let failRemaining = 100;
      NotionClient.prototype.createPageSync = function wrappedCreatePageSync(args) {
        if (failRemaining > 0) {
          failRemaining -= 1;
          throw new Error('Notion API error: mock_transient_write_failure');
        }
        return originalCreatePageSync.call(this, args);
      };

      try {
        const first = triggerSessionCheckpoint({
          cwd: projectRoot,
          sessionKey: 'runtime-outbox-retry-1',
          projectId: 'alpha',
          checkpointId: 'cp-1',
          messages: [
            { role: 'user', messageId: 'u-1', content: 'Decision: outbox retry should recover this runtime memory.' },
          ],
        });

        assert.equal(first.ok, true);
        assert.equal(first.syncSummary.status, 'partial');
        assert.equal(first.syncSummary.notion.writeThrough.failed >= 1, true);
        assert.equal(first.syncSummary.notion.writeThrough.outboxPending >= 1, true);

        failRemaining = 0;
        const second = runSync({
          cwd: projectRoot,
          includeConfiguredSources: false,
          explicitSources: [],
        });

        assert.equal(second.status, 'success');
        assert.ok(second.notion);
        assert.equal(second.notion.writeThrough.outboxFlushed >= 1, true);
        assert.equal(second.notion.writeThrough.outboxPending, 0);

        const config = loadConfig(projectRoot);
        const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
        const row = withDb(dbPath, (db) => db.prepare(`
          SELECT m.state, m.notion_page_id
          FROM memory_items m
          JOIN source_records s ON s.id = m.source_record_id
          WHERE s.source_path LIKE 'session_checkpoint:runtime-outbox-retry-1:%'
          ORDER BY m.id DESC
          LIMIT 1
        `).get());
        assert.ok(row);
        assert.equal(row.state, 'candidate');
        assert.ok(row.notion_page_id);
      } finally {
        NotionClient.prototype.createPageSync = originalCreatePageSync;
      }
    });
  });
});

test('notion write-through stays idempotent for repeated ingestion of the same checkpoint', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async ({ pagesByDataSource }) => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const text = 'Decision: keep webhook retries enabled for payment callbacks.';
      const first = triggerSessionCheckpoint({
        cwd: projectRoot,
        sessionKey: 'runtime-idempotent-1',
        projectId: 'alpha',
        checkpointId: 'cp-1',
        messages: [
          { role: 'user', messageId: 'm-1', content: text },
        ],
      });
      const second = triggerSessionCheckpoint({
        cwd: projectRoot,
        sessionKey: 'runtime-idempotent-1',
        projectId: 'alpha',
        checkpointId: 'cp-1',
        messages: [
          { role: 'user', messageId: 'm-1', content: text },
        ],
      });

      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.syncSummary.status, 'success');
      assert.equal(second.skipped, true);
      assert.equal(second.reason, 'no_new_messages');
      assert.equal(second.syncSummary, null);

      const memoryPages = pagesByDataSource.get('memory-ds') || [];
      assert.equal(memoryPages.length, 1);

      const config = loadConfig(projectRoot);
      const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
      const distinctPageIds = withDb(dbPath, (db) => db.prepare(`
        SELECT COUNT(DISTINCT notion_page_id) AS c
        FROM memory_items
        WHERE body LIKE '%webhook retries enabled%'
          AND notion_page_id IS NOT NULL
      `).get());
      assert.equal(distinctPageIds.c, 1);
    });
  });
});

test('notion write failure stays pending_remote, writes outbox, and is excluded from retrieval', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({ failCreate: true }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const writeResult = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          {
            type: 'Task',
            body: 'Task: test pending remote behavior under notion failure.',
          },
        ],
      });

      assert.equal(writeResult.ok, false);
      assert.equal(writeResult.failed, 1);
      assert.equal(writeResult.created, 0);

      const retrieval = retrieveMemory({
        cwd: projectRoot,
        query: 'pending remote behavior notion failure',
        projectId: 'alpha',
        tokenBudget: 800,
        includeCandidate: true,
      });
      assert.equal(retrieval.usedItems, 0);

      const config = loadConfig(projectRoot);
      const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);
      const stateRow = withDb(dbPath, (db) => db.prepare(`
        SELECT state FROM memory_items
        WHERE body LIKE '%pending remote behavior%'
        ORDER BY id DESC
        LIMIT 1
      `).get());
      assert.equal(stateRow.state, 'pending_remote');

      const outboxCount = withDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS c FROM notion_outbox').get().c);
      assert.equal(outboxCount >= 1, true);
    });
  });
});

test('notion incremental sync only ingests pages newer than cursor', async () => {
  const projectRoot = mkTempProject();
  await withMockNotionApi({
    seedPagesByDataSource: {
      'docs-ds': [
        {
          id: '22222222-2222-2222-2222-000000000001',
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: {
            Title: {
              title: [{ plain_text: 'Old Doc' }],
            },
            Body: {
              rich_text: [{ plain_text: 'Old content should be skipped.' }],
            },
          },
        },
        {
          id: '22222222-2222-2222-2222-000000000002',
          last_edited_time: '2026-01-02T00:00:00.000Z',
          properties: {
            Title: {
              title: [{ plain_text: 'New Doc' }],
            },
            Body: {
              rich_text: [{ plain_text: 'Decision: ingest this new notion page.' }],
            },
          },
        },
      ],
    },
  }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const cfg = loadConfig(projectRoot);
      cfg.storage.notion.cursor = '2026-01-01T00:00:00.000Z';
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const syncResult = runSync({ cwd: projectRoot });
      assert.equal(syncResult.status, 'success');
      assert.equal(syncResult.notion.importedCount, 1);
      assert.equal(syncResult.projection.skipped, true);

      const configAfter = loadConfig(projectRoot);
      assert.equal(configAfter.storage.notion.cursor, '2026-01-02T00:00:00.000Z');

      const dbPath = resolveConfiguredPath(projectRoot, configAfter.paths.db);
      const notionSources = withDb(dbPath, (db) => db.prepare(`
        SELECT source_path
        FROM source_records
        WHERE source_type = 'notion'
        ORDER BY source_path ASC
      `).all());
      assert.equal(notionSources.length, 1);
      assert.match(notionSources[0].source_path, /000000000002/);
    });
  });
});

test('notion migrate supports checkpoint resume with batch processing', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({}, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'local',
        runInitialSync: false,
        installHooks: false,
      });

      const writeResult = writeMemory({
        cwd: projectRoot,
        projectId: 'alpha',
        items: [
          { type: 'Decision', body: 'Decision: migrate checkpoint row one.' },
          { type: 'Decision', body: 'Decision: migrate checkpoint row two.' },
          { type: 'Decision', body: 'Decision: migrate checkpoint row three.' },
        ],
      });
      assert.equal(writeResult.ok, true);
      assert.equal(writeResult.failed, 0);

      const cfg = loadConfig(projectRoot);
      cfg.storage.mode = 'notion';
      cfg.storage.notion = {
        ...(cfg.storage.notion || {}),
        memoryDataSourceId: 'memory-ds',
        relationsDataSourceId: 'relations-ds',
        docDataSourceIds: ['docs-ds'],
      };
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const originalCreatePageSync = NotionClient.prototype.createPageSync;
      let createCount = 0;
      NotionClient.prototype.createPageSync = function wrappedCreatePageSync(args) {
        createCount += 1;
        if (createCount === 2) {
          throw new Error('mock_migrate_checkpoint_failure');
        }
        return originalCreatePageSync.call(this, args);
      };

      try {
        assert.throws(
          () => migrateNotionMemory({ cwd: projectRoot, full: true, batchSize: 1, resume: true }),
          /mock_migrate_checkpoint_failure/,
        );
      } finally {
        NotionClient.prototype.createPageSync = originalCreatePageSync;
      }

      const configAfterFail = loadConfig(projectRoot);
      const dbPathAfterFail = resolveConfiguredPath(projectRoot, configAfterFail.paths.db);
      const failedState = withDb(dbPathAfterFail, (db) => db.prepare(`
        SELECT value
        FROM notion_sync_state
        WHERE key = 'notion_migrate_status'
      `).get());
      assert.equal((failedState && failedState.value) || null, 'failed');

      const resumed = migrateNotionMemory({ cwd: projectRoot, full: true, batchSize: 1, resume: true });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.resume.enabled, true);
      assert.equal(resumed.resume.resumed, true);
      assert.equal(resumed.resume.startMemoryId >= 1, true);
      assert.equal(resumed.migration.progress.batchSize, 1);
      assert.equal(resumed.migrateState.status, 'completed');

      const configAfterResume = loadConfig(projectRoot);
      const dbPathAfterResume = resolveConfiguredPath(projectRoot, configAfterResume.paths.db);
      const syncedCount = withDb(dbPathAfterResume, (db) => db.prepare(`
        SELECT COUNT(*) AS c
        FROM memory_items
        WHERE notion_page_id IS NOT NULL AND notion_page_id != ''
      `).get().c);
      assert.equal(syncedCount, 3);
    });
  });
});

test('notion poller runs incremental sync in serve mode and exposes status', async () => {
  const projectRoot = mkTempProject();

  await withMockNotionApi({
    seedPagesByDataSource: {
      'docs-ds': [
        {
          id: '99999999-9999-9999-9999-000000000001',
          last_edited_time: '2026-03-06T08:00:00.000Z',
          properties: {
            Title: {
              title: [{ plain_text: 'Poller Seed Doc' }],
            },
            Body: {
              rich_text: [{ plain_text: 'Decision: poller should ingest incremental notion updates.' }],
            },
          },
        },
      ],
    },
  }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const cfg = loadConfig(projectRoot);
      cfg.storage.notion.pollIntervalSec = 1;
      saveConfig(projectRoot, cfg, {
        configPath: cfg.__meta && cfg.__meta.configPath ? cfg.__meta.configPath : undefined,
      });

      const server = startServer({
        cwd: projectRoot,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 1400));

        const status = getNotionStatus({ cwd: projectRoot });
        assert.ok(status.poller);
        assert.equal(status.poller.configured, true);
        assert.equal(status.poller.runtimeActive, true);
        assert.equal(status.poller.configuredIntervalSec, 1);
        assert.equal(
          ['idle', 'running', 'success', 'partial', 'failed', 'skipped_busy'].includes(String(status.poller.state.lastStatus || '')),
          true,
        );
        assert.equal(Boolean(status.poller.state.lastStartedAt || status.poller.state.lastFinishedAt), true);

        const configAfter = loadConfig(projectRoot);
        const dbPath = resolveConfiguredPath(projectRoot, configAfter.paths.db);
        const importedSources = withDb(dbPath, (db) => db.prepare(`
          SELECT COUNT(*) AS c
          FROM source_records
          WHERE source_type = 'notion'
        `).get().c);
        assert.equal(importedSources >= 1, true);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
      const afterClose = getNotionStatus({ cwd: projectRoot });
      assert.equal(afterClose.poller.runtimeActive, false);
    });
  });
});

test('notion watchRoots recursively imports descendant pages under root page', async () => {
  const projectRoot = mkTempProject();
  const rootPageId = '66666666-6666-6666-6666-000000000001';
  const childPageId = '66666666-6666-6666-6666-000000000002';
  const childParagraphId = '77777777-7777-7777-7777-000000000001';

  await withMockNotionApi({
    seedPagesByDataSource: {
      'watch-seed': [
        {
          id: rootPageId,
          last_edited_time: '2026-03-01T00:00:00.000Z',
          properties: {
            Title: {
              title: [{ plain_text: 'Root Hub Page' }],
            },
          },
        },
        {
          id: childPageId,
          last_edited_time: '2026-03-01T01:00:00.000Z',
          properties: {
            Title: {
              title: [{ plain_text: 'Child Subpage' }],
            },
          },
        },
      ],
    },
    seedBlocksByParent: {
      [rootPageId]: [
        {
          object: 'block',
          id: childPageId,
          type: 'child_page',
          child_page: { title: 'Child Subpage' },
          has_children: false,
        },
      ],
      [childPageId]: [
        {
          object: 'block',
          id: childParagraphId,
          type: 'paragraph',
          paragraph: {
            rich_text: [{ plain_text: 'Decision: descendant page should be imported via watch root recursion.' }],
          },
          has_children: false,
        },
      ],
    },
  }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionWatchRoots: `page:${rootPageId}`,
        runInitialSync: false,
        installHooks: false,
      });

      const syncResult = runSync({ cwd: projectRoot });
      assert.equal(syncResult.status, 'success');
      assert.equal(syncResult.notion.importedCount >= 2, true);

      const composed = composeMemory({
        cwd: projectRoot,
        query: 'descendant page imported watch root recursion',
        tokenBudget: 900,
      });
      const citation = composed.citations.find((item) => String(item.sourcePath || '').includes(childPageId));
      assert.ok(citation);
      assert.match(String(citation.sourceSnippet || ''), /watch root recursion/i);
    });
  });
});

test('notion imported memories expose page url, block anchor, and source snippet in citations', async () => {
  const projectRoot = mkTempProject();
  const pageId = '44444444-4444-4444-4444-000000000001';
  const blockId = '55555555-5555-5555-5555-000000000001';

  await withMockNotionApi({
    seedPagesByDataSource: {
      'docs-ds': [
        {
          id: pageId,
          last_edited_time: '2026-02-01T00:00:00.000Z',
          properties: {
            Title: {
              title: [{ plain_text: 'Ops Runbook' }],
            },
          },
        },
      ],
    },
    seedBlocksByParent: {
      [pageId]: [
        {
          object: 'block',
          id: blockId,
          type: 'paragraph',
          paragraph: {
            rich_text: [{ plain_text: 'Decision: operations runbook is the canonical rollback procedure.' }],
          },
          has_children: false,
        },
      ],
    },
  }, async () => {
    await withEnv({
      NOTION_API_KEY: 'mock-token',
      HIPPOCORE_NOTION_BASE_URL: null,
    }, async () => {
      setupHippocore({
        cwd: projectRoot,
        mode: 'local',
        storage: 'notion',
        notionMemoryDataSourceId: 'memory-ds',
        notionRelationsDataSourceId: 'relations-ds',
        notionDocDataSourceIds: 'docs-ds',
        runInitialSync: false,
        installHooks: false,
      });

      const syncResult = runSync({ cwd: projectRoot });
      assert.equal(syncResult.status, 'success');
      assert.equal(syncResult.notion.importedCount, 1);

      const composed = composeMemory({
        cwd: projectRoot,
        query: 'rollback procedure canonical runbook',
        tokenBudget: 900,
      });
      const citation = composed.citations.find((item) => String(item.sourcePath || '').startsWith('notion:'));
      assert.ok(citation);
      assert.equal(String(citation.notionPageUrl || '').includes('#'), false);
      assert.equal(String(citation.notionBlockUrl || '').includes('#'), true);
      assert.equal(citation.notionBlockAnchor, blockId);
      assert.match(String(citation.sourceUrl || ''), /https:\/\/www\.notion\.so\//);
      assert.match(String(citation.sourceSnippet || ''), /rollback procedure/i);
    });
  });
});
