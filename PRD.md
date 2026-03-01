# Hippocore PRD

Version: v0.2  
Date: 2026-02-28  
Status: Implemented Baseline + Iterative Hardening

## 1. Background

Knowledge is fragmented across two channels:

1. Personal notes in Obsidian.
2. Ongoing human-AI chat sessions.

Without a memory layer, teams repeatedly lose decisions, constraints, and task context between sessions.

## 2. Product Vision

Hippocore (海马体) is a local-first shared memory system where:

1. Human and AI both write memory.
2. Human and AI both read memory.
3. Memory is evidence-backed, scoped, and reusable across future tasks.

## 3. v0.2 Goals

1. Unify Obsidian knowledge and chat interaction into one structured memory core.
2. Split retrieval and composition into separate modules for quality and maintainability.
3. Support layered memory scope (`project`, `global`, `temp`) with project-first retrieval.
4. Add explicit memory lifecycle (`candidate`, `verified`, `archived`).
5. Make relation graph visible in Obsidian using dual-track rendering.

## 4. Non-goals

1. Multi-tenant permission platform.
2. Heavy web dashboard.
3. Mandatory external vector infrastructure in v0.2.

## 5. Core Loops

## 5.1 Capture Loop

`Obsidian / chat -> normalize -> distill -> dedup -> relation write -> memory core`

## 5.2 Use Loop

`query -> retrieve -> compose -> AI execution -> write new candidate memory`

## 6. Memory Model

## 6.1 Memory Types

1. Entity
2. Project
3. Area
4. Decision
5. Insight
6. Task
7. Event

## 6.2 Memory State

1. `candidate`: tentative memory from chat or weak extraction.
2. `verified`: trusted memory for default retrieval.
3. `archived`: historical memory excluded from active projection.

## 6.3 Scope Layer

1. `project`: project-specific memory.
2. `global`: reusable cross-project memory.
3. `temp`: short-lived conversational memory.

## 6.4 Scope Inference Rules

1. Frontmatter has highest priority (`memory_scope`, `scope_level`, `project_id`).
2. Path fallback:
   - `/hippocore/projects/<project_id>/...` -> `project`
   - `/hippocore/global/...` -> `global`
3. Prompt/chat fallback:
   - with project id -> `project`
   - without project id -> `temp`

## 7. Retrieval & Composition Architecture

## 7.1 Retrieve (module)

Responsibilities:

1. Candidate recall (FTS + fallback recency scan).
2. Weighted ranking.
3. Scope-aware boost (`project > global > cross-project > temp/candidate`).
4. Relation edge expansion for selected items.
5. Retrieval logging (`retrieval_logs`).

Ranking signal weights in v0.2:

1. relevance: 0.45
2. freshness: 0.20
3. confidence: 0.15
4. importance: 0.10
5. scope_boost: 0.10

## 7.2 Compose (module)

Responsibilities:

1. Convert retrieved items into task-ready sections.
2. Output deterministic context blocks:
   - Constraints
   - Decisions
   - Tasks
   - Risks
   - Open Questions
3. Attach citations for every used item.
4. Update `use_count` and `last_used_at`.

## 7.3 Compatibility

Legacy `query/context` entrypoints are preserved and internally route to `retrieve + compose`.

## 8. Relation System + Obsidian Dual Track

## 8.1 Relation Types

1. `supports`
2. `contradicts`
3. `depends_on`
4. `related_to`
5. `belongs_to_project`
6. `derived_from`
7. `supersedes`

## 8.2 Dual-track rendering

1. Human graph navigation via `[[wikilink]]` in relation index.
2. Machine-readable relation metadata in item frontmatter:
   - `relations_out`
   - `relations_in`
   - `relation_type`
   - `weight`
   - `evidence_ref`

## 8.3 Projection outputs

1. Type index pages: `Decisions.md`, `Tasks.md`, `Insights.md`, `Projects.md`, `Entities.md`, `Events.md`, `Areas.md`
2. Item notes: `system/views/items/item-<id>.md`
3. Relation index: `system/views/Relations.md`

## 9. Workspace Initialization

`hippocore init` creates an Obsidian-openable workspace:

1. `/hippocore/README.md`
2. `/hippocore/global/`
3. `/hippocore/projects/`
4. `/hippocore/imports/obsidian/`
5. `/hippocore/imports/chats/`
6. `/hippocore/system/config/hippocore.config.json`
7. `/hippocore/system/db/hippocore.db`
8. `/hippocore/system/views/`
9. `/hippocore/system/logs/`
10. `/hippocore/system/backups/`

User can move existing notes/chats into `imports` or managed folders and run sync.

## 10. Data Schema (v0.2)

## 10.1 `memory_items` key fields

1. `state`
2. `scope_level`
3. `project_id`
4. `source_authority`
5. `canonical_key`
6. `use_count`
7. `last_used_at`
8. `review_reason`

## 10.2 Additional tables

1. `projects`
2. `retrieval_logs`
3. `memory_packs`

## 10.3 Backward compatibility

1. Auto column migration with `ALTER TABLE` when missing.
2. Backfill legacy rows for `state`, `scope_level`, and `canonical_key`.
3. Continue reading legacy `memory.config.json` if present.

## 11. Interfaces

## 11.1 CLI

Main command: `hippocore`.

Key commands:

1. `init`
2. `connect`
3. `sync`
4. `query` (compatibility behavior)
5. `retrieve`
6. `compose`
7. `write`
8. `review promote`
9. `review archive`
10. `pack build`
11. `doctor`
12. `backup` / `restore`
13. `trigger session-start` / `trigger user-prompt-submit`
14. `serve`

Compatibility alias retained: `memory`.

## 11.2 HTTP API

1. `POST /v1/memory/retrieve`
2. `POST /v1/memory/compose`
3. `POST /v1/memory/write`
4. `POST /v1/memory/review/promote`
5. `POST /v1/memory/review/archive`
6. `POST /v1/memory/sync`
7. `POST /v1/memory/context` (compatibility route)
8. `POST /v1/memory/pack/build`

## 11.3 OpenClaw Plugin Tools

1. `memory_context`
2. `memory_retrieve`
3. `memory_write`
4. `memory_sync`

## 12. Operational Requirements

1. One-process local deployment.
2. SQLite as canonical store.
3. Non-blocking trigger behavior on failures.
4. One-command backup and restore.
5. Projection remains human-readable in Obsidian.

## 13. Test & Acceptance (v0.2)

Core acceptance scenarios:

1. `init` creates full hippocore workspace layout.
2. Sync produces Area items and layered retrieval results.
3. Retrieve/Compose split returns citations and structured sections.
4. Relation extraction is written and rendered in projection files.
5. Write + promote/archive lifecycle works.
6. Trigger + backup/restore path remains functional.

Current baseline test status in repo: all tests pass (`npm test`).

## 14. Migration & Naming

1. Product name is Hippocore.
2. Config primary path is `hippocore/system/config/hippocore.config.json`.
3. Legacy command `memory` is retained as alias until v0.3.

## 15. Risks and Follow-up

1. Rule-based distillation can still introduce noisy candidate items.
2. Relation extraction is heuristic and should be refined iteratively.
3. Future v0.3 option: semantic retrieval provider behind feature flag.
