#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { triggerSessionCheckpoint } = require('../src/service');

const cwd = process.env.HIPPOCORE_PROJECT_ROOT
  ? path.resolve(process.env.HIPPOCORE_PROJECT_ROOT)
  : (process.env.MEMORY_PROJECT_ROOT ? path.resolve(process.env.MEMORY_PROJECT_ROOT) : process.cwd());

function parseMessagesFromInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.messages)) return parsed.messages;
      if (Array.isArray(parsed.transcript)) return parsed.transcript;
      if (Array.isArray(parsed.history)) return parsed.history;
    }
  } catch {
    return null;
  }
  return null;
}

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  input = '';
}

try {
  const sessionKey = process.env.OPENCLAW_SESSION_ID || process.env.SESSION_ID || 'unknown-session';
  const projectId = process.env.OPENCLAW_PROJECT_ID || process.env.PROJECT_ID || null;
  const checkpointId = process.env.OPENCLAW_CHECKPOINT_ID || process.env.CHECKPOINT_ID || `${Date.now()}`;
  const messages = parseMessagesFromInput(input);
  const result = triggerSessionCheckpoint({ cwd, sessionKey, projectId, checkpointId, messages });

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionCheckpoint',
      result: {
        ok: result.ok,
        deduped: Boolean(result.deduped),
        skipped: Boolean(result.skipped),
      },
    },
  }));
} catch {
  process.exit(0);
}
