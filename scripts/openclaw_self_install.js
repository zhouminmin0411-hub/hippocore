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
  const runInitialSync = !hasFlag(args, '--no-sync');
  const installHooks = !hasFlag(args, '--no-install-hooks');

  try {
    const result = setupHippocore({
      cwd,
      openclawHome,
      obsidianVault,
      sessionsPath,
      mode,
      runInitialSync,
      installHooks,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

main();
