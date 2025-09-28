# Hippocore PRD

Version: v0.2.1  
Date: 2026-03-04  
Status: Implemented (Notion-first cloud + local compatibility)

## 1. Background

Knowledge is fragmented across chats, local files, and cloud docs. Earlier versions over-emphasized Obsidian projection, which created cloud onboarding friction.

Current product direction is:

1. Keep `local` mode for file-first users.
2. Make cloud onboarding default to `storage=notion`.
3. Treat Notion as source of truth in notion mode, with SQLite as retrieval cache.

## 2. Product Vision

Hippocore is memory infrastructure for OpenClaw where:

1. Human + AI interactions are distilled into structured memory.
2. Memory is evidence-backed, scoped, and reusable.
3. Storage can run in local-first or Notion-first mode without changing retrieval APIs.

## 3. v0.2.1 Goals

1. Ship dual storage modes: `local` and `notion`.
2. Cloud default onboarding prefers Notion and enforces required Notion inputs.
3. Ensure notion-mode write consistency: remote success determines write success.
4. Keep retrieval/compose split and layered ranking stable.
5. Improve memory readability via rule + LLM enrichment.
6. Make OpenClaw hook installation/uninstall multi-agent safe by default.

## 4. Non-goals

1. Multi-tenant RBAC platform.
2. Dedicated web admin dashboard.
3. Replacing Notion with a custom document UI in v0.2.1.

## 5. Core Loops

## 5.1 Capture Loop (Local mode)

`local files/chats -> normalize -> distill -> dedup -> relation write -> SQLite -> .md projection`

## 5.2 Capture Loop (Notion mode)

`Notion docs/chats/runtime sources -> normalize -> distill -> enrich -> SQLite(pending_remote) -> strict Notion upsert -> SQLite sync mark`

## 5.3 Use Loop

`query -> retrieve -> compose -> AI execution -> write new memory`

Session start behavior:

1. Default `includeCandidate=false`.
2. Read SQLite cache immediately.
3. In notion mode, trigger background incremental sync.

## 6. Storage & Onboarding

## 6.1 Storage Modes

1. `storage=local`:
2. Local files + SQLite + Obsidian-friendly projection.
3. In cloud mode, mirror onboarding remains a required gate.
4. `storage=notion`:
5. Notion is source of truth for memory writes and doc imports.
6. SQLite remains retrieval/index cache.
7. Mirror onboarding gate is skipped.
8. `.md` projection is not the primary chain in this mode.

## 6.2 Notion Onboarding Gate (Hard Requirement)

Required configuration in notion mode:

1. `memoryDataSourceId`
2. `relationsDataSourceId`
3. `docDataSourceIds` (required, not warning)

If missing or invalid:

1. Setup/install returns blocked state.
2. Doctor fails notion readiness.
3. Session-start injects blocking guidance instead of normal memory context.

## 6.3 Initial Backfill + Incremental Sync

1. First successful notion setup runs full backfill from `docDataSourceIds`.
2. Subsequent sync uses cursor-based incremental pull (`last_edited_time` + stored cursor).

## 6.4 Write-through and Recovery

In notion mode, `runSync` applies write-through for all ingested sources (hooks/runtime/doc imports/local sources):

1. Success path: remote upsert succeeds, item returns to business state.
2. Failure path: item remains `pending_remote`, enqueue to `notion_outbox`.
3. Overall sync status: any write-through/outbox flush failure marks `status=partial`.
4. Every `runSync` auto-flushes pending/failed outbox entries.

## 7. Memory Model

## 7.1 Memory Types

1. Entity
2. Project
3. Area
4. Decision
5. Insight
6. Task
7. Event

## 7.2 Memory States

1. `candidate`: tentative memory from chat or weak extraction.
2. `verified`: trusted memory for default retrieval.
3. `archived`: historical memory outside active use.
4. `pending_remote`: notion-mode transient state for failed remote write; excluded from retrieval until recovered.

## 7.3 Scope Layers

1. `project`
2. `global`
3. `temp`

## 7.4 Scope Inference

1. Frontmatter priority (`memory_scope`, `scope_level`, `project_id`).
2. Path fallback:
3. `/hippocore/projects/<project_id>/...` -> `project`
4. `/hippocore/global/...` -> `global`
5. Prompt/chat fallback:
6. with project id -> `project`
7. without project id -> `temp`

## 8. Retrieval & Composition

## 8.1 Retrieve

Responsibilities:

1. Candidate recall (FTS + recency fallback).
2. Weighted ranking.
3. Scope-aware boost (`project > global > cross-project > temp/candidate`).
4. Relation edge expansion.
5. Retrieval logging.

Ranking weights:

1. relevance: 0.45
2. freshness: 0.20
3. confidence: 0.15
4. importance: 0.10
5. scope_boost: 0.10

## 8.2 Compose

Responsibilities:

1. Build deterministic context sections.
2. Include citations for each used item.
3. Update usage counters.
4. Prefer enriched readable fields (`meaning_summary`, `next_action`) when available.

