'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadPluginWithServiceMocks(overrides = {}) {
  const servicePath = require.resolve('../src/service');
  const pluginPath = require.resolve('../openclaw.plugin');
  const originalService = require(servicePath);

  delete require.cache[pluginPath];
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
      ...originalService,
      ...overrides,
    },
  };

  const plugin = require(pluginPath);

  delete require.cache[pluginPath];
  delete require.cache[servicePath];

  return plugin;
}

function makeApi() {
  const hooks = new Map();
  return {
    hooks,
    pluginConfig: { projectRoot: process.cwd() },
    runtime: { version: '2026.3.13' },
    on(eventName, handler) {
      hooks.set(eventName, handler);
    },
    registerTool() {},
  };
}

test('plugin registers supported OpenClaw 2026.3.13 lifecycle hooks', () => {
  const plugin = loadPluginWithServiceMocks();
  const api = makeApi();

  plugin.register(api);

  for (const hookName of ['session_start', 'session_end', 'message_received', 'llm_output']) {
    assert.equal(typeof api.hooks.get(hookName), 'function', `expected hook ${hookName}`);
  }
  for (const hookName of ['user_prompt_submit', 'assistant_message', 'session_checkpoint', 'command:new', 'message:received', 'command:close']) {
    assert.equal(api.hooks.has(hookName), false, `did not expect legacy hook ${hookName}`);
  }
});

test('message_received hook writes user messages via runtime session key', async () => {
  const calls = [];
  const plugin = loadPluginWithServiceMocks({
    triggerUserPromptSubmit(payload) {
      calls.push(payload);
      return { ok: true };
    },
  });
  const api = makeApi();

  plugin.register(api);
  const handler = api.hooks.get('message_received');

  await handler(
    {
      from: 'user-typed-1',
      content: 'remember this from typed hook',
      messageId: 'msg-typed-1',
    },
    {
      sessionKey: 'sess-typed-1',
    },
  );

  assert.deepEqual(calls, [
    {
      cwd: process.cwd(),
      sessionKey: 'sess-typed-1',
      projectId: null,
      messageId: 'msg-typed-1',
      text: 'remember this from typed hook',
    },
  ]);
});

test('message_received hook writes user messages via triggerUserPromptSubmit', async () => {
  const calls = [];
  const plugin = loadPluginWithServiceMocks({
    triggerUserPromptSubmit(payload) {
      calls.push(payload);
      return { ok: true };
    },
  });
  const api = makeApi();

  plugin.register(api);
  const handler = api.hooks.get('message_received');

  await handler(
    {
      from: 'user-1',
      content: 'remember this',
      messageId: 'msg-1',
    },
    {
      sessionKey: 'sess-1',
    },
  );

  assert.deepEqual(calls, [
    {
      cwd: process.cwd(),
      sessionKey: 'sess-1',
      projectId: null,
      messageId: 'msg-1',
      text: 'remember this',
    },
  ]);
});

test('llm_output hook writes assistant summaries via triggerAssistantMessage', async () => {
  const calls = [];
  const plugin = loadPluginWithServiceMocks({
    triggerAssistantMessage(payload) {
      calls.push(payload);
      return { ok: true };
    },
  });
  const api = makeApi();

  plugin.register(api);
  const handler = api.hooks.get('llm_output');

  await handler(
    {
      runId: 'run-1',
      assistantTexts: ['First answer', 'Second answer'],
    },
    {
      sessionKey: 'sess-2',
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, process.cwd());
  assert.equal(calls[0].sessionKey, 'sess-2');
  assert.equal(calls[0].messageId, 'run-1');
  assert.equal(calls[0].text, 'First answer\n\nSecond answer');
});

test('legacy hooks stay enabled on older runtimes', () => {
  const plugin = loadPluginWithServiceMocks();
  const api = makeApi();
  api.runtime.version = '2026.3.8';

  plugin.register(api);

  for (const hookName of ['command:new', 'message:received', 'command:close']) {
    assert.equal(typeof api.hooks.get(hookName), 'function', `expected legacy hook ${hookName}`);
  }
  for (const hookName of ['user_prompt_submit', 'assistant_message', 'session_checkpoint']) {
    assert.equal(api.hooks.has(hookName), false, `did not expect unsupported hook ${hookName}`);
  }
});
