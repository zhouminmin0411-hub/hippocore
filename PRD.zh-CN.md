# Hippocore 产品需求文档（PRD）

版本：v0.2  
日期：2026-02-28  
状态：已落地基线 + 持续加固

## 1. 背景

当前知识分散在两条主线：

1. Obsidian 里的长期笔记。
2. 人机协作中的聊天会话。

缺少统一记忆层会导致决策、约束和任务上下文在多轮协作中反复丢失。

## 2. 产品愿景

Hippocore（海马体）是本地优先的共享记忆系统：

1. 人和 AI 都能写入记忆。
2. 人和 AI 都能读取记忆。
3. 记忆具备证据可追溯、作用域可控、可长期复用。

## 3. v0.2 目标

1. 将 Obsidian 知识与聊天增量统一沉淀到结构化记忆核心。
2. 将检索与上下文合成物理拆层，提升质量和可维护性。
3. 支持分层记忆作用域（`project/global/temp`）并采用“项目优先穿透”召回。
4. 引入状态机（`candidate/verified/archived`）。
5. 在 Obsidian 中实现关系双轨可视化。

## 4. 非目标

1. 多租户权限系统。
2. 重型 Web 管理后台。
3. v0.2 强依赖外部向量库。

## 5. 核心闭环

## 5.1 沉淀闭环（Capture Loop）

`Obsidian/会话 -> 归一化 -> 提炼 -> 去重 -> 关系写入 -> 记忆核心`

## 5.2 应用闭环（Use Loop）

`任务查询 -> 检索 -> 合成上下文 -> AI执行 -> 回写新候选记忆`

## 6. 记忆模型

## 6.1 记忆类型

1. Entity
2. Project
3. Area
4. Decision
5. Insight
6. Task
7. Event

## 6.2 记忆状态

1. `candidate`：会话或弱规则提炼出的候选记忆。
2. `verified`：可信记忆，默认参与主要检索。
3. `archived`：历史记忆，不进入活跃投影。

## 6.3 作用域分层

1. `project`：项目内记忆。
2. `global`：跨项目可复用记忆。
3. `temp`：短期会话记忆。

## 6.4 作用域归因规则

1. Frontmatter 优先（`memory_scope`、`scope_level`、`project_id`）。
2. 路径回退：
   - `/hippocore/projects/<project_id>/...` -> `project`
   - `/hippocore/global/...` -> `global`
3. Prompt/会话回退：
   - 有项目上下文 -> `project`
   - 无项目上下文 -> `temp`

## 7. 检索与合成架构

## 7.1 Retrieve（检索模块）

职责：

1. 候选召回（FTS + 无命中时回退到时序扫描）。
2. 多信号加权排序。
3. 作用域加权（项目 > 全局 > 跨项目 > temp/candidate）。
4. 关系边扩展。
5. 检索日志落库（`retrieval_logs`）。

v0.2 排序权重：

1. relevance：0.45
2. freshness：0.20
3. confidence：0.15
4. importance：0.10
5. scope_boost：0.10

## 7.2 Compose（记忆合成模块）

职责：

1. 将检索结果组装为任务可用上下文。
2. 固定输出结构：
   - Constraints
   - Decisions
   - Tasks
   - Risks
   - Open Questions
3. 为每条使用记忆附 citations。
4. 更新 `use_count` 与 `last_used_at`。

## 7.3 兼容策略

保留旧 `query/context` 入口，内部转调 `retrieve + compose`。

## 8. 关系系统与 Obsidian 双轨展示

## 8.1 关系类型

1. `supports`
2. `contradicts`
3. `depends_on`
4. `related_to`
5. `belongs_to_project`
6. `derived_from`
7. `supersedes`

## 8.2 双轨机制

1. 人类可读：关系索引中使用 `[[wikilink]]`，可直接用于 Graph View。
2. 机器可算：item 详情 frontmatter 中写结构化字段：
   - `relations_out`
   - `relations_in`
   - `relation_type`
   - `weight`
   - `evidence_ref`

## 8.3 投影输出

1. 类型索引页：`Decisions.md`、`Tasks.md`、`Insights.md`、`Projects.md`、`Entities.md`、`Events.md`、`Areas.md`
2. 条目详情：`system/views/items/item-<id>.md`
3. 关系索引：`system/views/Relations.md`

## 9. 初始化与目录规范

`hippocore init` 创建可直接被 Obsidian 打开的目录：

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

用户把历史内容迁入 `imports` 或管理目录后执行 `sync` 即可纳入记忆体系。

## 10. 数据模型（v0.2）

## 10.1 `memory_items` 关键字段

1. `state`
2. `scope_level`
3. `project_id`
4. `source_authority`
5. `canonical_key`
6. `use_count`
7. `last_used_at`
8. `review_reason`

## 10.2 新增表

1. `projects`
2. `retrieval_logs`
3. `memory_packs`

## 10.3 旧库兼容

1. 缺字段自动 `ALTER TABLE` 补齐。
2. 历史数据回填 `state/scope_level/canonical_key`。
3. 兼容读取 legacy `memory.config.json`。

## 11. 接口定义

## 11.1 CLI

主命令：`hippocore`

核心命令：

1. `init`
2. `connect`
3. `sync`
4. `query`（兼容行为）
5. `retrieve`
6. `compose`
7. `write`
8. `review promote`
9. `review archive`
10. `pack build`
11. `doctor`
12. `backup/restore`
13. `trigger session-start/user-prompt-submit`
14. `serve`

兼容别名保留：`memory`。

## 11.2 HTTP API

1. `POST /v1/memory/retrieve`
2. `POST /v1/memory/compose`
3. `POST /v1/memory/write`
4. `POST /v1/memory/review/promote`
5. `POST /v1/memory/review/archive`
6. `POST /v1/memory/sync`
7. `POST /v1/memory/context`（兼容路由）
8. `POST /v1/memory/pack/build`

## 11.3 OpenClaw 插件工具

1. `memory_context`
2. `memory_retrieve`
3. `memory_write`
4. `memory_sync`

## 12. 运维要求

1. 单进程本地部署。
2. SQLite 作为 canonical store。
3. Trigger 异常不阻塞主会话。
4. 备份/恢复单命令完成。
5. 投影结果保持 Obsidian 可读性。

## 13. 验收与测试（v0.2）

核心验收场景：

1. `init` 正确创建 hippocore 标准目录。
2. `sync` 后能产出 Area，并体现分层召回效果。
3. `retrieve/compose` 拆层后可输出结构化 sections 与 citations。
4. 关系可写入并在投影中可视化。
5. `write + promote/archive` 生命周期可用。
6. trigger + backup/restore 链路可用。

当前仓库基线：测试已通过（`npm test`）。

## 14. 命名与迁移策略

1. 产品名统一为 Hippocore（海马体）。
2. 主配置路径为 `hippocore/system/config/hippocore.config.json`。
3. `memory` 作为兼容命令保留到 v0.3。

## 15. 风险与后续

1. 规则提炼仍可能引入噪声候选项。
2. 关系抽取目前为启发式策略，需持续优化。
3. v0.3 可在 feature flag 下引入语义检索提供方。
