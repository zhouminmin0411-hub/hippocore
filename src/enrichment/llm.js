'use strict';

const { OpenAICompatibleLlmClient } = require('./llm_client');

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    context_summary: { type: 'string' },
    meaning_summary: { type: 'string' },
    actionability_summary: { type: 'string' },
    next_action: { type: 'string' },
    owner_hint: { type: 'string' },
  },
  required: [
    'context_summary',
    'meaning_summary',
    'actionability_summary',
    'next_action',
    'owner_hint',
  ],
};

const SENSITIVE_RE = /\b(api[\s_-]*key|password|passwd|secret|token|private[\s_-]*key)\b/i;

function compact(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function stripCodeFence(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  return value;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeField(text, limit) {
  const value = compact(text, limit);
  if (!value) return '';
  if (SENSITIVE_RE.test(value)) return '';
  return value;
}

function normalizeOutput(raw) {
  const input = (raw && typeof raw === 'object') ? raw : {};
  return {
    context_summary: sanitizeField(input.context_summary, 260),
    meaning_summary: sanitizeField(input.meaning_summary, 260),
    actionability_summary: sanitizeField(input.actionability_summary, 260),
    next_action: sanitizeField(input.next_action, 140),
    owner_hint: sanitizeField(input.owner_hint, 80),
  };
}

function hasAnyValue(fields) {
  return Boolean(
    fields.context_summary
    || fields.meaning_summary
    || fields.actionability_summary
    || fields.next_action
    || fields.owner_hint,
  );
}

function buildSystemPrompt() {
  return [
    'You are Hippocore memory enricher.',
    'Return only valid JSON.',
    'No markdown, no explanation, no extra keys.',
    'Fields must be concise and factual.',
    'Use the same language as the source text (Chinese source => Chinese output).',
    'If content is an open question, exploration, or idea, keep next_action as empty string and state decision/clarification is needed before execution.',
    'Do not invent owners, deadlines, or execution commitments that are not in source/rule fields.',
    'Do not include secrets, tokens, passwords, or private keys.',
  ].join(' ');
}

function buildUserPrompt({ item, source, ruleFields }) {
  const payload = {
    type: item.type || 'Event',
    title: item.title || '',
    body: item.body || '',
    project_id: item.projectId || null,
    source_path: (source && source.sourcePath) || (item.evidence && item.evidence.sourcePath) || '',
    source_snippet: (item.evidence && item.evidence.snippet) || '',
    rule_fields: {
      context_summary: ruleFields.context_summary || '',
      meaning_summary: ruleFields.meaning_summary || '',
      actionability_summary: ruleFields.actionability_summary || '',
      next_action: ruleFields.next_action || '',
      owner_hint: ruleFields.owner_hint || '',
    },
    constraints: {
      context_summary: 'One sentence, <= 260 chars',
      meaning_summary: 'One sentence, <= 260 chars',
      actionability_summary: 'One sentence, <= 260 chars',
      next_action: '<= 140 chars, optional empty string',
      owner_hint: '<= 80 chars, optional empty string',
    },
  };

  return [
    'Enhance this memory entry. Keep it factual and concise. Do not force actionability when source is exploratory or undecided.',
    JSON.stringify(payload),
  ].join('\n');
}

function enrichWithLlmSync({
  item,
  source,
  ruleFields,
  llmSettings,
} = {}) {
  const cfg = llmSettings && typeof llmSettings === 'object' ? llmSettings : {};
  const apiKeyEnv = String(cfg.apiKeyEnv || 'OPENAI_API_KEY');
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    return {
      ok: false,
      error: `Missing LLM API key env: ${apiKeyEnv}`,
      fields: null,
    };
  }

  const client = new OpenAICompatibleLlmClient({
    apiKey,
    baseUrl: cfg.baseUrl || 'https://api.openai.com/v1',
    model: cfg.model || 'gpt-4.1-mini',
    timeoutMs: cfg.timeoutMs == null ? 8000 : cfg.timeoutMs,
    maxRetries: cfg.maxRetries == null ? 1 : cfg.maxRetries,
    temperature: cfg.temperature == null ? 0.1 : cfg.temperature,
    maxOutputTokens: cfg.maxOutputTokens == null ? 280 : cfg.maxOutputTokens,
  });

  try {
    const rawText = client.createStructuredOutputSync({
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt({ item, source, ruleFields }),
      jsonSchema: OUTPUT_SCHEMA,
    });
    const parsed = safeParse(stripCodeFence(rawText));
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        error: 'Invalid LLM JSON output',
        fields: null,
      };
    }
    const fields = normalizeOutput(parsed);
    if (!hasAnyValue(fields)) {
      return {
        ok: false,
        error: 'LLM output empty after sanitization',
        fields: null,
      };
    }
    return {
      ok: true,
      error: null,
      fields,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      fields: null,
    };
  }
}

module.exports = {
  enrichWithLlmSync,
};
