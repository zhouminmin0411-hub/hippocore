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
  createBackup,
  restoreBackup,
  mirrorHippocore,
} = require('../src/service');
const { withDb } = require('../src/db');
const { loadConfig, resolveConfiguredPath } = require('../src/config');

function mkTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippocore-'));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('init creates hippocore workspace layout', () => {
  const projectRoot = mkTempProject();
  const out = initProject({ cwd: projectRoot });

  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/global')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/projects')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/imports/obsidian')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/imports/chats')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/system/config/hippocore.config.json')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore/system/db/hippocore.db')), true);
  assert.equal(path.basename(out.configPath), 'hippocore.config.json');
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

  fs.mkdirSync(path.join(obsidianVault, '.obsidian'), { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const result = setupHippocore({
    cwd: projectRoot,
    openclawHome,
    obsidianVault,
    sessionsPath: sessionsDir,
    mode: 'cloud',
    runInitialSync: false,
    installHooks: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sources.obsidianVault, obsidianVault);
  assert.equal(result.sources.clawdbotTranscripts, sessionsDir);
  assert.equal(fs.existsSync(path.join(projectRoot, 'hippocore', 'projects', 'main', 'README.md')), true);
  assert.equal(fs.existsSync(path.join(openclawHome, 'agents', 'main', 'agent', 'hooks.json')), true);
  assert.equal(fs.existsSync(path.join(openclawHome, 'hippocore', 'openclaw.plugin.json')), true);
  assert.equal(result.onboarding.mirror.shouldRecommend, true);
  assert.equal(result.onboarding.mirror.suggestedTiming, 'after_setup_success');
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
