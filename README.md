# Hippocore 

Agent memory infrastructure for OpenClaw: converts chats and docs into structured, traceable knowledge with local + Notion storage and strict sync guarantees.

## Status

v0.2 implementation in progress and usable:

1. Hippocore workspace initialization (`hippocore/` directory tree)
2. Layered memory retrieval (`project -> global -> cross-project -> candidate/temp`)
3. Retrieve/Compose split architecture
4. State machine (`candidate`, `verified`, `archived`)
5. Relation extraction + Obsidian dual-track views (`[[wikilink]]` + structured relation frontmatter)
6. OpenClaw trigger integration

## Core Commands

```bash
# Init workspace
node bin/hippocore.js init

# One-click setup for OpenClaw environment (init + connect + sync + hooks install)
node bin/hippocore.js setup --openclaw-home "$HOME/.openclaw" --obsidian-vault "/path/to/vault" --install-agents all

# Guided install alias (same as setup)
node bin/hippocore.js install --openclaw-home "$HOME/.openclaw" --mode auto

# Install hooks only for selected agents
node bin/hippocore.js setup --openclaw-home "$HOME/.openclaw" --install-agents main,friday_ch_xxx

# Cloud default: if --storage is omitted on first cloud install, setup prefers notion mode.
# Force local mode explicitly if needed:
node bin/hippocore.js setup --mode cloud --storage local

# Notion-only setup (Notion as source of truth, SQLite as retrieval cache)
# Provide at least one doc source: --notion-doc-datasource-ids or --notion-watch-roots
export NOTION_API_KEY="secret_xxx"
export OPENAI_API_KEY="sk-xxx"
node bin/hippocore.js setup \
  --storage notion \
  --notion-memory-datasource-id "<memory_ds_id>" \
  --notion-relations-datasource-id "<relations_ds_id>" \
  --notion-doc-datasource-ids "<docs_ds_id_1>,<docs_ds_id_2>" \
  --notion-watch-roots "<root_page_url_or_id_1>,<root_page_url_or_id_2>" \
  --notion-watch-max-depth 4 \
  --llm-base-url "https://api.openai.com/v1" \
  --llm-model "gpt-4.1-mini" \
  --llm-api-key-env "OPENAI_API_KEY" \
  --llm-timeout-ms 8000 \
  --llm-concurrency 4

# Check notion readiness / connectivity
node bin/hippocore.js notion status

# Pull Notion docs incrementally into local retrieval cache
node bin/hippocore.js notion sync

# Rebuild full Notion local cache (all configured doc sources + watch roots)
node bin/hippocore.js notion sync --full

# One-time full migration: existing SQLite memory -> Notion
node bin/hippocore.js notion migrate --full

# OpenClaw self-call installer entrypoint (non-interactive)
node scripts/openclaw_self_install.js --project-root "/path/to/workspace"

# Optional: connect external sources
node bin/hippocore.js connect obsidian /path/to/vault
node bin/hippocore.js connect clawdbot /path/to/transcripts

# Sync all sources into memory core + render Obsidian views
node bin/hippocore.js sync

# Retrieve ranked candidates
node bin/hippocore.js retrieve "deployment decision" --project alpha

# Compose task-ready context
node bin/hippocore.js compose "what should we do next" --project alpha

# Mirror cloud Hippocore directory to local Mac folder
node bin/hippocore.js mirror pull --remote ubuntu@1.2.3.4:/srv/openclaw/hippocore --local ~/hippocore-cloud

# Push local edits back to cloud
node bin/hippocore.js mirror push --remote ubuntu@1.2.3.4:/srv/openclaw/hippocore --local ~/hippocore-cloud

# Two-way sync (prefer local changes)
node bin/hippocore.js mirror sync --remote ubuntu@1.2.3.4:/srv/openclaw/hippocore --local ~/hippocore-cloud --prefer local

# Check mirror onboarding status (blocked/ready)
node bin/hippocore.js mirror status

# Mark mirror onboarding complete (after local pull succeeds)
node bin/hippocore.js mirror complete --remote ubuntu@1.2.3.4:/srv/openclaw/hippocore --local ~/hippocore-cloud

# Upgrade (backup + reinstall integration + health check)
node bin/hippocore.js upgrade --openclaw-home "$HOME/.openclaw" --mode auto

# Inspect the OpenClaw runtime wiring currently installed on this machine
node bin/hippocore.js openclaw-runtime --openclaw-home "$HOME/.openclaw"

# Publish the current Git commit into a non-Git runtime overlay on the server
sudo ./scripts/deploy_runtime_overlay.sh --commit "$(git rev-parse HEAD)"

# Uninstall integration only (preserve hippocore data)
node bin/hippocore.js uninstall --yes --openclaw-home "$HOME/.openclaw"

# Full uninstall including workspace data
node bin/hippocore.js uninstall --yes --openclaw-home "$HOME/.openclaw" --drop-data

# Legacy compatibility alias (kept until v0.3)
node bin/memory.js query "deployment"
```

## Workspace Layout

