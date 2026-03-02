#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
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
  mirrorHippocore,
  completeMirrorOnboarding,
  getMirrorStatus,
  getNotionStatus,
  syncNotionSources,
  migrateNotionMemory,
  startServer,
} = require('../src/service');

function printHelp() {
  console.log([
    'Hippocore CLI',
    '',
    'Usage:',
    '  hippocore init',
    '  hippocore setup [--project-root DIR] [--openclaw-home DIR] [--obsidian-vault DIR] [--sessions DIR] [--mode auto|local|cloud] [--storage local|notion] [--notion-memory-datasource-id ID] [--notion-doc-datasource-ids ID1,ID2 (required for notion)] [--notion-relations-datasource-id ID] [--notion-poll-interval-sec N] [--no-sync] [--no-install-hooks]',
    '  hippocore install [same args as setup]',
    '  hippocore openclaw-install [--project-root DIR] [--openclaw-home DIR] [--obsidian-vault DIR] [--sessions DIR] [--mode auto|local|cloud] [--storage local|notion] [--notion-memory-datasource-id ID] [--notion-doc-datasource-ids ID1,ID2 (required for notion)] [--notion-relations-datasource-id ID] [--notion-poll-interval-sec N] [--no-sync] [--no-install-hooks]',
    '  hippocore upgrade [--project-root DIR] [--openclaw-home DIR] [--obsidian-vault DIR] [--sessions DIR] [--mode auto|local|cloud] [--storage local|notion] [--notion-memory-datasource-id ID] [--notion-doc-datasource-ids ID1,ID2 (required for notion)] [--notion-relations-datasource-id ID] [--notion-poll-interval-sec N] [--skip-backup] [--no-sync] [--no-install-hooks]',
    '  hippocore uninstall --yes [--project-root DIR] [--openclaw-home DIR] [--drop-data] [--keep-hooks]',
    '  hippocore connect obsidian <vaultPath>',
    '  hippocore connect clawdbot <transcriptsPath>',
    '  hippocore sync',
    '  hippocore query <text> [--project ID] [--scope type1,type2] [--token-budget N]',
    '  hippocore retrieve <text> [--project ID] [--types t1,t2] [--token-budget N] [--no-candidate]',
    '  hippocore compose <text> [--project ID] [--types t1,t2] [--token-budget N] [--no-candidate]',
    '  hippocore write [--project ID] [--status candidate] [--file /path/to/items.json]',
    '  hippocore review promote --ids 1,2,3 [--reason TEXT]',
    '  hippocore review archive --ids 1,2,3 [--reason TEXT]',
    '  hippocore pack build [--project ID] [--type startup]',
    '  hippocore doctor',
    '  hippocore backup [targetDir]',
    '  hippocore restore <backupDir>',
    '  hippocore trigger session-start [--session KEY] [--project ID] [--token-budget N]',
    '  hippocore trigger user-prompt-submit [--session KEY] [--project ID] [--message-id ID] [--text TEXT]',
    '  hippocore trigger assistant-message [--session KEY] [--project ID] [--message-id ID] [--text TEXT]',
    '  hippocore trigger session-end [--session KEY] [--project ID] [--messages-file /path/to/messages.json]',
    '  hippocore mirror pull --remote user@host:/abs/path/to/hippocore [--local DIR] [--dry-run] [--delete]',
    '  hippocore mirror push --remote user@host:/abs/path/to/hippocore [--local DIR] [--dry-run] [--delete]',
    '  hippocore mirror sync --remote user@host:/abs/path/to/hippocore [--local DIR] [--prefer local|remote] [--dry-run] [--delete]',
    '  hippocore mirror status',
    '  hippocore mirror complete [--remote user@host:/abs/path/to/hippocore] [--local DIR] [--note TEXT]',
    '  hippocore notion status',
    '  hippocore notion sync',
    '  hippocore notion migrate --full',
    '  hippocore serve [--host HOST] [--port PORT]',
    '',
    'Compatibility: the legacy `memory` command is still supported via alias.',
  ].join('\n'));
}

