'use strict';

const fs = require('fs');
const path = require('path');

const LEGACY_CONFIG_FILE = 'memory.config.json';
const CONFIG_FILE = 'hippocore.config.json';

function nowIso() {
  return new Date().toISOString();
}

function defaultConfig(projectRoot) {
  return {
    version: 2,
    updatedAt: nowIso(),
    paths: {
      workspaceRoot: 'hippocore',
      db: 'hippocore/system/db/hippocore.db',
      projectionDir: 'hippocore/system/views',
      globalDir: 'hippocore/global',
      projectsDir: 'hippocore/projects',
      importsObsidian: 'hippocore/imports/obsidian',
      importsChats: 'hippocore/imports/chats',
      obsidianVault: null,
      clawdbotTranscripts: null,
    },
    sync: {
      maxChunkChars: 1800,
      maxContextItems: 12,
    },
    retrieval: {
      scopePolicy: 'layered',
      semantic: {
        enabled: false,
      },
    },
    quality: {
      profile: 'balanced',
      distill: {
        typeWhitelist: ['Decision', 'Task', 'Insight', 'Area'],
        minConfidence: 0.72,
      },
      enrichment: {
        enabled: true,
        strategy: 'hybrid_rule_llm_full',
        fieldsGate: 'soft',
        projectNameMap: {},
        llm: {
          provider: 'openai_compatible',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4.1-mini',
          apiKeyEnv: 'OPENAI_API_KEY',
          timeoutMs: 8000,
          maxRetries: 1,
          concurrency: 4,
          temperature: 0.1,
          maxOutputTokens: 280,
        },
      },
    },
    api: {
      host: '127.0.0.1',
      port: 31337,
    },
    openclaw: {
      autoTrigger: true,
      sessionStartEvent: 'session_start',
      userPromptSubmitEvent: 'user_prompt_submit',
      checkpointCompatibility: {
        enabled: true,
        mode: 'assistant_anchor',
        minConfidence: 0.78,
        requireSummarySignals: true,
        allowExplicitEventMarkers: true,
      },
    },
    storage: {
      mode: 'local',
      notion: {
        tokenEnv: 'NOTION_API_KEY',
        apiVersion: '2025-09-03',
        memoryDataSourceId: null,
        relationsDataSourceId: null,
        docDataSourceIds: [],
        watchRoots: [],
        watchMaxDepth: 4,
        pollIntervalSec: 120,
        cursor: null,
      },
    },
    mirror: {
      remote: null,
      local: null,
    },
    projectRoot,
  };
}

function resolveProjectRoot(cwd = process.cwd()) {
  return path.resolve(cwd);
}

function getPreferredConfigPath(projectRoot) {
  return path.join(projectRoot, 'hippocore', 'system', 'config', CONFIG_FILE);
}

