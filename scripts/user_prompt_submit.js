#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { triggerUserPromptSubmit } = require('../src/service');

const cwd = process.env.HIPPOCORE_PROJECT_ROOT
  ? path.resolve(process.env.HIPPOCORE_PROJECT_ROOT)
  : (process.env.MEMORY_PROJECT_ROOT ? path.resolve(process.env.MEMORY_PROJECT_ROOT) : process.cwd());

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}

const text = (input || '').trim();
if (!text) process.exit(0);

try {
  const sessionKey = process.env.OPENCLAW_SESSION_ID || process.env.SESSION_ID || 'unknown-session';
  const projectId = process.env.OPENCLAW_PROJECT_ID || process.env.PROJECT_ID || null;
  const messageId = process.env.OPENCLAW_MESSAGE_ID || `${Date.now()}`;
  triggerUserPromptSubmit({ cwd, sessionKey, projectId, messageId, text });
  process.exit(0);
} catch {
  process.exit(0);
}
