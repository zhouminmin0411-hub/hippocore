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
node bin/hippocore.js setup --openclaw-home "$HOME/.openclaw" --obsidian-vault "/path/to/vault"

# Guided install alias (same as setup)
node bin/hippocore.js install --openclaw-home "$HOME/.openclaw" --mode auto

# Notion-only setup (Notion as source of truth, SQLite as retrieval cache)
export NOTION_API_KEY="secret_xxx"
node bin/hippocore.js setup \
  --storage notion \
  --notion-memory-datasource-id "<memory_ds_id>" \
  --notion-relations-datasource-id "<relations_ds_id>" \
  --notion-doc-datasource-ids "<docs_ds_id_1>,<docs_ds_id_2>"

# Check notion readiness / connectivity
node bin/hippocore.js notion status

# Pull Notion docs incrementally into local retrieval cache
node bin/hippocore.js notion sync

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

## OpenClaw Trigger Support

1. Session-start trigger script: bundled `scripts/session_start.js` from the installed Hippocore package.
2. User prompt submit trigger script: bundled `scripts/user_prompt_submit.js` from the installed Hippocore package.
3. Session-end distill trigger script: bundled `scripts/session_end.js` from the installed Hippocore package.
4. Plugin entry: `openclaw.plugin.js`
5. Hook config: `hooks/hooks.json`

Session-end memory policy:

1. Distill from the full session (user + assistant messages).
2. User messages are the primary source of memory items.
3. Assistant messages are stored as supplemental context only and are not written as standalone user memory.

## One-Click Install Behavior

`hippocore setup` does:

1. Initialize `hippocore/` workspace and Obsidian-friendly scaffold directories/files.
2. Auto-connect sources:
3. `obsidianVault` from `--obsidian-vault` or local `.obsidian` detection.
4. `clawdbotTranscripts` from `--sessions` or `$OPENCLAW_HOME/agents/main/sessions`.
5. Install OpenClaw hooks into `$OPENCLAW_HOME/agents/main/agent/hooks.json`.
6. Write OpenClaw runtime metadata under `$OPENCLAW_HOME/hippocore/`.
7. Run initial `sync` and `doctor` checks.
8. Write `mirror.remote` / `mirror.local` defaults into `hippocore/system/config/hippocore.config.json`.
9. If mode is `cloud` (or auto-detected cloud), mark mirror onboarding as required.
10. If mirror onboarding is incomplete, setup returns `ok: false` and OpenClaw session start will inject a blocking guide.
11. If `--storage notion` is enabled, setup performs Notion onboarding/connectivity checks and skips mirror blocking.

You can disable parts with flags:

1. `--no-install-hooks`
2. `--no-sync`

Mirror prompt timing:

1. In cloud mode, mirror is a required onboarding gate.
2. Setup prints `mirror pull` and `mirror complete` actions.
3. `mirror_onboarding` must pass in `hippocore doctor` before install is considered complete.

Notion mode timing:

1. `notion_onboarding` must pass in `setup/install` and `doctor`.
2. Notion write path is strict: remote upsert succeeds before write is considered success.
3. Failed remote writes are stored in `notion_outbox` and keep item state as `pending_remote`.
4. `retrieve/compose` citations expose `notionPageUrl` when mapped.
5. If notion onboarding is incomplete, `session_start` injects a blocking setup guide and will not inject normal memory context.

Hooks behavior:

1. `setup/install` now merges Hippocore hooks into existing `hooks.json` (non-destructive).
2. Re-running `setup/install` is idempotent and will not duplicate Hippocore hook entries.
3. `uninstall` strips only Hippocore hook entries by default instead of replacing the whole hooks file.
4. Hook commands bind to absolute package script paths (not `<project-root>/scripts/*`), so setup does not depend on copying trigger files into the OpenClaw project.
