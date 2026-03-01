'use strict';

const fs = require('fs');
const path = require('path');
const { sha256 } = require('./hash');

const DISTILL_VERSION = '2026-02-28-v2';

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.obsidian',
  '.memory',
  'MemoryViews',
  'system',
]);

function walkFiles(rootDir, options = {}) {
  const filter = options.filter || (() => true);
  const ignoreDirs = options.ignoreDirs || DEFAULT_IGNORED_DIRS;
  const files = [];

  function walk(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (filter(fullPath)) files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files.sort();
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function fileStatSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function normalizeTime(value) {
  if (!value) return null;
  try {
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  const parts = [];
  for (const item of message.content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('\n').trim();
}

function cleanupTranscriptText(text) {
  if (!text) return '';
  const lines = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/```(?:json)?[\s\S]*?```/gi, '')
    .split('\n');

  const dropLinePatterns = [
    /^conversation info\b/i,
    /^replied message\b/i,
    /^read heartbeat\.md\b/i,
    /^current time:\b/i,
    /^system:\s*\[[^\]]+\]\s*cron\b/i,
    /^heartbeat_ok$/i,
    /^当前模型：/i,
  ];

  const kept = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push('');
      continue;
    }
    if (dropLinePatterns.some((re) => re.test(trimmed))) continue;
    kept.push(line);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isMeaningfulText(text) {
  if (!text || typeof text !== 'string') return false;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length < 10) return false;
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(compact)) return false;
  return true;
}

function normalizeClawdbotTranscript(rawContent, sourcePath) {
  const lines = String(rawContent || '').replace(/\r\n/g, '\n').split('\n');
  const sessionLabel = path.basename(sourcePath, path.extname(sourcePath));
  const blocks = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;

    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || parsed.type !== 'message' || !parsed.message) continue;
    const role = parsed.message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = cleanupTranscriptText(extractMessageText(parsed.message));
    if (!isMeaningfulText(text)) continue;

    const ts = normalizeTime(parsed.timestamp || parsed.message.timestamp) || 'unknown-time';
    blocks.push(`### ${ts} ${String(role).toUpperCase()}\n${text}`);
  }

  if (!blocks.length) return '';
  return [
    `# Session ${sessionLabel}`,
    `Source File: ${sourcePath}`,
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}

function parseFrontmatter(rawContent) {
  const input = String(rawContent || '').replace(/\r\n/g, '\n');
  if (!input.startsWith('---\n')) {
    return { metadata: {}, body: input.trim() };
  }

  const end = input.indexOf('\n---\n', 4);
  if (end === -1) {
    return { metadata: {}, body: input.trim() };
  }

  const frontmatter = input.slice(4, end).split('\n');
  const metadata = {};

  for (const line of frontmatter) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    metadata[key] = parseSimpleYamlValue(value);
  }

  const body = input.slice(end + 5).trim();
  return { metadata, body };
}

function parseSimpleYamlValue(value) {
  const v = String(value || '').trim();
  if (!v) return '';

  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
    return v.slice(1, -1);
  }

  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
  }

  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function normalizeSourceContent(sourceType, filePath, rawContent) {
  if (sourceType === 'clawdbot' && filePath.toLowerCase().endsWith('.jsonl')) {
    return normalizeClawdbotTranscript(rawContent, filePath);
  }

  const parsed = parseFrontmatter(rawContent);
  return parsed.body;
}

function normalizePathForMatch(filePath) {
  return filePath.replace(/\\/g, '/');
}

function inferScopeFromPath(filePath) {
  const normalized = normalizePathForMatch(filePath);
  const projectIdx = normalized.indexOf('/hippocore/projects/');
  if (projectIdx !== -1) {
    const remain = normalized.slice(projectIdx + '/hippocore/projects/'.length);
    const projectId = remain.split('/')[0] || null;
    if (projectId) return { scopeLevel: 'project', projectId };
  }

  if (normalized.includes('/hippocore/global/')) {
    return { scopeLevel: 'global', projectId: null };
  }

  return { scopeLevel: null, projectId: null };
}

function normalizeScope(input) {
  const v = String(input || '').trim().toLowerCase();
  if (v === 'global' || v === 'project' || v === 'temp') return v;
  return null;
}

function inferScope({ sourceType, filePath, metadata, explicitProjectId }) {
  const frontScope = normalizeScope(metadata.memory_scope || metadata.scope_level || metadata.scope);
  const frontProject = metadata.project_id ? String(metadata.project_id).trim() : null;
  if (frontScope) {
    return {
      scopeLevel: frontScope,
      projectId: frontScope === 'project' ? (frontProject || explicitProjectId || 'main') : null,
    };
  }

  if (frontProject) {
    return {
      scopeLevel: 'project',
      projectId: frontProject,
    };
  }

  const pathScope = inferScopeFromPath(filePath);
  if (pathScope.scopeLevel) {
    return pathScope;
  }

  if (sourceType === 'prompt') {
    if (explicitProjectId) return { scopeLevel: 'project', projectId: explicitProjectId };
    return { scopeLevel: 'temp', projectId: null };
  }

  if (sourceType === 'clawdbot') {
    if (explicitProjectId) return { scopeLevel: 'project', projectId: explicitProjectId };
    return { scopeLevel: 'temp', projectId: null };
  }

  return { scopeLevel: 'global', projectId: null };
}

