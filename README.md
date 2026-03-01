# Hippocore (海马体)

A local-first shared memory system for human + AI collaboration.

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

1. Session-start trigger script: `/scripts/session_start.js`
2. User prompt submit trigger script: `/scripts/user_prompt_submit.js`
3. Plugin entry: `openclaw.plugin.js`
4. Hook config: `hooks/hooks.json`

## One-Click Install Behavior

`hippocore setup` does:

1. Initialize `hippocore/` workspace and Obsidian-friendly scaffold directories/files.
2. Auto-connect sources:
3. `obsidianVault` from `--obsidian-vault` or local `.obsidian` detection.
4. `clawdbotTranscripts` from `--sessions` or `$OPENCLAW_HOME/agents/main/sessions`.
5. Install OpenClaw hooks into `$OPENCLAW_HOME/agents/main/agent/hooks.json`.
6. Write OpenClaw runtime metadata under `$OPENCLAW_HOME/hippocore/`.
7. Run initial `sync` and `doctor` checks.
8. If mode is `cloud` (or auto-detected cloud), return immediate mirror recommendation after setup success.

You can disable parts with flags:

1. `--no-install-hooks`
2. `--no-sync`

Mirror prompt timing:

1. Recommend mirror creation only after `setup` phases are successful.
2. In cloud mode, show `mirror pull` command immediately after setup output.
