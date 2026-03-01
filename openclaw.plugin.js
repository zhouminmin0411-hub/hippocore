'use strict';

const path = require('path');
const {
  triggerSessionStart,
  triggerUserPromptSubmit,
  composeMemory,
  retrieveMemory,
  writeMemory,
  runSync,
} = require('./src/service');

function resolveProjectRoot() {
  if (process.env.HIPPOCORE_PROJECT_ROOT) {
    return path.resolve(process.env.HIPPOCORE_PROJECT_ROOT);
  }
  if (process.env.MEMORY_PROJECT_ROOT) {
    return path.resolve(process.env.MEMORY_PROJECT_ROOT);
  }
  return process.cwd();
}

function extractPromptText(event) {
  if (!event) return '';
  if (typeof event === 'string') return event;
  if (typeof event.prompt === 'string') return event.prompt;
  if (typeof event.userMessage === 'string') return event.userMessage;
  if (typeof event.text === 'string') return event.text;
  if (event.message && typeof event.message.content === 'string') return event.message.content;
  return '';
}

function extractProjectId(event) {
  if (!event || typeof event !== 'object') return null;
  return event.projectId || event.project || event.workspaceId || null;
}

const plugin = {
  id: 'hippocore',
  name: 'Hippocore',
  description: 'Hippocore shared memory with layered retrieval, compose, and incremental writes.',
  version: '0.2.0',

  register(api) {
    const pluginRoot = (api && api.pluginConfig && api.pluginConfig.projectRoot)
      ? path.resolve(api.pluginConfig.projectRoot)
      : resolveProjectRoot();

    const cwd = pluginRoot;
    const bindEvent = (eventName, handler) => {
      try {
        api.on(eventName, handler);
      } catch {
        // Keep compatibility with versions missing this event API.
      }
    };

    const onSessionStart = async (event) => {
      try {
        const sessionKey = event?.sessionId || event?.id || `${Date.now()}`;
        const projectId = extractProjectId(event);
        const out = triggerSessionStart({ cwd, sessionKey, tokenBudget: 900, projectId });
        return {
          prependContext: out.context.text,
        };
      } catch (err) {
        return {
          prependContext: `Hippocore startup failed: ${err.message}`,
        };
      }
    };

    const onUserPromptSubmit = async (event) => {
      try {
        const sessionKey = event?.sessionId || event?.id || 'unknown-session';
        const projectId = extractProjectId(event);
        const messageId = event?.messageId || `${Date.now()}`;
        const text = extractPromptText(event);
        if (text && text.trim()) {
          triggerUserPromptSubmit({ cwd, sessionKey, projectId, messageId, text });
        }
      } catch {
        // Non-fatal by design.
      }
    };

    bindEvent('session_start', onSessionStart);
    bindEvent('user_prompt_submit', onUserPromptSubmit);

    // Compatibility names
    bindEvent('command:new', onSessionStart);
    bindEvent('message:received', onUserPromptSubmit);

    api.registerTool({
      name: 'memory_context',
      description: 'Compose memory context under a token budget with citations.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query text for context composition' },
          projectId: { type: 'string', description: 'Optional project scope' },
          types: { type: 'array', items: { type: 'string' }, description: 'Optional memory types' },
          tokenBudget: { type: 'number', default: 1200 },
        },
        required: ['query'],
      },
      async execute(_id, params) {
        const result = composeMemory({
          cwd,
          query: params.query,
          projectId: params.projectId || null,
          types: params.types || [],
          tokenBudget: Number(params.tokenBudget || 1200),
          includeCandidate: true,
          scopePolicy: 'layered',
        });

        return {
          content: [
            { type: 'text', text: result.contextText || 'No relevant memory found.' },
            { type: 'text', text: JSON.stringify({ citations: result.citations.slice(0, 40) }) },
          ],
        };
      },
    });

    api.registerTool({
      name: 'memory_retrieve',
      description: 'Retrieve ranked memory candidates with score breakdown.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          projectId: { type: 'string' },
          types: { type: 'array', items: { type: 'string' } },
          tokenBudget: { type: 'number', default: 1200 },
        },
        required: ['query'],
      },
      async execute(_id, params) {
        const result = retrieveMemory({
          cwd,
          query: params.query,
          projectId: params.projectId || null,
          types: params.types || [],
          tokenBudget: Number(params.tokenBudget || 1200),
          includeCandidate: true,
          scopePolicy: 'layered',
        });

        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    });

    api.registerTool({
      name: 'memory_write',
      description: 'Write new candidate memories generated by AI execution.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
                confidence: { type: 'number' },
                importance: { type: 'number' },
                relationHints: { type: 'array', items: { type: 'object' } },
              },
              required: ['type', 'body'],
            },
          },
          statusHint: { type: 'string', default: 'candidate' },
        },
        required: ['items'],
      },
      async execute(_id, params) {
        const result = writeMemory({
          cwd,
          projectId: params.projectId || null,
          items: params.items || [],
          statusHint: params.statusHint || 'candidate',
        });

        return {
          content: [
            { type: 'text', text: JSON.stringify(result) },
          ],
        };
      },
    });

    api.registerTool({
      name: 'memory_sync',
      description: 'Run manual sync for configured sources.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        const result = runSync({ cwd });
        return {
          content: [
            { type: 'text', text: JSON.stringify(result) },
          ],
        };
      },
    });
  },
};

module.exports = plugin;
module.exports.default = plugin;