`hippocore init` creates:

1. `hippocore/global/`
2. `hippocore/projects/`
3. `hippocore/imports/obsidian/`
4. `hippocore/imports/chats/`
5. `hippocore/system/config/hippocore.config.json`
6. `hippocore/system/db/hippocore.db`
7. `hippocore/system/views/*.md`
8. `hippocore/system/views/items/*.md`
9. `hippocore/system/views/Relations.md`

## Obsidian Integration

Projection outputs are Obsidian-friendly:

1. Type index views (`Decisions.md`, `Tasks.md`, etc.)
2. Per-item notes under `system/views/items/`
3. Structured frontmatter fields for relations (`relations_out`, `relations_in`)
4. Wiki links for Graph View navigation

## Storage Modes

1. `storage=local` (default):
2. Local files + SQLite workflow stays unchanged.
3. Cloud mode keeps mirror onboarding as required gate.
4. `storage=notion`:
5. Notion is source of truth for memory write/migrate and doc import.
6. SQLite remains local retrieval/index cache.
7. Session start reads cache immediately and triggers background Notion incremental sync.
8. Mirror onboarding gate is skipped in this mode.
9. Projection to local `.md` views is skipped in this mode.

## Memory Enrichment (Rule + LLM)

Default strategy is `hybrid_rule_llm_full`:

1. Every new memory item is enriched by rules first.
2. LLM then rewrites/augments `context_summary`, `meaning_summary`, `actionability_summary`, `next_action`, `owner_hint`.
3. Merge priority is `LLM > Rule > Empty`.
4. If LLM fails (timeout/429/5xx/invalid JSON), write path does not fail; item falls back to rule output.
5. Existing historical rows are not backfilled automatically.
6. Notion card mapping derives display-first fields: readable title, source category, and source decision path.

Config fields (`hippocore/system/config/hippocore.config.json`):

1. `quality.enrichment.enabled` (default `true`)
2. `quality.enrichment.strategy` (default `hybrid_rule_llm_full`)
3. `quality.enrichment.fieldsGate` (default `soft`)
4. `quality.enrichment.projectNameMap` (`project_id -> display name`)
5. `quality.enrichment.llm.provider` (`openai_compatible`)
6. `quality.enrichment.llm.baseUrl` / `model` / `apiKeyEnv`
7. `quality.enrichment.llm.timeoutMs` / `maxRetries` / `concurrency` / `temperature` / `maxOutputTokens`

## HTTP API

1. `POST /v1/memory/retrieve`
2. `POST /v1/memory/compose`
3. `POST /v1/memory/write`
4. `POST /v1/memory/review/promote`
5. `POST /v1/memory/review/archive`
6. `POST /v1/memory/sync`
7. `POST /v1/memory/context` (compatibility route)

## Tests

```bash
npm test
```

## Source Of Truth

Keep these three layers aligned:

1. Git repository is the only source of truth for Hippocore code and deployment docs.
2. Local workspace is for development and verification only.
3. Cloud runtime must be a deployed copy of a Git-backed workspace, not a hand-edited fork.

Operational rules:

1. Do not hot-edit the cloud runtime without reproducing the same change in Git immediately.
2. OpenClaw runtime manifest must point to the single authoritative plugin entry: `projectRoot/openclaw.plugin.js`.
3. After every install/upgrade/deploy, run `node bin/hippocore.js openclaw-runtime --openclaw-home "$HOME/.openclaw"` and verify:
4. `manifestEntrypoint === pluginEntrypoint`
5. `pluginEntrypointExists === true`
6. `sourceControl.current.gitCommit` matches the Git revision you intended to deploy.

The OpenClaw install metadata written to `$OPENCLAW_HOME/hippocore/install.json` records:

1. `projectRoot`
2. `pluginEntrypoint`
3. `sourceControl.gitCommit`
4. `sourceControl.gitBranch`
5. `sourceControl.gitDirty`

This is the supported way to verify that local, Git, and cloud runtime are still pointing at the same implementation.

Overlay publish behavior:

1. The runtime overlay deploy keeps Git-managed code paths aligned to the selected commit.
2. Runtime-only operational scripts already present under `scripts/` but absent from the Git repo are preserved across deploys.
3. Preserved runtime-only files are recorded in `.release-meta.json` under `preservedRuntimeFiles`.

## OpenClaw Trigger Support

1. Session-start trigger script: bundled `scripts/session_start.js` from the installed Hippocore package.
2. User prompt submit trigger script: bundled `scripts/user_prompt_submit.js` from the installed Hippocore package.
3. Session-checkpoint trigger script: bundled `scripts/session_checkpoint.js` from the installed Hippocore package.
4. Session-end distill trigger script: bundled `scripts/session_end.js` from the installed Hippocore package.
5. Plugin entry: `openclaw.plugin.js`
6. Hook config: `hooks/hooks.json`

IM checkpoint compatibility policy:

