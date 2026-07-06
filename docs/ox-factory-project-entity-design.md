# 牛马工厂 Project Entity 轻量设计

更新时间：2026-07-04  
负责人：派派  
状态：MVP 落地中

## 背景

牛马工厂已有员工实体，但项目长期只是 `project: string`。这导致：

- 员工职责只能写笼统项目名，容易出现同义项目名分裂。
- 布朗尼/日报/飞书文档可以记录进展，但工厂没有项目全景。
- Web 大盘只能从 job.project 派生项目视角，不能知道项目 owner、todo、source of truth、worktree。
- 后续按项目分配 worktree、统计投入、找负责人都不稳定。

## 目标

把“项目”提升为和“员工”类似的一等实体，但保持轻量。

MVP 只记录必要信息：

1. 项目基本信息：id、名称、摘要、状态、优先级、别名。
2. Single Source of Truth：指向 Markdown / 飞书 / 外部 checklist / 其他权威文档。
3. Todo：项目待办事项，支持状态、负责人、证据链接。
4. Worktree：项目相关工作树，支持路径、分支、负责人、状态。
5. Progress：项目进展流水，供日报/报告消费。
6. Members：项目相关人员及关系。

## 非目标

MVP 不做：

- 完整 Jira/Linear 替代品。
- 飞书自动同步。
- Web 项目页面实现。
- 历史 job 数据迁移。
- 强制所有 job 都必须绑定 projectId。
- Checklist 复杂 CRUD。需要文本表达的 checklist 仍放在文档里，Project 只保存链接。

## 数据边界

### Project 本体

Project 本体存放在：

```text
.pi/workers/projects.jsonl
```

采用 append-only event log，和职责、通信、job 事件风格一致。

### 文档真相源

项目详细 checklist / 方案 / 汇报格式可以继续放在：

```text
docs/ox-projects/*.md
飞书文档
其他外部链接
```

Project 实体只记录 `truth` 链接，不复制长文档内容。

### 员工关系

项目成员关系可以由两处组成：

1. `projects.jsonl` 中的 member 事件：项目视角下的人员关系。
2. `responsibilities.jsonl`：员工视角下的当前职责。

MVP 先不强制合并两者。后续 Web 项目页可以同时读取。

## Project 字段

```json
{
  "id": "ox-factory-web",
  "name": "牛马工厂 Web 大盘",
  "summary": "本地只读工厂驾驶舱",
  "status": "active",
  "priority": "P1",
  "aliases": ["web-dashboard", "工厂大盘"],
  "truth": {
    "type": "markdown",
    "ref": "docs/ox-projects/ox-factory-web.md",
    "note": "项目 checklist 以此文档为准"
  },
  "links": [
    { "type": "dashboard", "label": "本地大盘", "ref": "http://127.0.0.1:8787" }
  ],
  "members": [],
  "todos": [],
  "worktrees": [],
  "progress": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

## 状态约定

项目状态：

- `active`：进行中
- `paused`：暂停
- `done`：完成
- `archived`：归档

Todo 状态：

- `todo`
- `doing`
- `done`
- `blocked`
- `dropped`

Worktree 状态：

- `active`
- `paused`
- `merged`
- `abandoned`

Member 状态：

- `active`
- `inactive`

## 工具设计

MVP 工具：

| 工具 | 用途 |
| --- | --- |
| `factory_project_upsert` | 创建/更新项目基本信息和 truth/links |
| `factory_project_list` | 查看项目列表或单个项目详情 |
| `factory_project_todo_set` | 新增/更新项目 todo |
| `factory_project_worktree_set` | 新增/更新项目 worktree |
| `factory_project_progress_add` | 追加项目进展流水 |
| `factory_project_member_set` | 设定项目人员关系 |

## 兼容策略

1. 旧工具继续接收 `project: string`。
2. 老 job 没有 `projectId`，Web/报告仍按字符串展示。
3. 新 Project 支持 `aliases`，后续可以把 `工厂大盘`、`web-dashboard` 等自然语言名称解析到同一项目。
4. `responsibilities.jsonl` 暂不强制迁移；可通过项目 member 和员工 responsibility 双写实现渐进统一。
5. Project 文档可以先手写，后续再由 LLM 根据 `projects.jsonl + jobs + messages + reports` 生成规范报告。

## 后续演进

1. Web 项目页：`/projects` 和 `/projects/:id`。
2. 项目维度日报：按 Project 聚合 jobs、token、messages、progress。
3. Project ↔ Responsibility 自动关联：通过 projectId 和 aliases 对齐。
4. Worktree 生命周期管理：创建、清理、审计。
5. 飞书同步：把项目文档作为展示/协作层，不反向污染本地实体。