function sourceAuthority(sourceType) {
  if (sourceType === 'obsidian') return 1.0;
  if (sourceType === 'prompt') return 0.85;
  if (sourceType === 'clawdbot') return 0.6;
  return 0.7;
}

function defaultStateForSource(sourceType) {
  if (sourceType === 'obsidian') return 'verified';
  if (sourceType === 'prompt') return 'candidate';
  if (sourceType === 'clawdbot') return 'candidate';
  return 'candidate';
}

function buildSourceRecord({ sourceType, filePath, rawContent, explicitProjectId }) {
  const metadata = parseFrontmatter(rawContent).metadata;
  const content = normalizeSourceContent(sourceType, filePath, rawContent);
  if (!content || !content.trim()) return null;

  const stat = fileStatSafe(filePath);
  const scope = inferScope({
    sourceType,
    filePath,
    metadata,
    explicitProjectId,
  });

  return {
    sourceType,
    sourcePath: filePath,
    mtimeMs: stat ? Math.floor(stat.mtimeMs) : 0,
    content,
    contentHash: sha256(`${DISTILL_VERSION}\n${content}`),
    scopeLevel: scope.scopeLevel,
    projectId: scope.projectId,
    sourceAuthority: sourceAuthority(sourceType),
    defaultState: defaultStateForSource(sourceType),
    metadata,
  };
}

function collectSourceFiles(config, projectRoot) {
  const out = [];
  const seen = new Set();

  function pushDir(dirPath, sourceType, fileExtensions, explicitProjectId = null) {
    if (!dirPath) return;
    const abs = path.isAbsolute(dirPath) ? dirPath : path.join(projectRoot, dirPath);
    if (!fs.existsSync(abs)) return;

    const files = walkFiles(abs, {
      filter: (f) => fileExtensions.some((ext) => f.toLowerCase().endsWith(ext)),
    });

    for (const filePath of files) {
      if (seen.has(filePath)) continue;
      const raw = readFileSafe(filePath);
      const source = buildSourceRecord({
        sourceType,
        filePath,
        rawContent: raw,
        explicitProjectId,
      });
      if (!source) continue;
      seen.add(filePath);
      out.push(source);
    }
  }

  // New hippocore-first paths.
  pushDir(config.paths.globalDir, 'obsidian', ['.md']);
  pushDir(config.paths.projectsDir, 'obsidian', ['.md']);
  pushDir(config.paths.importsObsidian, 'obsidian', ['.md']);
  pushDir(config.paths.importsChats, 'clawdbot', ['.jsonl', '.md', '.txt']);

  // External linked sources remain supported.
  pushDir(config.paths.obsidianVault, 'obsidian', ['.md']);
  pushDir(config.paths.clawdbotTranscripts, 'clawdbot', ['.jsonl', '.md', '.txt']);

  return out;
}

function chunkText(content, maxChunkChars = 1800) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const chunks = [];

  let current = [];
  let currentLen = 0;
  let startLine = 1;

  function pushChunk(endLine) {
    const text = current.join('\n').trim();
    if (!text) return;
    chunks.push({
      chunkIndex: chunks.length,
      lineStart: startLine,
      lineEnd: endLine,
      text,
      contentHash: sha256(text),
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^#{1,6}\s+/.test(line);
    const wouldOverflow = currentLen + line.length + 1 > maxChunkChars;

    if (current.length && (wouldOverflow || (isHeading && currentLen > maxChunkChars * 0.5))) {
      pushChunk(i);
      current = [];
      currentLen = 0;
      startLine = i + 1;
    }

    current.push(line);
    currentLen += line.length + 1;
  }

  if (current.length) pushChunk(lines.length);
  return chunks;
}

function makePromptSource({ sessionKey, messageId, text, projectId = null }) {
  const content = String(text || '').trim();
  const scope = inferScope({
    sourceType: 'prompt',
    filePath: `session:${sessionKey}:message:${messageId}`,
    metadata: {},
    explicitProjectId: projectId,
  });

  return {
    sourceType: 'prompt',
    sourcePath: `session:${sessionKey}:message:${messageId}`,
    mtimeMs: Date.now(),
    content,
    contentHash: sha256(`${DISTILL_VERSION}\n${content}`),
    scopeLevel: scope.scopeLevel,
    projectId: scope.projectId,
    sourceAuthority: sourceAuthority('prompt'),
    defaultState: defaultStateForSource('prompt'),
    metadata: {},
  };
}

module.exports = {
  DISTILL_VERSION,
  collectSourceFiles,
  chunkText,
  makePromptSource,
  normalizeClawdbotTranscript,
};
