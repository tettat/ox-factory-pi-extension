# 项目：牛马工厂 Project Entity / 项目视角

## 项目状态

- Project ID：`ox-factory-project-entity`
- 状态：active
- 优先级：P0
- Owner：派派
- 参与人：派派、八村（后续可视化）
- 最近更新：2026-07-04

## 项目目标

把“项目”提升为牛马工厂里和“员工”类似的一等实体，用轻量方式维护项目信息、source-of-truth、Todo、Worktree、进展和相关人员。

## 非目标

- 不做 Jira/Linear 替代品。
- 不做飞书自动同步。
- 不在 MVP 里迁移历史 job。
- 不在 MVP 里实现 Web 项目页。
- 不把长 checklist 复制进结构化数据，长文档继续放 Markdown/飞书。

## Single Source of Truth

- 类型：markdown
- 链接：`docs/ox-projects/ox-factory-project-entity.md`
- 设计说明：`docs/ox-factory-project-entity-design.md`

## 当前阶段

Phase 1：Project Entity MVP 数据层 + 主 agent 工具。

## Checklist

| 项 | 状态 | 负责人 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| 设计 Project Entity 轻量模型 | done | 派派 | `docs/ox-factory-project-entity-design.md` | 已确认不做重型系统 |
| 实现 `projects.jsonl` append-only 数据层 | done | 派派 | `.pi/extensions/ox-factory/projects.mjs` | 支持回放快照 |
| 实现 `factory_project_*` 工具 | done | 派派 | `.pi/extensions/ox-factory/index.ts` | reload 后主 agent 可用 |
| 提供项目文档模板 | done | 派派 | `docs/ox-projects/_template.md` | 给布朗尼/八村/后续 LLM 使用 |
| Web 项目视角可视化 | todo | 八村 | `/api/projects.catalog` | 后续派给八村 |

## Worktrees

| 路径 | 分支 | 负责人 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| `<host-project-root>` | 当前工作区 | 派派 | active | 插件代码与文档维护 |

## 进展记录

| 日期 | 负责人 | 状态 | 进展 | 证据 |
| --- | --- | --- | --- | --- |
| 2026-07-04 | 派派 | done | Project Entity MVP 数据层、工具、文档模板进入实现 | `.pi/extensions/ox-factory/projects.mjs` |

## 关键决策

- 2026-07-04：项目管理先做轻量实体 + 文档 truth 链接，不做重型项目管理系统。
- 2026-07-04：长 checklist 仍由 Markdown/飞书承载，结构化 Project 只记录必要索引。

## 风险 / 待讨论

- Project members 与 responsibilities 未来是否要自动双写。
- job 派活链路未来是否补 `projectId`。
- Web 项目页由八村后续实现时，需要避免从散文件重复造解析。

## 相关链接

- 设计：`docs/ox-factory-project-entity-design.md`
- 总账：`docs/ox-factory-improvement-tracker.md#of-002没有统一-project-实体`
- 质量 checklist：`docs/ox-factory-quality-checklist.md#of-002-project-entity--项目视角`
