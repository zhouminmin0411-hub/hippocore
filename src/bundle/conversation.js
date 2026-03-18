'use strict';

const { sha256 } = require('../hash');

function normalizeMessage(message, idx) {
  if (!message || typeof message !== 'object') return null;
  const role = String(message.role || '').trim().toLowerCase();
  const text = String(message.text || message.content || '').trim();
  if (!text || (role !== 'user' && role !== 'assistant')) return null;
  return {
    role,
    text,
    messageId: message.messageId || `m-${idx + 1}`,
    timestamp: message.timestamp || null,
  };
}

function buildConversationBundle({
  sessionKey,
  projectId = null,
  checkpointId = null,
  messages = [],
  final = false,
  fallback = false,
  triggerSource = null,
  extractionPolicy = 'checkpoint_first_role_weighted',
  assistantEvidenceOnly = true,
} = {}) {
  const normalizedMessages = (Array.isArray(messages) ? messages : [])
    .map(normalizeMessage)
    .filter(Boolean);
  const userMessages = normalizedMessages.filter((message) => message.role === 'user');
  const assistantMessages = normalizedMessages.filter((message) => message.role === 'assistant');
  const digest = sha256(JSON.stringify(normalizedMessages));
  const suffix = checkpointId ? `checkpoint:${checkpointId}` : `final:${digest.slice(0, 16)}`;
  const sourceOriginKey = `conversation:${sessionKey}:${suffix}`;
  const content = normalizedMessages
    .map((message) => `${message.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${message.text}`)
    .join('\n');
  const primaryContent = normalizedMessages
    .filter((message) => message.role === 'user')
    .map((message) => `USER: ${message.text}`)
    .join('\n');

  return {
    id: `bundle:${sha256(`conversation|${sourceOriginKey}|${digest}`)}`,
    bundleType: 'conversation',
    sourcePath: final
      ? `session_final:${sessionKey}:${digest.slice(0, 16)}`
      : `session_checkpoint:${sessionKey}:${String(checkpointId || digest.slice(0, 16))}`,
    sourceOriginKey,
    sourceTitle: checkpointId ? `Session ${sessionKey} checkpoint ${checkpointId}` : `Session ${sessionKey} final segment`,
    sourceHash: digest,
    projectId,
    content,
    primaryContent,
    metadata: {
      sessionKey,
      checkpointId: checkpointId || null,
      final: Boolean(final),
      fallback: Boolean(fallback),
      triggerSource: triggerSource || null,
      extractionPolicy,
      assistantEvidenceOnly: Boolean(assistantEvidenceOnly),
      lastMessageId: normalizedMessages.length ? normalizedMessages[normalizedMessages.length - 1].messageId : null,
      messageCount: normalizedMessages.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      windowStartMessageId: normalizedMessages.length ? normalizedMessages[0].messageId : null,
      windowEndMessageId: normalizedMessages.length ? normalizedMessages[normalizedMessages.length - 1].messageId : null,
    },
    messages: normalizedMessages,
    sourceType: 'conversation',
  };
}

module.exports = {
  buildConversationBundle,
};
