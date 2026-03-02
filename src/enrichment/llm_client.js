'use strict';

const { spawnSync } = require('child_process');

function sleepSync(ms) {
  const timeout = Math.max(0, Number(ms || 0));
  if (timeout <= 0) return;
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, timeout);
}

function normalizeBaseUrl(value) {
  const raw = String(value || 'https://api.openai.com/v1').trim();
  return raw.replace(/\/$/, '');
}

function safeJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRetryableStatus(code) {
  if (!Number.isFinite(code)) return true;
  return code === 408 || code === 409 || code === 429 || code >= 500;
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

class OpenAICompatibleLlmClient {
  constructor({
    apiKey,
    baseUrl = 'https://api.openai.com/v1',
    model = 'gpt-4.1-mini',
    timeoutMs = 8000,
    maxRetries = 1,
    temperature = 0.1,
    maxOutputTokens = 280,
  } = {}) {
    if (!apiKey) throw new Error('Missing LLM API key');
    this.apiKey = String(apiKey);
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = String(model || 'gpt-4.1-mini');
    this.timeoutMs = clamp(timeoutMs, 500, 60000, 8000);
    this.maxRetries = clamp(maxRetries, 0, 5, 1);
    this.temperature = clamp(temperature, 0, 1.5, 0.1);
    this.maxOutputTokens = clamp(maxOutputTokens, 64, 2048, 280);
  }

  requestJsonSync(path, payload) {
    const mockHandler = global.__HIPPOCORE_LLM_MOCK__;
    if (typeof mockHandler === 'function') {
      let lastError = null;
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        const mocked = mockHandler({
          attempt,
          path,
          payload,
          baseUrl: this.baseUrl,
          model: this.model,
        });
        if (mocked && typeof mocked === 'object' && mocked.throw) {
          lastError = String(mocked.throw);
          if (attempt < this.maxRetries) continue;
          throw new Error(lastError);
        }

        const status = Number((mocked && mocked.status) || 200);
        const body = (mocked && typeof mocked === 'object' && Object.prototype.hasOwnProperty.call(mocked, 'body'))
          ? mocked.body
          : mocked;
        if (status >= 200 && status < 300) {
          return (body && typeof body === 'object') ? body : {};
        }
        const message = body && body.error && body.error.message
          ? body.error.message
          : JSON.stringify(body || {});
        lastError = `LLM API ${status}: ${message}`;
        if (attempt < this.maxRetries && isRetryableStatus(status)) {
          continue;
        }
        throw new Error(lastError);
      }
      throw new Error(lastError || 'Mocked LLM request failed');
    }

    const endpoint = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const args = [
      '-sS',
      '-X',
      'POST',
      '-H',
      `Authorization: Bearer ${this.apiKey}`,
      '-H',
      'content-type: application/json',
      '--connect-timeout',
      String(Math.max(1, Math.floor(this.timeoutMs / 1000))),
      '--max-time',
      String(Math.max(1, Math.ceil(this.timeoutMs / 1000))),
      '--data',
      JSON.stringify(payload || {}),
      '-w',
      '\n%{http_code}',
      endpoint,
    ];

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const out = spawnSync('curl', args, { encoding: 'utf8' });
      if (out.error) {
        lastError = out.error.message;
        if (attempt < this.maxRetries) {
          sleepSync(250 * (attempt + 1));
          continue;
        }
        throw new Error(`LLM request failed: ${lastError}`);
      }

      const stdout = String(out.stdout || '');
      const splitAt = stdout.lastIndexOf('\n');
      const bodyRaw = splitAt === -1 ? '' : stdout.slice(0, splitAt).trim();
      const statusRaw = splitAt === -1 ? stdout.trim() : stdout.slice(splitAt + 1).trim();
      const statusCode = Number(statusRaw);
      const parsedBody = safeJsonParse(bodyRaw) || { raw: bodyRaw };
      const errText = String(out.stderr || '').trim();

      if (out.status === 0 && statusCode >= 200 && statusCode < 300) {
        return parsedBody;
      }

      const message = parsedBody && parsedBody.error && parsedBody.error.message
        ? parsedBody.error.message
        : (bodyRaw || errText || 'unknown llm error');
      lastError = `LLM API ${Number.isFinite(statusCode) ? statusCode : 'N/A'}: ${message}`;
      if (attempt < this.maxRetries && isRetryableStatus(statusCode)) {
        sleepSync(350 * (attempt + 1));
        continue;
      }
      throw new Error(lastError);
    }

    throw new Error(lastError || 'LLM request failed');
  }

  static extractTextFromResponse(result) {
    if (!result || typeof result !== 'object') return '';
    if (typeof result.output_text === 'string' && result.output_text.trim()) {
      return result.output_text.trim();
    }
    if (Array.isArray(result.output)) {
      const chunks = [];
      for (const item of result.output) {
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item.content)) {
          for (const content of item.content) {
            if (!content || typeof content !== 'object') continue;
            if (typeof content.text === 'string') chunks.push(content.text);
          }
        }
      }
      if (chunks.length) return chunks.join('\n').trim();
    }
    if (Array.isArray(result.choices) && result.choices[0] && result.choices[0].message) {
      const message = result.choices[0].message;
      if (typeof message.content === 'string') return message.content.trim();
      if (Array.isArray(message.content)) {
        const chunks = message.content
          .map((part) => (part && typeof part.text === 'string') ? part.text : '')
          .filter(Boolean);
        if (chunks.length) return chunks.join('\n').trim();
      }
    }
    return '';
  }

  createStructuredOutputSync({
    systemPrompt,
    userPrompt,
    jsonSchema,
  } = {}) {
    const responsePayload = {
      model: this.model,
      temperature: this.temperature,
      max_output_tokens: this.maxOutputTokens,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: String(systemPrompt || '') }] },
        { role: 'user', content: [{ type: 'input_text', text: String(userPrompt || '') }] },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'hippocore_memory_enrichment',
          schema: jsonSchema,
          strict: true,
        },
      },
    };

    let out;
    try {
      out = this.requestJsonSync('/responses', responsePayload);
    } catch (err) {
      const msg = String(err.message || '');
      const shouldFallback = /404|405|unrecognized|unsupported|not found|unknown/i.test(msg);
      if (!shouldFallback) throw err;

      const chatPayload = {
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: String(systemPrompt || '') },
          { role: 'user', content: String(userPrompt || '') },
        ],
      };
      out = this.requestJsonSync('/chat/completions', chatPayload);
    }

    const text = OpenAICompatibleLlmClient.extractTextFromResponse(out);
    if (!text) {
      throw new Error('LLM response did not include text payload');
    }
    return text;
  }
}

module.exports = {
  OpenAICompatibleLlmClient,
};