Citation outputs:

1. `sourceUrl`
2. `notionPageUrl` (when available)
3. `notionBlockUrl` (when available)

## 9. Memory Enrichment (Rule + LLM)

Default strategy: `hybrid_rule_llm_full`.

1. All new items run rule enrichment first.
2. Then run LLM enhancement over rule output.
3. Merge priority: `LLM > Rule > Empty`.
4. LLM failure is fail-open (write path continues with rule output).
5. No automatic historical backfill.

Core enriched fields:

1. `context_summary`
2. `meaning_summary`
3. `actionability_summary`
4. `next_action`
5. `owner_hint`
6. `project_display_name`

Card display derivatives (for Notion readability/visualization):

1. `readable_title` (strip machine prefix, keep human-readable subject)
2. `source_category` (Notion/session/manual/import/file)
3. `source_decision_path` (clear source trace with anchor/line range)

## 10. Relation System & Projection

Relation types:

1. `supports`
2. `contradicts`
3. `depends_on`
4. `related_to`
5. `belongs_to_project`
6. `derived_from`
7. `supersedes`

Projection behavior:

1. Local mode keeps Obsidian-friendly dual track (`[[wikilink]]` + structured frontmatter).
2. Notion mode prioritizes Notion views/pages for browsing; `.md` projection is optional/non-primary.

## 11. Data Schema

## 11.1 `memory_items` key additions

1. `notion_page_id`
2. `notion_last_synced_at`
3. `remote_version`
4. enrichment columns (`context_summary`, `meaning_summary`, `actionability_summary`, `next_action`, `owner_hint`, `project_display_name`, `enrichment_source`, `enrichment_version`, `llm_enriched_at`)

## 11.2 New tables

1. `notion_outbox` (remote write retry queue)
2. `notion_sync_state` (cursor + sync health)

## 11.3 Compatibility

1. Auto schema migration remains enabled.
2. Legacy command alias `memory` is retained.
3. Local mode behavior remains backward compatible.

## 12. Interfaces

## 12.1 CLI

Main command: `hippocore`.

Key commands:

1. `init`
2. `setup` / `install`
3. `sync`
4. `retrieve`
5. `compose`
6. `write`
7. `doctor`
8. `upgrade`
9. `uninstall`
10. `notion status`
11. `notion sync`
12. `notion migrate --full`
13. `mirror status|pull|push|sync|complete` (for local storage/cloud mirror flows)

Key setup flags:

1. `--storage local|notion`
2. `--notion-memory-datasource-id`
3. `--notion-relations-datasource-id`
4. `--notion-doc-datasource-ids`
5. `--install-agents all|name1,name2`
6. `--llm-base-url --llm-model --llm-api-key-env --llm-timeout-ms --llm-concurrency`

## 12.2 HTTP API

1. `POST /v1/memory/retrieve`
2. `POST /v1/memory/compose`
3. `POST /v1/memory/write`
4. `POST /v1/memory/review/promote`
5. `POST /v1/memory/review/archive`
6. `POST /v1/memory/sync`
7. `POST /v1/memory/context` (compatibility route)

## 12.3 OpenClaw Plugin Tools

1. `memory_context`
2. `memory_retrieve`
3. `memory_write`
4. `memory_sync`

## 13. OpenClaw Integration Requirements

1. Setup/install default hook target: all discovered agents.
2. Missing explicit agent names are skipped with warnings, not hard failures.
3. Re-running setup is idempotent (no duplicate Hippocore hooks).
4. Uninstall scans all agents and removes only Hippocore-managed hook entries.
5. Current IM phase-finalization compatibility path uses `assistant_message` anchor detection plus `session_end` tail fallback; it does not require native OpenClaw `SessionCheckpoint`.
6. Native `SessionCheckpoint` hook wiring is preserved as a forward-compatible enhancement path, not a runtime prerequisite.

## 14. Test & Acceptance

Must-pass scenarios:

1. Notion onboarding hard-gates setup when required IDs are missing.
2. First notion setup triggers full backfill.
3. Notion-mode runtime ingestion auto writes through (no daily manual migrate needed).
4. Any remote write failure is visible (`partial + errors`) and queued in outbox.
5. Outbox auto-flush recovers pending items on later sync.
6. Multi-agent hook install/uninstall is safe and idempotent.
7. Rule + LLM enrichment follows fail-open policy.
8. Local mode and mirror-based flows remain functional.

Current repo baseline: `npm test` passing.

## 15. Risks & Follow-up

1. Notion API rate limits can impact sync latency.
2. LLM enrichment adds cost and tail-latency; keep timeout/concurrency controlled.
3. Notion schema drift across workspaces may require alias updates.
4. v0.3 follow-up can add richer semantic retrieval options behind feature flags.

中文版：obsidian://open?vault=memory&file=PRD.zh-CN
[[PRD.zh-CN]]