function getLegacyConfigPath(projectRoot) {
  return path.join(projectRoot, LEGACY_CONFIG_FILE);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveConfiguredPath(projectRoot, maybePath) {
  if (!maybePath) return null;
  if (path.isAbsolute(maybePath)) return maybePath;
  return path.join(projectRoot, maybePath);
}

function locateExistingConfigPath(projectRoot) {
  const preferred = getPreferredConfigPath(projectRoot);
  if (fs.existsSync(preferred)) return preferred;

  const legacy = getLegacyConfigPath(projectRoot);
  if (fs.existsSync(legacy)) return legacy;

  return preferred;
}

function mergeConfig(projectRoot, raw) {
  const base = defaultConfig(projectRoot);
  return {
    ...base,
    ...raw,
    paths: {
      ...base.paths,
      ...(raw.paths || {}),
    },
    sync: {
      ...base.sync,
      ...(raw.sync || {}),
    },
    retrieval: {
      ...base.retrieval,
      ...(raw.retrieval || {}),
      semantic: {
        ...base.retrieval.semantic,
        ...((raw.retrieval && raw.retrieval.semantic) || {}),
      },
    },
    quality: {
      ...base.quality,
      ...(raw.quality || {}),
      distill: {
        ...base.quality.distill,
        ...((raw.quality && raw.quality.distill) || {}),
      },
      enrichment: {
        ...base.quality.enrichment,
        ...((raw.quality && raw.quality.enrichment) || {}),
        projectNameMap: (
          raw.quality
          && raw.quality.enrichment
          && raw.quality.enrichment.projectNameMap
          && typeof raw.quality.enrichment.projectNameMap === 'object'
          && !Array.isArray(raw.quality.enrichment.projectNameMap)
        )
          ? raw.quality.enrichment.projectNameMap
          : base.quality.enrichment.projectNameMap,
        llm: {
          ...base.quality.enrichment.llm,
          ...(
            raw.quality
            && raw.quality.enrichment
            && raw.quality.enrichment.llm
            && typeof raw.quality.enrichment.llm === 'object'
            ? raw.quality.enrichment.llm
            : {}
          ),
        },
      },
    },
    api: {
      ...base.api,
      ...(raw.api || {}),
    },
    openclaw: {
      ...base.openclaw,
      ...(raw.openclaw || {}),
      checkpointCompatibility: {
        ...base.openclaw.checkpointCompatibility,
        ...(
          raw.openclaw
          && raw.openclaw.checkpointCompatibility
          && typeof raw.openclaw.checkpointCompatibility === 'object'
            ? raw.openclaw.checkpointCompatibility
            : {}
        ),
      },
    },
    storage: {
      ...base.storage,
      ...(raw.storage || {}),
      notion: {
        ...base.storage.notion,
        ...((raw.storage && raw.storage.notion) || {}),
        docDataSourceIds: Array.isArray(raw.storage && raw.storage.notion && raw.storage.notion.docDataSourceIds)
          ? raw.storage.notion.docDataSourceIds.filter(Boolean)
          : base.storage.notion.docDataSourceIds,
        watchRoots: Array.isArray(raw.storage && raw.storage.notion && raw.storage.notion.watchRoots)
          ? raw.storage.notion.watchRoots.filter(Boolean)
          : base.storage.notion.watchRoots,
      },
    },
    mirror: {
      ...base.mirror,
      ...((raw.mirror && typeof raw.mirror === 'object') ? raw.mirror : {}),
    },
    projectRoot,
  };
}

function loadConfig(projectRoot) {
  const configPath = locateExistingConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    const defaults = defaultConfig(projectRoot);
    defaults.__meta = { configPath };
    return defaults;
  }

  const merged = mergeConfig(projectRoot, readJson(configPath));
  merged.__meta = { configPath };
  return merged;
}

function saveConfig(projectRoot, config, options = {}) {
  const forced = options.configPath || null;
  const configPath = forced
    || (config.__meta && config.__meta.configPath)
    || locateExistingConfigPath(projectRoot);

  const finalCfg = {
    ...config,
    updatedAt: nowIso(),
  };
  delete finalCfg.__meta;

  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(finalCfg, null, 2) + '\n', 'utf8');
  finalCfg.__meta = { configPath };
  return configPath;
}

function ensureWorkspaceLayout(projectRoot, config) {
  const dirs = [
    config.paths.workspaceRoot,
    config.paths.globalDir,
    config.paths.projectsDir,
    config.paths.importsObsidian,
    config.paths.importsChats,
    'hippocore/system',
    'hippocore/system/config',
    'hippocore/system/db',
    'hippocore/system/views',
    'hippocore/system/logs',
    'hippocore/system/backups',
  ];

  for (const dir of dirs) {
    ensureDir(resolveConfiguredPath(projectRoot, dir));
  }
}

function initConfig(projectRoot) {
  const config = loadConfig(projectRoot);
  ensureWorkspaceLayout(projectRoot, config);

  const preferredPath = getPreferredConfigPath(projectRoot);
  const configPath = saveConfig(projectRoot, config, { configPath: preferredPath });
  const dbPath = resolveConfiguredPath(projectRoot, config.paths.db);

  return { config, configPath, dbPath };
}

module.exports = {
  CONFIG_FILE,
  LEGACY_CONFIG_FILE,
  defaultConfig,
  resolveProjectRoot,
  getPreferredConfigPath,
  getLegacyConfigPath,
  loadConfig,
  saveConfig,
  ensureDir,
  resolveConfiguredPath,
  initConfig,
  ensureWorkspaceLayout,
};
