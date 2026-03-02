#!/usr/bin/env node
'use strict';

const path = require('path');
const { setupHippocore } = require('../src/service');

function parseFlag(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function main() {
  const args = process.argv.slice(2);

  const cwd = path.resolve(parseFlag(args, '--project-root', process.cwd()));
  const openclawHome = parseFlag(args, '--openclaw-home', process.env.OPENCLAW_HOME || null);
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

  try {
    const result = setupHippocore({
      cwd,
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
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write('Hippocore setup is not complete. Follow onboarding.nextActions before treating install as successful.\n');
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

main();
