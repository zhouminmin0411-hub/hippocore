#!/usr/bin/env node
'use strict';

const path = require('path');
const { triggerSessionStart } = require('../src/service');

const cwd = process.env.HIPPOCORE_PROJECT_ROOT
  ? path.resolve(process.env.HIPPOCORE_PROJECT_ROOT)
  : (process.env.MEMORY_PROJECT_ROOT ? path.resolve(process.env.MEMORY_PROJECT_ROOT) : process.cwd());

try {
  const sessionKey = process.env.OPENCLAW_SESSION_ID || process.env.SESSION_ID || `${Date.now()}`;
  const projectId = process.env.OPENCLAW_PROJECT_ID || process.env.PROJECT_ID || null;
  const result = triggerSessionStart({ cwd, sessionKey, projectId, tokenBudget: 900 });

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: result.context.text,
    },
  }));
} catch {
  process.exit(0);
}