1. Current production-compatible path does not require native OpenClaw `SessionCheckpoint` support.
2. `assistant_message` is the primary compatibility surface for stage-finalization detection.
3. Hippocore detects assistant summary/compression/checkpoint-shaped replies and internally calls `triggerSessionCheckpoint(...)`.
4. Detection is high-precision by design: ordinary assistant replies should not trigger formal cards.
5. Native `session_checkpoint` / `SessionCheckpoint` hooks remain installed as forward-compatible enhancement points when runtime support exists.

Session memory policy:

1. Formal IM cards are finalized at checkpoint boundaries, not on every `user_prompt_submit`.
2. User messages remain the primary source of memory items.
3. Assistant messages are stored as supplemental context, except when a reply acts as a checkpoint anchor for stage summarization.
4. `session_end` is a tail fallback only: it processes messages after the last checkpoint boundary instead of re-distilling the whole session.

## One-Click Install Behavior

`hippocore setup` does:

1. Initialize `hippocore/` workspace and Obsidian-friendly scaffold directories/files.
2. Auto-connect sources:
3. `obsidianVault` from `--obsidian-vault` or local `.obsidian` detection.
4. `clawdbotTranscripts` from `--sessions` or `$OPENCLAW_HOME/agents/main/sessions`.
5. Install OpenClaw hooks into all discovered agent hook files under `$OPENCLAW_HOME/agents/*/agent/hooks.json` by default.
6. Optional subset install with `--install-agents main,friday_ch_xxx` (missing agents are skipped with warnings).
7. Write OpenClaw runtime metadata under `$OPENCLAW_HOME/hippocore/`.
8. Run initial `sync` and `doctor` checks.
9. Write `mirror.remote` / `mirror.local` defaults into `hippocore/system/config/hippocore.config.json`.
10. If mode is `cloud` (or auto-detected cloud), mark mirror onboarding as required.
11. If mirror onboarding is incomplete, setup returns `ok: false` and OpenClaw session start will inject a blocking guide.
12. If `--storage notion` is enabled, setup performs Notion onboarding/connectivity checks and skips mirror blocking.
13. Setup/upgrade accepts optional LLM flags:
14. `--llm-base-url`
15. `--llm-model`
16. `--llm-api-key-env`
17. `--llm-timeout-ms`
18. `--llm-concurrency`

You can disable parts with flags:

1. `--no-install-hooks`
2. `--no-sync`

Mirror prompt timing:

1. In cloud mode, mirror is a required onboarding gate.
2. Setup prints `mirror pull` and `mirror complete` actions.
3. `mirror_onboarding` must pass in `hippocore doctor` before install is considered complete.

Notion mode timing:

1. `notion_onboarding` must pass in `setup/install` and `doctor`.
2. `runSync` in notion mode performs automatic write-through for all ingested sources (hooks/runtime/doc imports/local sources).
3. Notion write path is strict: remote upsert succeeds before write is considered success.
4. Failed remote writes are stored in `notion_outbox` and keep item state as `pending_remote`.
5. `runSync` auto-flushes pending/failed `notion_outbox` entries on every run (including runs with no new sources).
6. Day-to-day ingestion does not require manual `hippocore notion migrate --full`; migrate remains for explicit full backfill.
7. `retrieve/compose` citations expose clickable `sourceUrl`, plus `notionPageUrl` and `notionBlockUrl` when available.
8. If notion memory schema has dedicated enrichment fields, they are written as structured properties.
9. If dedicated enrichment fields are missing, enrichment text is appended to Notion `Body` payload as fallback (including `Source URL` when available).
10. If notion onboarding is incomplete, `session_start` injects a blocking setup guide and will not inject normal memory context.

Health checks:

1. `hippocore doctor` includes `llm_enrichment`.
2. Missing LLM key is warning-only and does not block install/session start.

Sync/setup metrics:

1. `sync` and `setup` return `enrichmentStats`.
2. Fields: `llmSuccess`, `llmFallback`, `ruleOnly`, `llmErrors`.
3. In notion mode, `sync` also returns `notion.writeThrough`:
4. Fields: `attempted`, `succeeded`, `failed`, `outboxEnqueued`, `outboxFlushed`, `outboxFlushFailed`, `outboxPending`, `errors`.
5. If any write-through or outbox flush error occurs, `sync.status` is `partial`.

Memory quality notes:

1. Rule enrichment in notion-origin flows uses quote-first context (`Quoted evidence: "..."`) with source anchor intent.
2. When LLM enrichment is unavailable, rule fallback remains human-reviewable and traceable with source links.

Hooks behavior:

1. `setup/install` now merges Hippocore hooks into existing `hooks.json` (non-destructive).
2. Default target is all discovered agents (`--install-agents all`), not only `main`.
3. You can limit target agents with `--install-agents name1,name2` (missing names are skipped with warnings).
4. Re-running `setup/install` is idempotent and will not duplicate Hippocore hook entries.
5. `uninstall` scans all agents and strips only Hippocore hook entries by default instead of replacing the whole hooks file.
6. Hook commands bind to absolute package script paths (not `<project-root>/scripts/*`), so setup does not depend on copying trigger files into the OpenClaw project.
