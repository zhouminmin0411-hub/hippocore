'use strict';

const { spawnSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NotionClient {
  constructor({ token, apiVersion = '2025-09-03', baseUrl = 'https://api.notion.com', maxRetries = 3, timeoutMs = 15000 } = {}) {
    if (!token) throw new Error('Missing Notion API token');
    this.token = token;
    this.apiVersion = apiVersion;
    this.baseUrl = String(baseUrl || 'https://api.notion.com').replace(/\/$/, '');
    this.maxRetries = Number(maxRetries || 3);
    this.timeoutMs = Number(timeoutMs || 15000);
  }

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Notion-Version': this.apiVersion,
            'content-type': 'application/json',
          },
          body: body == null ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        if (attempt < this.maxRetries) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw new Error(`Notion request failed: ${err.message}`);
      }
      clearTimeout(timeout);

      if (res.ok) {
        if (res.status === 204) return {};
        const text = await res.text();
        return text ? JSON.parse(text) : {};
      }

      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after') || '0');
        const delayMs = retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1);
        await sleep(delayMs);
        continue;
      }

      throw new Error(`Notion API ${res.status}: ${text}`);
    }

    throw new Error('Unexpected Notion request termination');
  }

  requestSync(method, path, body = null) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const args = [
      '-sS',
      '-X',
      method,
      '-H',
      `Authorization: Bearer ${this.token}`,
      '-H',
      `Notion-Version: ${this.apiVersion}`,
      '-H',
      'content-type: application/json',
      url,
    ];
    if (body != null) {
      args.push('--data', JSON.stringify(body));
    }

    const out = spawnSync('curl', args, { encoding: 'utf8' });
    if (out.error) {
      throw new Error(`Notion sync request failed: ${out.error.message}`);
    }
    if (Number(out.status || 0) !== 0) {
      throw new Error(`Notion sync request failed: ${out.stderr || out.stdout || 'unknown error'}`);
    }
    const raw = String(out.stdout || '').trim();
    if (!raw) return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Notion sync response parse failed: ${err.message}`);
    }
    if (parsed && parsed.object === 'error') {
      throw new Error(`Notion API error: ${parsed.code || 'unknown'} ${parsed.message || ''}`.trim());
    }
    return parsed;
  }

  async usersMe() {
    return this.request('GET', '/v1/users/me');
  }

  usersMeSync() {
    return this.requestSync('GET', '/v1/users/me');
  }

  async queryDataSource(dataSourceId, body = {}) {
    return this.request('POST', `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, body);
  }

  queryDataSourceSync(dataSourceId, body = {}) {
    return this.requestSync('POST', `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, body);
  }

  async createPage({ parentDataSourceId, properties, children = [] }) {
    return this.request('POST', '/v1/pages', {
      parent: { data_source_id: parentDataSourceId },
      properties,
      children,
    });
  }

  createPageSync({ parentDataSourceId, properties, children = [] }) {
    return this.requestSync('POST', '/v1/pages', {
      parent: { data_source_id: parentDataSourceId },
      properties,
      children,
    });
  }

  async updatePage(pageId, payload) {
    return this.request('PATCH', `/v1/pages/${encodeURIComponent(pageId)}`, payload);
  }

  updatePageSync(pageId, payload) {
    return this.requestSync('PATCH', `/v1/pages/${encodeURIComponent(pageId)}`, payload);
  }

  async retrieveBlockChildren(blockId, startCursor = null) {
    const q = startCursor ? `?start_cursor=${encodeURIComponent(startCursor)}` : '';
    return this.request('GET', `/v1/blocks/${encodeURIComponent(blockId)}/children${q}`);
  }

  retrieveBlockChildrenSync(blockId, startCursor = null) {
    const q = startCursor ? `?start_cursor=${encodeURIComponent(startCursor)}` : '';
    return this.requestSync('GET', `/v1/blocks/${encodeURIComponent(blockId)}/children${q}`);
  }

  async getPage(pageId) {
    return this.request('GET', `/v1/pages/${encodeURIComponent(pageId)}`);
  }

  getPageSync(pageId) {
    return this.requestSync('GET', `/v1/pages/${encodeURIComponent(pageId)}`);
  }
}

module.exports = {
  NotionClient,
};