function parseFlag(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function parseListFlag(args, name) {
  const raw = parseFlag(args, name, '');
  if (!raw) return [];
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
}

function parseIds(args) {
  const ids = parseListFlag(args, '--ids').map((v) => Number(v)).filter((v) => Number.isFinite(v));
  return ids;
}

async function readJsonInput(filePath) {
  if (filePath) {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    return JSON.parse(raw);
  }

  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join('').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const cwd = process.cwd();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  try {
    if (cmd === 'init') {
      const result = initProject({ cwd });
      console.log(`Initialized hippocore at ${path.join(result.projectRoot, 'hippocore')}`);
      console.log(`Config: ${result.configPath}`);
      console.log(`DB: ${result.dbPath}`);
      return;
    }

    if (cmd === 'setup' || cmd === 'install' || cmd === 'openclaw-install') {
      const setupCwd = path.resolve(parseFlag(args, '--project-root', cwd));
      const openclawHome = parseFlag(args, '--openclaw-home', null);
      const obsidianVault = parseFlag(args, '--obsidian-vault', null);
      const sessionsPath = parseFlag(args, '--sessions', null);
      const mode = parseFlag(args, '--mode', 'auto');
      const storage = parseFlag(args, '--storage', null);
      const notionMemoryDataSourceId = parseFlag(args, '--notion-memory-datasource-id', null);
      const notionRelationsDataSourceId = parseFlag(args, '--notion-relations-datasource-id', null);
      const notionDocDataSourceIds = parseFlag(args, '--notion-doc-datasource-ids', null);
      const notionPollIntervalSec = parseFlag(args, '--notion-poll-interval-sec', null);
      const runInitialSync = !hasFlag(args, '--no-sync');
      const installHooks = !hasFlag(args, '--no-install-hooks');

      const result = setupHippocore({
        cwd: setupCwd,
        openclawHome,
        obsidianVault,
        sessionsPath,
        mode,
        storage,
        notionMemoryDataSourceId,
        notionRelationsDataSourceId,
        notionDocDataSourceIds,
        notionPollIntervalSec,
        runInitialSync,
        installHooks,
      });

      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) {
        if (
          result.onboarding
          && result.onboarding.installStatus === 'blocked_notion_required'
          && result.notionOnboarding
          && result.notionOnboarding.docSourcesConfigured === false
        ) {
          console.error('Notion onboarding blocked: --notion-doc-datasource-ids is required before install can complete.');
          console.error(`Fix command: hippocore setup --project-root ${setupCwd} --storage notion --notion-memory-datasource-id <memory_ds_id> --notion-doc-datasource-ids <docs_ds_id_1,docs_ds_id_2>`);
        }
        process.exitCode = 2;
      }
      return;
    }

    if (cmd === 'upgrade') {
      const setupCwd = path.resolve(parseFlag(args, '--project-root', cwd));
      const openclawHome = parseFlag(args, '--openclaw-home', null);
      const obsidianVault = parseFlag(args, '--obsidian-vault', null);
      const sessionsPath = parseFlag(args, '--sessions', null);
      const mode = parseFlag(args, '--mode', 'auto');
      const storage = parseFlag(args, '--storage', null);
      const notionMemoryDataSourceId = parseFlag(args, '--notion-memory-datasource-id', null);
      const notionRelationsDataSourceId = parseFlag(args, '--notion-relations-datasource-id', null);
      const notionDocDataSourceIds = parseFlag(args, '--notion-doc-datasource-ids', null);
      const notionPollIntervalSec = parseFlag(args, '--notion-poll-interval-sec', null);
      const runInitialSync = !hasFlag(args, '--no-sync');
      const installHooks = !hasFlag(args, '--no-install-hooks');
      const createDataBackup = !hasFlag(args, '--skip-backup');

      const result = upgradeHippocore({
        cwd: setupCwd,
        openclawHome,
        obsidianVault,
        sessionsPath,
        mode,
        storage,
        notionMemoryDataSourceId,
        notionRelationsDataSourceId,
        notionDocDataSourceIds,
        notionPollIntervalSec,
        runInitialSync,
        installHooks,
        createDataBackup,
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 2;
      return;
    }

    if (cmd === 'uninstall') {
      if (!hasFlag(args, '--yes')) {
        throw new Error('Usage: hippocore uninstall --yes [--project-root DIR] [--openclaw-home DIR] [--drop-data] [--keep-hooks]');
      }
      const setupCwd = path.resolve(parseFlag(args, '--project-root', cwd));
      const openclawHome = parseFlag(args, '--openclaw-home', null);
      const keepData = !hasFlag(args, '--drop-data');
      const keepHooks = hasFlag(args, '--keep-hooks');

      const result = uninstallHippocore({
        cwd: setupCwd,
        openclawHome,
        keepData,
        keepHooks,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'connect') {
      const source = args[1];
      const sourcePath = args[2];
      if (!source || !sourcePath) {
        throw new Error('Usage: hippocore connect <obsidian|clawdbot> <path>');
      }
      const result = connectSource({ cwd, source, sourcePath });
      console.log(`Connected ${source} -> ${result.path}`);
      return;
    }

    if (cmd === 'sync') {
      const result = runSync({ cwd });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'query') {
      const text = args[1];
      if (!text) throw new Error('Usage: hippocore query <text> [--project ...] [--scope ...] [--token-budget N]');
      const scope = parseListFlag(args, '--scope');
      const projectId = parseFlag(args, '--project', null);
      const tokenBudget = Number(parseFlag(args, '--token-budget', '1200'));
      const result = queryMemory({ cwd, query: text, scope, tokenBudget, projectId });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'retrieve') {
      const text = args[1];
      if (!text) throw new Error('Usage: hippocore retrieve <text> [--project ...] [--types ...] [--token-budget N]');
      const types = parseListFlag(args, '--types');
      const projectId = parseFlag(args, '--project', null);
      const tokenBudget = Number(parseFlag(args, '--token-budget', '1200'));
      const includeCandidate = !hasFlag(args, '--no-candidate');
      const result = retrieveMemory({
        cwd,
        query: text,
        projectId,
        types,
        tokenBudget,
        includeCandidate,
        scopePolicy: 'layered',
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'compose') {
      const text = args[1];
      if (!text) throw new Error('Usage: hippocore compose <text> [--project ...] [--types ...] [--token-budget N]');
      const types = parseListFlag(args, '--types');
      const projectId = parseFlag(args, '--project', null);
      const tokenBudget = Number(parseFlag(args, '--token-budget', '1200'));
      const includeCandidate = !hasFlag(args, '--no-candidate');
      const result = composeMemory({
        cwd,
        query: text,
        projectId,
        types,
        tokenBudget,
        includeCandidate,
        scopePolicy: 'layered',
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'write') {
      const projectId = parseFlag(args, '--project', null);
      const statusHint = parseFlag(args, '--status', 'candidate');
      const file = parseFlag(args, '--file', null);
      const payload = await readJsonInput(file);
      const items = Array.isArray(payload) ? payload : (payload && payload.items) || [];
      const result = writeMemory({ cwd, projectId, items, statusHint });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'review') {
      const action = args[1];
      const ids = parseIds(args);
      const reason = parseFlag(args, '--reason', '');
      if (!ids.length) throw new Error('Usage: hippocore review <promote|archive> --ids 1,2,3 [--reason ...]');

      if (action === 'promote') {
        const result = reviewPromote({ cwd, itemIds: ids, reason });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (action === 'archive') {
        const result = reviewArchive({ cwd, itemIds: ids, reason });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      throw new Error('Usage: hippocore review <promote|archive> --ids ...');
    }

    if (cmd === 'pack') {
      const action = args[1];
      if (action !== 'build') {
        throw new Error('Usage: hippocore pack build [--project ID] [--type startup]');
      }
      const projectId = parseFlag(args, '--project', 'main');
      const packType = parseFlag(args, '--type', 'startup');
      const result = buildMemoryPack({ cwd, projectId, packType });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'doctor') {
      const result = runDoctor({ cwd });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (cmd === 'backup') {
      const targetDir = args[1] ? path.resolve(args[1]) : null;
      const result = createBackup({ cwd, targetDir });
      console.log(`Backup created: ${result.backupDir}`);
      return;
    }

    if (cmd === 'restore') {
      const backupDir = args[1];
      if (!backupDir) throw new Error('Usage: hippocore restore <backupDir>');
      const result = restoreBackup({ cwd, backupDir: path.resolve(backupDir) });
      console.log(`Restore complete from: ${result.backupDir}`);
      return;
    }

    if (cmd === 'trigger') {
      const triggerType = args[1];
      if (triggerType === 'session-start') {
        const sessionKey = parseFlag(args, '--session', 'unknown-session');
        const projectId = parseFlag(args, '--project', null);
        const tokenBudget = Number(parseFlag(args, '--token-budget', '600'));
        const result = triggerSessionStart({ cwd, sessionKey, tokenBudget, projectId });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (triggerType === 'user-prompt-submit') {
        const sessionKey = parseFlag(args, '--session', 'unknown-session');
        const projectId = parseFlag(args, '--project', null);
        const messageId = parseFlag(args, '--message-id', `${Date.now()}`);
        let text = parseFlag(args, '--text', null);
        if (!text) {
          const chunks = [];
          process.stdin.setEncoding('utf8');
          for await (const chunk of process.stdin) chunks.push(chunk);
          text = chunks.join('').trim();
        }
        if (!text) throw new Error('No prompt text provided. Use --text or stdin.');
        const result = triggerUserPromptSubmit({ cwd, sessionKey, messageId, text, projectId });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (triggerType === 'assistant-message') {
        const sessionKey = parseFlag(args, '--session', 'unknown-session');
        const projectId = parseFlag(args, '--project', null);
        const messageId = parseFlag(args, '--message-id', `${Date.now()}`);
        let text = parseFlag(args, '--text', null);
        if (!text) {
          const chunks = [];
          process.stdin.setEncoding('utf8');
          for await (const chunk of process.stdin) chunks.push(chunk);
          text = chunks.join('').trim();
        }
        if (!text) throw new Error('No assistant text provided. Use --text or stdin.');
        const result = triggerAssistantMessage({ cwd, sessionKey, messageId, text, projectId });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (triggerType === 'session-end') {
        const sessionKey = parseFlag(args, '--session', 'unknown-session');
        const projectId = parseFlag(args, '--project', null);
        const messagesFile = parseFlag(args, '--messages-file', null);
        let messages = null;
        if (messagesFile) {
          const raw = fs.readFileSync(path.resolve(messagesFile), 'utf8');
          messages = JSON.parse(raw);
        } else {
          const chunks = [];
          process.stdin.setEncoding('utf8');
          for await (const chunk of process.stdin) chunks.push(chunk);
          const raw = chunks.join('').trim();
          if (raw) messages = JSON.parse(raw);
        }

        const result = triggerSessionEnd({ cwd, sessionKey, projectId, messages });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      throw new Error('Usage: hippocore trigger <session-start|user-prompt-submit|assistant-message|session-end> ...');
    }

    if (cmd === 'serve') {
      const host = parseFlag(args, '--host', '127.0.0.1');
      const port = Number(parseFlag(args, '--port', '31337'));
      const server = startServer({ cwd, host, port });
      console.log(`Hippocore API listening on http://${host}:${port}`);
      const shutdown = () => server.close(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    if (cmd === 'mirror') {
      const action = args[1];
      if (!action) {
        throw new Error('Usage: hippocore mirror <pull|push|sync|status|complete> ...');
      }

      if (action === 'status') {
        const result = getMirrorStatus({ cwd });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (action === 'complete') {
        const remote = parseFlag(args, '--remote', null);
        const localPath = parseFlag(args, '--local', null);
        const note = parseFlag(args, '--note', null);
        const result = completeMirrorOnboarding({ cwd, remote, localPath, note });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const remote = parseFlag(args, '--remote', null);
      if (!remote) {
        throw new Error('Usage: hippocore mirror <pull|push|sync> --remote user@host:/abs/path/to/hippocore [--local DIR]');
      }

      const localPath = parseFlag(args, '--local', path.join(cwd, 'hippocore'));
      const prefer = parseFlag(args, '--prefer', 'remote');
      const dryRun = hasFlag(args, '--dry-run');
      const deleteExtra = hasFlag(args, '--delete');

      const result = mirrorHippocore({
        cwd,
        action,
        remote,
        localPath,
        prefer,
        dryRun,
        deleteExtra,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'notion') {
      const action = args[1];
      if (!action) throw new Error('Usage: hippocore notion <status|sync|migrate>');

      if (action === 'status') {
        const result = getNotionStatus({ cwd });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 2;
        return;
      }

      if (action === 'sync') {
        const result = syncNotionSources({ cwd });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 2;
        return;
      }

      if (action === 'migrate') {
        const full = hasFlag(args, '--full');
        const result = migrateNotionMemory({ cwd, full });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      throw new Error('Usage: hippocore notion <status|sync|migrate>');
    }

    throw new Error(`Unknown command: ${cmd}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
