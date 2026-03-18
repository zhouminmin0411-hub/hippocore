'use strict';

const path = require('path');
const {
  triggerSessionStart,
  triggerUserPromptSubmit,
  triggerAssistantMessage,
  triggerSessionCheckpoint,
  triggerSessionEnd,
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

function parseRuntimeVersion(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const match = raw.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function isModernTypedHookRuntime(rawVersion) {
  const parsed = parseRuntimeVersion(rawVersion);
  if (!parsed) return true;
  if (parsed.year !== 2026) return parsed.year > 2026;
  if (parsed.month !== 3) return parsed.month > 3;
  return parsed.day >= 12;
}

function extractSessionKey(event, ctx) {
  if (ctx && typeof ctx === 'object') {
    if (typeof ctx.sessionKey === 'string' && ctx.sessionKey) return ctx.sessionKey;
    if (typeof ctx.sessionId === 'string' && ctx.sessionId) return ctx.sessionId;
  }
  if (event && typeof event === 'object') {
    if (typeof event.sessionKey === 'string' && event.sessionKey) return event.sessionKey;
    if (typeof event.sessionId === 'string' && event.sessionId) return event.sessionId;
    if (typeof event.id === 'string' && event.id) return event.id;
  }
  return 'unknown-session';
}

function extractMessageId(event) {
  if (!event || typeof event !== 'object') return `${Date.now()}`;
  return event.messageId || event.runId || event.id || `${Date.now()}`;
}

function extractAssistantText(event) {
  if (!event || typeof event !== 'object') return '';
  if (Array.isArray(event.assistantTexts)) {
    return event.assistantTexts
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return extractPromptText(event);
}

function extractRole(event) {
  if (!event || typeof event !== 'object') return null;
  const role = event.role
    || (event.message && event.message.role)
    || event.senderRole
    || event.sender;
  if (!role || typeof role !== 'string') return null;
  const normalized = role.toLowerCase();
  if (normalized === 'assistant' || normalized === 'ai') return 'assistant';
  if (normalized === 'user') return 'user';
  return null;
}

function extractMessages(event) {
  if (!event || typeof event !== 'object') return [];
  const candidates = [
    event.messages,
    event.transcript,
    event.history,
    event.conversation,
    event.session && event.session.messages,
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) return list;
  }
  return [];
}

const plugin = {
  id: 'hippocore',
  name: 'Hippocore',
  description: 'Hippocore agent memory infrastructure for OpenClaw with layered retrieval, incremental sync, and Notion-aware citations.',
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
    const modernTypedHooks = isModernTypedHookRuntime(api && api.runtime && api.runtime.version);

    const onSessionStart = async (event, ctx) => {
      try {
        const sessionKey = extractSessionKey(event, ctx);
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

    const onUserPromptSubmit = async (event, ctx) => {
      try {
        const sessionKey = extractSessionKey(event, ctx);
        const projectId = extractProjectId(event);
        const messageId = extractMessageId(event);
        const text = extractPromptText(event);
        if (text && text.trim()) {
          triggerUserPromptSubmit({ cwd, sessionKey, projectId, messageId, text });
        }
      } catch {
        // Non-fatal by design.
      }
    };

    const onAssistantMessage = async (event, ctx) => {
      try {
        const sessionKey = extractSessionKey(event, ctx);
        const projectId = extractProjectId(event);
        const messageId = extractMessageId(event);
        const text = extractAssistantText(event);
        if (text && text.trim()) {
          triggerAssistantMessage({ cwd, sessionKey, projectId, messageId, text, event });
        }
      } catch {
        // Non-fatal by design.
      }
    };

    const onSessionEnd = async (event, ctx) => {
      try {
        const sessionKey = extractSessionKey(event, ctx);
        const projectId = extractProjectId(event);
        const messages = extractMessages(event);
        triggerSessionEnd({ cwd, sessionKey, projectId, messages });
      } catch {
        // Non-fatal by design.
      }
    };

    const onSessionCheckpoint = async (event, ctx) => {
      try {
        const sessionKey = extractSessionKey(event, ctx);
        const projectId = extractProjectId(event);
        const checkpointId = event?.checkpointId || event?.summaryId || event?.id || `${Date.now()}`;
        const messages = extractMessages(event);
        triggerSessionCheckpoint({ cwd, sessionKey, projectId, checkpointId, messages });
      } catch {
        // Non-fatal by design.
      }
    };

    const onMessageReceivedCompat = async (event, ctx) => {
      const role = extractRole(event);
      if (role === 'user') return onUserPromptSubmit(event, ctx);
      if (role === 'assistant') return onAssistantMessage(event, ctx);

      if (event && typeof event.content === 'string' && event.content.trim()) {
        const compatEvent = {
          ...event,
          text: event.content,
          messageId: extractMessageId(event),
        };
        return onUserPromptSubmit(compatEvent, ctx);
      }

      return null;
    };

    bindEvent('session_start', onSessionStart);
    bindEvent('session_end', onSessionEnd);
    bindEvent('message_received', onMessageReceivedCompat);
    bindEvent('llm_output', onAssistantMessage);
    bindEvent('user_prompt_submit', onUserPromptSubmit);
    bindEvent('assistant_message', onAssistantMessage);
    bindEvent('session_checkpoint', onSessionCheckpoint);

    // Legacy compatibility names for older OpenClaw runtimes.
    if (!modernTypedHooks) {
      bindEvent('command:new', onSessionStart);
      bindEvent('message:received', onMessageReceivedCompat);
      bindEvent('command:close', onSessionEnd);
    }

    api.registerTool({
      name: 'memory_context',
      description: 'Compose memory context under a token budget with citations and enrichment fields (context/meaning/actionability/nextAction). Each citation may include sourceUrl/notionPageUrl/notionBlockUrl as direct memory links.',
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
            {
              type: 'text',
              text: JSON.stringify({
                citations: result.citations.slice(0, 40),
                citationFields: [
                  'itemId',
                  'sourcePath',
                  'sourceUrl',
                  'lineStart',
                  'lineEnd',
                  'type',
                  'title',
                  'notionPageUrl',
                  'notionBlockUrl',
                  'contextSummary',
                  'meaningSummary',
                  'actionabilitySummary',
                  'nextAction',
                  'ownerHint',
                ],
              }),
            },
          ],
        };
      },
    });

    api.registerTool({
      name: 'memory_retrieve',
      description: 'Retrieve ranked memory candidates with score breakdown and enrichment fields. Candidate/evidence may include sourceUrl/notionPageUrl/notionBlockUrl.',
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
      description: 'Run manual sync for configured sources. In notion mode this pulls configured Notion doc data sources incrementally.',
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
