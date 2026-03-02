'use strict';

const { buildRuleEnrichment, ENRICHMENT_VERSION } = require('./rule');
const { enrichWithLlmSync } = require('./llm');

function nowIso() {
  return new Date().toISOString();
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function normalizeSettings(config) {
  const quality = (config && config.quality && typeof config.quality === 'object') ? config.quality : {};
  const enrichment = (quality.enrichment && typeof quality.enrichment === 'object') ? quality.enrichment : {};
  const llm = (enrichment.llm && typeof enrichment.llm === 'object') ? enrichment.llm : {};

  return {
    enabled: toBool(enrichment.enabled, true),
    strategy: String(enrichment.strategy || 'hybrid_rule_llm_full'),
    fieldsGate: String(enrichment.fieldsGate || 'soft').toLowerCase(),
    projectNameMap: (
      enrichment.projectNameMap
      && typeof enrichment.projectNameMap === 'object'
      && !Array.isArray(enrichment.projectNameMap)
    )
      ? enrichment.projectNameMap
      : {},
    llm: {
      provider: String(llm.provider || 'openai_compatible'),
      baseUrl: llm.baseUrl || 'https://api.openai.com/v1',
      model: llm.model || 'gpt-4.1-mini',
      apiKeyEnv: llm.apiKeyEnv || 'OPENAI_API_KEY',
      timeoutMs: llm.timeoutMs == null ? 8000 : Number(llm.timeoutMs),
      maxRetries: llm.maxRetries == null ? 1 : Number(llm.maxRetries),
      concurrency: llm.concurrency == null ? 4 : Number(llm.concurrency),
      temperature: llm.temperature == null ? 0.1 : Number(llm.temperature),
      maxOutputTokens: llm.maxOutputTokens == null ? 280 : Number(llm.maxOutputTokens),
    },
  };
}

function mergeEnrichmentFields(ruleFields, llmFields) {
  const out = { ...ruleFields };
  const source = (llmFields && typeof llmFields === 'object') ? llmFields : {};
  const keys = ['context_summary', 'meaning_summary', 'actionability_summary', 'next_action', 'owner_hint'];
  for (const key of keys) {
    const value = String(source[key] || '').trim();
    if (value) out[key] = value;
  }
  return out;
}

function blankStats() {
  return {
    llmSuccess: 0,
    llmFallback: 0,
    ruleOnly: 0,
    llmErrors: [],
  };
}

function pushLlmError(stats, message) {
  if (!message) return;
  if (!Array.isArray(stats.llmErrors)) stats.llmErrors = [];
  if (stats.llmErrors.length >= 20) return;
  stats.llmErrors.push(String(message));
}

function enrichMemoryItemSync({ item, source, config }) {
  const settings = normalizeSettings(config);
  const stats = blankStats();
  const ruleFields = buildRuleEnrichment(item, {
    sourcePath: source && source.sourcePath ? source.sourcePath : '',
    projectNameMap: settings.projectNameMap,
  });

  if (!settings.enabled) {
    stats.ruleOnly += 1;
    return {
      item: {
        ...item,
        ...ruleFields,
        enrichment_source: 'rule',
        enrichment_version: ENRICHMENT_VERSION,
        llm_enriched_at: null,
      },
      stats,
    };
  }

  const useLlm = settings.strategy === 'hybrid_rule_llm_full';
  if (!useLlm || settings.llm.provider !== 'openai_compatible') {
    stats.ruleOnly += 1;
    return {
      item: {
        ...item,
        ...ruleFields,
        enrichment_source: 'rule',
        enrichment_version: ENRICHMENT_VERSION,
        llm_enriched_at: null,
      },
      stats,
    };
  }

  const llmOut = enrichWithLlmSync({
    item,
    source,
    ruleFields,
    llmSettings: settings.llm,
  });

  if (!llmOut.ok || !llmOut.fields) {
    stats.llmFallback += 1;
    stats.ruleOnly += 1;
    pushLlmError(stats, llmOut.error);
    return {
      item: {
        ...item,
        ...ruleFields,
        enrichment_source: 'rule',
        enrichment_version: ENRICHMENT_VERSION,
        llm_enriched_at: null,
      },
      stats,
    };
  }

  const merged = mergeEnrichmentFields(ruleFields, llmOut.fields);
  stats.llmSuccess += 1;
  return {
    item: {
      ...item,
      ...merged,
      enrichment_source: 'rule+llm',
      enrichment_version: ENRICHMENT_VERSION,
      llm_enriched_at: nowIso(),
    },
    stats,
  };
}

module.exports = {
  enrichMemoryItemSync,
  blankStats,
  normalizeSettings,
};
