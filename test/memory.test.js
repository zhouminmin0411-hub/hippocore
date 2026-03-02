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
  triggerSessionEnd,
  createBackup,
  restoreBackup,
  mirrorHippocore,
  completeMirrorOnboarding,
  getMirrorStatus,
  runDoctor,
} = require('../src/service');
const { withDb } = require('../src/db');
const { loadConfig, saveConfig, resolveConfiguredPath } = require('../src/config');
const { NotionClient } = require('../src/notion/client');

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

function richTextValue(prop) {
  if (!prop || typeof prop !== 'object') return '';
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((x) => x.plain_text || x.text?.content || '').join(' ').trim();
  if (Array.isArray(prop.title)) return prop.title.map((x) => x.plain_text || x.text?.content || '').join(' ').trim();
  return '';
}

async function withMockNotionApi({
  seedPagesByDataSource = {},
  seedBlocksByParent = {},
  failCreate = false,
} = {}, fn) {
  const pagesByDataSource = new Map();
  const pagesById = new Map();
  const blocksByParent = new Map();
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

  const originals = {
    usersMeSync: NotionClient.prototype.usersMeSync,
    queryDataSourceSync: NotionClient.prototype.queryDataSourceSync,
    createPageSync: NotionClient.prototype.createPageSync,
    updatePageSync: NotionClient.prototype.updatePageSync,
    retrieveBlockChildrenSync: NotionClient.prototype.retrieveBlockChildrenSync,
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
    const existing = pagesById.get(pageId);
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
    NotionClient.prototype.createPageSync = originals.createPageSync;
    NotionClient.prototype.updatePageSync = originals.updatePageSync;
    NotionClient.prototype.retrieveBlockChildrenSync = originals.retrieveBlockChildrenSync;
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
      assert.equal(setup.onboarding.phases.find((x) => x.name === 'initial_sync').status, 'completed');

      const configAfter = loadConfig(projectRoot);
      assert.equal(configAfter.storage.notion.cursor, '2026-01-04T08:00:00.000Z');
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
      assert.equal(String(citation.notionPageUrl || '').includes('#'), true);
      assert.equal(citation.notionBlockAnchor, blockId);
      assert.match(String(citation.sourceSnippet || ''), /rollback procedure/i);
    });
  });
});
