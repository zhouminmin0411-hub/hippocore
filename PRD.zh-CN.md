
# Hippocore 产品需求文档（PRD）

版本：v0.2.1  
日期：2026-03-04  
状态：已实现（云端 Notion 优先 + 本地模式兼容）

## 1. 背景

知识分散在聊天、本地文件和云端文档中。旧版本过度强调 Obsidian 投影，导致云端安装与使用门槛较高。

当前方向是：

1. 保留 `local` 模式给文件优先用户。
2. 云端安装默认优先 `storage=notion`。
3. notion 模式下由 Notion 作为真源，SQLite 作为检索缓存。

## 2. 产品愿景

Hippocore 是 OpenClaw 的记忆基础设施：

1. 将人机交互沉淀为结构化记忆。
2. 记忆具备证据可追溯、作用域可控、可复用。
3. 支持本地优先与 Notion 优先两种存储形态，对外检索接口一致。

## 3. v0.2.1 目标

1. 正式支持双存储模式：`local` 与 `notion`。
2. 云端安装默认走 Notion，并强制完成 Notion 关键配置。
3. 保证 notion 模式写入一致性：远端成功才算成功。
4. 保持 retrieve/compose 拆层和分层召回稳定。
5. 通过规则 + LLM 增强提升记忆可读性。
6. OpenClaw hooks 默认支持多 agent 安装与清理。

## 4. 非目标

1. 多租户 RBAC 权限平台。
2. 独立重型 Web 管理后台。
3. v0.2.1 自建文档展示系统替代 Notion。

## 5. 核心闭环

## 5.1 沉淀闭环（Local 模式）

`本地文件/会话 -> 归一化 -> 提炼 -> 去重 -> 关系写入 -> SQLite -> .md 投影`

## 5.2 沉淀闭环（Notion 模式）

`Notion 文档/会话/runtime 来源 -> 归一化 -> 提炼 -> 增强 -> SQLite(pending_remote) -> 严格 Notion upsert -> SQLite 回写同步状态`

## 5.3 应用闭环

`任务查询 -> 检索 -> 合成上下文 -> AI 执行 -> 回写新记忆`

会话启动策略：

1. 默认 `includeCandidate=false`。
2. 先读 SQLite 缓存，不阻塞注入。
3. notion 模式后台触发一次增量同步。

## 6. 存储与 Onboarding

## 6.1 存储模式

1. `storage=local`：
2. 本地文件 + SQLite + Obsidian 友好投影。
3. 云端该模式下 mirror onboarding 仍是必过门禁。
4. `storage=notion`：
5. Notion 作为记忆写入与文档导入真源。
6. SQLite 保留为检索/索引缓存。
7. 跳过 mirror 门禁。
8. `.md` 投影不再是该模式主链路。

## 6.2 Notion Onboarding 强门槛

notion 模式必须配置：

1. `memoryDataSourceId`
2. `relationsDataSourceId`
3. `docDataSourceIds`（必须项，不再是 warning）

缺失或校验失败时：

1. setup/install 进入 blocked 状态。
2. doctor 判定 notion 未就绪。
3. session-start 注入阻断引导，停止正常记忆注入。

## 6.3 首次全量 + 后续增量

1. notion 首次安装成功后自动执行一次 full backfill。
2. 后续基于 cursor（`last_edited_time`）增量拉取。

## 6.4 写透与补偿

notion 模式下，`runSync` 对所有导入 source 执行写透（hooks/runtime/doc imports/local sources）：

1. 成功路径：远端 upsert 成功，条目回到业务状态。
2. 失败路径：条目保持 `pending_remote`，写入 `notion_outbox`。
3. 总状态：任一写透或 outbox flush 失败，`sync.status=partial`。
4. 每次 `runSync` 自动 flush pending/failed outbox 项。

## 7. 记忆模型

## 7.1 记忆类型

1. Entity
2. Project
3. Area
4. Decision
5. Insight
6. Task
7. Event

## 7.2 记忆状态

1. `candidate`：会话或弱规则提炼出的候选记忆。
2. `verified`：可信记忆，默认参与检索。
3. `archived`：历史记忆，不进入活跃集。
4. `pending_remote`：notion 模式远端失败后的过渡状态，恢复前不参与检索。

## 7.3 作用域分层

1. `project`
2. `global`
3. `temp`

## 7.4 作用域归因

1. Frontmatter 优先（`memory_scope`、`scope_level`、`project_id`）。
2. 路径回退：
3. `/hippocore/projects/<project_id>/...` -> `project`
4. `/hippocore/global/...` -> `global`
5. Prompt/会话回退：
6. 有项目上下文 -> `project`
7. 无项目上下文 -> `temp`

## 8. 检索与合成

## 8.1 Retrieve

职责：

1. 候选召回（FTS + 时序回退）。
2. 多信号排序。
3. 作用域加权（项目 > 全局 > 跨项目 > temp/candidate）。
4. 关系边扩展。
5. 检索日志记录。

排序权重：

1. relevance：0.45
2. freshness：0.20
3. confidence：0.15
4. importance：0.10
5. scope_boost：0.10

## 8.2 Compose

职责：

1. 生成固定结构化上下文。
2. 每条引用附 citation。
3. 更新 `use_count` 与 `last_used_at`。
4. 优先使用增强字段（`meaning_summary`、`next_action`）提升可读性。

citation 输出：

1. `sourceUrl`
2. `notionPageUrl`（有则返回）
3. `notionBlockUrl`（有则返回）

## 9. 记忆增强（规则 + LLM）

默认策略：`hybrid_rule_llm_full`。

1. 所有新增记忆先走规则增强。
2. 再走 LLM 增强。
3. 合并优先级：`LLM > Rule > Empty`。
4. LLM 失败不阻断写入（fail-open，回退规则结果）。
5. 不自动回填历史数据。

核心增强字段：

1. `context_summary`
2. `meaning_summary`
3. `actionability_summary`
4. `next_action`
5. `owner_hint`
6. `project_display_name`

卡片展示衍生字段（用于 Notion 可读性/可视化）：

1. `readable_title`（去掉机器前缀，保留人可读主题）
2. `source_category`（Notion/会话/手动写入/导入/文件）
3. `source_decision_path`（带锚点/行号的清晰来源路径）

## 10. 关系系统与展示

关系类型：

1. `supports`
2. `contradicts`
3. `depends_on`
4. `related_to`
5. `belongs_to_project`
6. `derived_from`
7. `supersedes`

展示策略：

1. local 模式保持 Obsidian 双轨（`[[wikilink]]` + frontmatter 结构化字段）。
2. notion 模式以 Notion 视图/页面浏览为主，`.md` 投影为可选兼容路径。

## 11. 数据模型

## 11.1 `memory_items` 关键新增

1. `notion_page_id`
2. `notion_last_synced_at`
3. `remote_version`
4. 增强字段列（`context_summary`、`meaning_summary`、`actionability_summary`、`next_action`、`owner_hint`、`project_display_name`、`enrichment_source`、`enrichment_version`、`llm_enriched_at`）

## 11.2 新增表

1. `notion_outbox`（远端写入重试队列）
2. `notion_sync_state`（cursor 与同步健康状态）

## 11.3 兼容策略

1. 保持自动 schema 迁移。
2. 保留 `memory` 兼容命令别名。
3. local 模式行为保持向后兼容。

## 12. 接口定义

## 12.1 CLI

主命令：`hippocore`

核心命令：

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
13. `mirror status|pull|push|sync|complete`（local/cloud mirror 路径）

关键安装参数：

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
7. `POST /v1/memory/context`（兼容路由）

## 12.3 OpenClaw 插件工具

1. `memory_context`
2. `memory_retrieve`
3. `memory_write`
4. `memory_sync`

## 13. OpenClaw 集成要求

1. setup/install 默认对所有已发现 agent 注入 hooks。
2. 显式 agent 列表中缺失项只告警不阻断。
3. 重复 setup 保证幂等，不重复注入。
4. uninstall 默认扫描全部 agent，仅删除 Hippocore 管理项。
5. 当前 IM 阶段定稿的兼容路径是 `assistant_message` 总结锚点识别 + `session_end` 尾段兜底，不依赖 OpenClaw 原生 `SessionCheckpoint`。
6. 原生 `SessionCheckpoint` hook 仍然保留，作为未来 runtime 支持后的增强入口，而不是当前运行前提。

## 14. 验收与测试

必须通过的验收场景：

1. notion 必填参数缺失时 setup 被门禁阻断。
2. notion 首次 setup 自动触发 full backfill。
3. notion 模式 runtime/hook 导入自动写透（无需日常手工 migrate）。
4. 任一远端失败可见（`partial + errors`）且进入 outbox。
5. 后续 sync 自动重试并恢复 pending 项。
6. 多 agent hooks 安装/卸载安全且幂等。
7. 规则 + LLM 增强遵循 fail-open。
8. local 模式与 mirror 流程可正常回归。

当前仓库基线：`npm test` 通过。

## 15. 风险与后续

1. Notion API 限流会影响同步时延。
2. LLM 增强带来成本与尾延迟，需要持续控制超时与并发。
3. 不同 workspace 的 Notion 字段漂移可能需要持续维护 alias。
4. v0.3 可在 feature flag 下引入更强语义检索方案。
