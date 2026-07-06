# 牛马工厂改进问题清单

> 项目代号：talk / ox-factory  
> 首次整理：2026-06-30  
> 维护方式：后续逐条讨论、逐条更新、逐步修复。  
> 范围说明：本文件只记录 `.pi/extensions/ox-factory` 与 `.pi/workers` 相关问题；暂不分析 AlphaMind 后端业务代码。

## 使用规则

1. 每个问题使用稳定编号 `OF-xxx`，后续讨论和提交都引用编号。
2. 每条问题尽量保持小而清晰：现状、影响、兼容性、建议方向。
3. 状态枚举：
   - `open`：已发现，未深入设计。
   - `discussing`：正在讨论方案。
   - `planned`：方案已定，待实现。
   - `in-progress`：正在实现。
   - `done`：已修复或已落地。
   - `deferred`：暂缓。
4. 兼容性分级：
   - `高`：可读旧数据、保持旧工具调用方式，基本不影响现有使用。
   - `中`：需要读旧写新或双轨过渡。
   - `低`：会影响现有路径、数据或使用习惯，需要迁移计划。

## 总览

| ID | 问题 | 优先级 | 状态 | 兼容性 |
|---|---|---:|---|---|
| OF-001 | 员工缺少“职责 / 负责项目”一等字段 | P0 | done（最小数据层已落地） | 高 |
| OF-002 | 没有统一 Project 实体 | P0 | in-progress（Project Entity MVP 已落地） | 中 |
| OF-003 | `projects` 同时承担履历和项目关系，语义混杂 | P1 | open | 高 |
| OF-004 | 履历记录运行时去重，但恢复时不去重 | P0 | open | 高 |
| OF-005 | fire / rehire 同名员工的生命周期语义不清 | P1 | open | 中 |
| OF-006 | `ox-worker-config` 追加过多，主 session 变脏 | P1 | in-progress（已修配置全量快照覆盖） | 高 |
| OF-007 | reload 时无条件把 open job 标为 stale | P0 | in-progress | 中 |
| OF-008 | job 缺少 PID / heartbeat / owner，无法可靠恢复 | P0 | in-progress | 高 |
| OF-009 | job 已 stale 后仍可能继续写 event | P0 | in-progress | 中 |
| OF-010 | 内存队列和 talk 状态 reload 后丢失 | P0 | open | 中 |
| OF-011 | in-process job 和 runner 队列是两套状态系统 | P1 | open | 中 |
| OF-012 | Codex active turn 不可恢复，配置持久化边界不清 | P1 | open | 中 |
| OF-013 | `factory_transfer` 当前更像说明，不是真迁移 | P2 | open | 高 |
| OF-014 | 插件源码和 runtime 数据混在 `.pi` 目录 | P1 | open | 低 |
| OF-015 | 飞书进度管理在插件外部，缺少结构化项目源 | P1 | open | 中 |
| OF-016 | worktree / job 清理策略不清晰 | P2 | open | 中 |
| OF-017 | 缺少 reload / recovery / migration 回归测试 | P0 | in-progress | 高 |
| OF-018 | 缺少员工 token 监控 | P1 | in-progress | 高 |
| OF-019 | 员工间通信、请求接活与派活权限体系缺失 | P1 | in-progress | 中 |
| OF-020 | 日报数据源只读 queue.jsonl，导致全员产出遗漏 | P0 | in-progress | 高 |
| OF-021 | 员工上下文压缩质量不稳定，缺少 Codex 代压缩后端 | P1 | in-progress（shadow 已落地） | 高 |
| OF-022 | 缺少本地 Web 可视化工厂驾驶舱 | P1 | assigned（八村） | 高 |
| OF-023 | Pi 后端多模型来源接入与工厂 profile 管理 | P1 | in-progress（super-relay 试点已接入） | 高 |
| OF-024 | Pi custom_message 进入上下文且 compaction 估算忽略，导致主 agent 上下文爆炸 | P0 | planned（先工厂止血，后给 Pi 提 issue/MR） | 中 |
| OF-025 | Web 项目视角仍使用 job.project 派生，定时任务缺少可视化页面 | P1 | assigned（包包） | 高 |
| OF-026 | 员工通信只是留言，缺少回调唤醒和有记忆指挥模式 | P0 | in-progress（factory_command + message wake 已落地） | 中 |
| OF-027 | 员工后台成果缺少未读 pick 入口，完成结果容易漏看 | P0 | in-progress（factory_pick + /pick 已落地） | 高 |
| OF-028 | 缺少任务取消、steer 后端语义说明和员工休假状态 | P0 | in-progress（内核已落地，待 reload 验证） | 中 |
| OF-029 | 内网 Codebase 分享缺少安装说明和自检路径 | P1 | done（README/INSTALL/install-check 已补） | 高 |

---

## OF-029：内网 Codebase 分享缺少安装说明和自检路径

- 优先级：P1
- 状态：done（内网分享最小安装层已补；公开开源仍需单独脱敏/License）
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/README.md`
  - `.pi/extensions/ox-factory/INSTALL.md`
  - `.pi/extensions/ox-factory/.env.example`
  - `.pi/extensions/ox-factory/install-check.mjs`
  - `.pi/extensions/ox-factory/package.json`

### 现状

ox-factory 已是独立 git repo，但朋友从内网 Codebase clone 后此前不容易判断：

- 应该 clone 到哪个目录；
- 是否需要 npm install；
- 如何确认 Pi 能加载；
- Web dashboard 如何启动；
- Codex 后端是不是必需；
- 哪些本地运行数据不能提交。

### 影响

直接分享仓库会让外部使用者卡在安装/启动阶段；也容易把 `.env`、`.pi/workers`、session/rollout 等本地数据误提交。

### 已落地

- README 增加 Quick Install、Web dashboard、Security/Internal Sharing notes。
- 新增 INSTALL.md，覆盖内网安装、更新、Web、Codex 可选配置、运行数据边界和常见问题。
- 新增 `.env.example`，只记录可公开的环境变量名和安全默认值。
- 新增 `npm run install-check`，检查源码布局、Node 版本、Pi CLI、Codex WebSocket 条件、workers 目录边界和明显 token 字面量。

### 后续边界

- 内网 Codebase 分享可用；公开互联网开源还需要另开任务处理 License、商标、内部路径/域名/事故文档脱敏。

## OF-001：员工缺少“职责 / 负责项目”一等字段

- 优先级：P0
- 状态：done（最小数据层已落地；完整 Project Store 另见 OF-002）
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/types.ts`
  - `.pi/extensions/ox-factory/registry.ts`
  - `.pi/extensions/ox-factory/responsibilities.mjs`
  - `.pi/extensions/ox-factory/web-server.mjs`

### 现状

`Worker` 当前主要记录身份、执行配置、履历和晋升记录：

- `role`
- `backend`
- `model`
- `thinking`
- `projects`
- `promotions`

但没有记录“这个员工现在负责什么”的字段。

### 影响

无法清晰表达：

- 东子负责“牛马工厂落地页”
- 布朗尼负责“飞书文档进度管理”
- 小绿负责“履历整理”
- 某人是项目 owner / lead / developer / reviewer / tester

现在只能把这些信息塞进 `projects.summary`，后续做推荐人选、日报、项目看板都会不稳定。

### 建议方向

新增 `Responsibility` 概念，建议优先用追加 entry 方式兼容旧数据：

```json
{
  "type": "custom",
  "customType": "ox-worker-responsibility",
  "data": {
    "workerId": "东子",
    "project": "牛马工厂落地页",
    "relation": "lead",
    "scope": "负责落地页开发、架构图和产品表达",
    "status": "active"
  }
}
```

配套工具可以后续讨论：

- `factory_responsibility_set`
- `factory_responsibility_list`
- `factory_responsibility_remove`

### 当前落地

2026-07-02 已实现最小安全版：

- 新增 `ResponsibilityRecord`，进入 `Worker.responsibilities`。
- 新增 append-only 文件：`.pi/workers/responsibilities.jsonl`。
- 新增共享模块：`.pi/extensions/ox-factory/responsibilities.mjs`，支持 set/list/remove、按 `worker + project + relation` upsert；remove 不删除历史行。
- 新增主工具：
  - `factory_responsibility_set`
  - `factory_responsibility_list`
  - `factory_responsibility_remove`
- `factory_list` / 员工详情会展示当前职责摘要。
- Web dashboard 的 `/api/workers`、`/api/workers/:name`、`/api/responsibilities` 会读取职责数据，员工详情页不再只能显示“数据源未提供”。

边界：

- 这不是完整 Project Store；项目 owner、成员、backlog、文档链接仍归 OF-002。
- 当前职责由主 agent / 用户显式设定，不从 job 文本自动猜测，避免硬编码假职责。

---

## OF-002：没有统一 Project 实体

- 优先级：P0
- 状态：in-progress（Project Entity MVP 已落地）
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/index.ts`
  - `.pi/extensions/ox-factory/registry.ts`
  - `.pi/extensions/ox-factory/types.ts`
  - `.pi/extensions/ox-factory/projects.mjs`
  - `.pi/workers/projects.jsonl`
  - `docs/ox-factory-project-entity-design.md`

### 现状

现在 `project` 只是字符串，出现在：

- `factory_dispatch`
- `factory_queue`
- `recordProject`
- job metadata
- worktree path

但没有项目 ID、项目 owner、项目状态、成员、文档链接、backlog。

### 影响

工厂内部不知道“有哪些项目”，只能知道“某次任务填了什么 project 字符串”。

项目管理依赖布朗尼去飞书文档里维护，插件本体缺少统一真相源。

### 建议方向

新增 `Project` 实体，但保持旧工具继续接收 `project: string`。

### 当前落地

2026-07-04 已落地轻量 Project Entity MVP：

- 新增 append-only 数据层：`.pi/workers/projects.jsonl`。
- 新增共享模块：`.pi/extensions/ox-factory/projects.mjs`。
- 新增工具：`factory_project_upsert/list/todo_set/worktree_set/progress_add/member_set`。
- 新增项目文档规范：`docs/ox-projects/README.md`、`docs/ox-projects/_template.md`。
- 新增设计文档：`docs/ox-factory-project-entity-design.md`。
- MVP 只记录必要索引、todo、worktree、progress、members 和 single source of truth 链接；长 checklist 继续指向 Markdown/飞书文档。

兼容策略：

1. 旧工具继续传项目名，不破坏现有 `project: string`。
2. `factory_project_*` 工具支持通过项目 ID / 名称 / aliases 解析同一个项目。
3. 老 job 继续按 `project` 字符串展示。
4. 未来可在派活链路补 `projectId`，但本次 MVP 不迁移历史 job、不改 job 写入契约。

当前 MVP 工具：

- `factory_project_upsert`
- `factory_project_list`
- `factory_project_todo_set`
- `factory_project_worktree_set`
- `factory_project_progress_add`
- `factory_project_member_set`

---

## OF-003：`projects` 同时承担履历和项目关系，语义混杂

- 优先级：P1
- 状态：open
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/types.ts`
  - `.pi/extensions/ox-factory/registry.ts`

### 现状

`ProjectRecord` 现在表示“做过什么”：

```ts
interface ProjectRecord {
  project: string;
  task: string;
  result: "success" | "failed";
  summary: string;
  date: string;
}
```

但使用时容易被当成“负责什么”。

### 影响

履历、职责、项目成员关系混在一起，后续难以做：

- 员工能力画像
- 项目负责人查询
- 项目看板
- 推荐派活

### 建议方向

明确拆分：

- `projects` / `ProjectRecord`：历史成果，做过什么。
- `responsibilities`：当前职责，负责什么。
- `Project`：项目本体，工厂有哪些项目。
- `jobs`：执行记录，跑过什么任务。

---

## OF-004：履历记录运行时去重，但恢复时不去重

- 优先级：P0
- 状态：open
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/registry.ts`

### 现状

`recordProject()` 运行时会按同一个 `worker + project` 覆盖旧记录。

但持久化是 append-only 的 `ox-worker-project`。`restoreFromEntries()` 恢复时直接 `push`，没有按同项目取最后一条。

### 影响

运行时看起来去重，reload 后重复履历可能复活。

`factory_note` 的“去重”也只对当前内存有效，不能清掉旧 entry。

### 建议方向

修改恢复逻辑：

1. 恢复时按 `workerId + project` 建索引。
2. 同 key 只保留最后一条。
3. 不删除旧 entry，保证兼容。
4. 补测试覆盖“append 两条同项目记录，恢复后只展示最后一条”。

---

## OF-005：fire / rehire 同名员工的生命周期语义不清

- 优先级：P1
- 状态：open
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/registry.ts`

### 现状

`fire()` 标记员工为 fired。`hire()` 允许同名 fired 员工重新入职。

但恢复时新的 HIRE 会重新创建空 `projects` / `promotions`。

### 影响

“保留离职员工履历”的承诺和“同名重新入职”的行为冲突。

### 建议方向

需要先定语义：

1. 同名 rehire 是恢复同一个人，保留履历。
2. 同名 rehire 是新 employment segment，但展示时能看历史。
3. 禁止同名 rehire，要求新 ID。

兼容方案倾向：引入可选 `employmentId`，旧员工默认一个 segment。

---

## OF-006：`ox-worker-config` 追加过多，主 session 变脏

- 优先级：P1
- 状态：open
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/registry.ts`
  - `.pi/extensions/ox-factory/index.ts`
  - `.pi/extensions/ox-factory/codex-backend.mjs`

### 现状

`updateWorkerConfig()` 每次都会 append 一条 `ox-worker-config`。

Codex worker 执行过程中会频繁触发配置写入，主 session 里已经出现较多重复 config entry。

### 影响

- 主 session 变长。
- 恢复成本增加。
- 配置变化和运行态变化边界不清。

### 建议方向

1. `updateWorkerConfig()` 写入前做 shallow compare，无变化不 append。
2. 区分持久配置和运行态：
   - 持久：backend / model / thinking / codexThreadId / sandbox。
   - 运行态：codexActiveTurnId / heartbeat / active job。
3. 对运行态走 job store，不写 worker config。

### 当前落地

2026-07-05 针对“步美招募时应为 full access，但实际频繁访问链接/目录失败”排查后，确认一个额外根因：

- 手工追加过 `codexSandbox="danger-full-access"` 配置；
- 但运行中的工厂进程内存里仍是旧 `workspace-write`；
- 后续 Codex thread/model 元数据更新会调用 `updateWorkerConfig()` 追加**全量配置快照**，把旧 sandbox 再写回主 session；
- reload 回放时以后写入为准，所以 full access 被后续旧快照覆盖。

已做的低风险修复：

1. `updateWorkerConfig()` 只持久化 patch 中显式传入的字段，不再把整份 worker config 反复快照写回 session。
2. 无实际变化时不追加 `ox-worker-config`，减少主 session 污染。
3. 新增 `factory_worker_config` 工具，用于通过正式链路调整 Codex 员工的 `model` / `thinking` / `codexSandbox` / `codexApprovalPolicy` / `codexServerUrl`。
4. 已在主 session 末尾为步美补一条最终配置：`codexSandbox=danger-full-access`、`codexApprovalPolicy=never`；reload 后应以该配置恢复。

2026-07-05 进一步验证发现：步美旧 Codex rollout 最新 `turn_context` 仍为 `workspace-write`、`network_access=false`。主 agent 当时没有加载 `factory_worker_config` 工具，只能手写持久配置，无法更新当前进程内存；因此需要补一个正式 thread reset 能力：

5. `factory_worker_config` 增加 `resetCodexThread=true`：
   - 只适用于 Codex 员工；
   - 清空 `codexThreadId`，不 fire / rehire，不删除旧 rollout；
   - 生成 `codexThreadHandoff`，汇总该员工最近 job 与旧 thread id；
   - 下一次任务会用当前 `codexSandbox` 新建 Codex thread，并把 handoff 注入 base instructions；
   - 新 thread 创建成功后自动清空 handoff，避免每轮重复注入。

待真实 reload 后验证：

- 步美新 job 是否能写入 `~/Code/github` 等非 workspace 目录。
- 若旧 thread sandbox 粘住，执行 `factory_worker_config(name=步美, codexSandbox=danger-full-access, codexApprovalPolicy=never, resetCodexThread=true)` 后再重试。
- 2026-07-05 补兼容：`factory_worker_config` 原始 schema 只认 `name`，派派曾口头写成 `workerId=步美`，可能导致主 agent “调用不了/参数不匹配”；现已支持 `workerId` alias，但推荐文档仍使用 `name=步美`。
- 2026-07-05 按用户确认的产品默认策略：`factory_hire backend=codex` 在未显式传 `codexSandbox` 时默认使用 `danger-full-access`，避免新员工一入职就卡在 workspace sandbox；需要收紧时再显式传 `read-only` / `workspace-write`。
- 如果 GitHub clone 仍出现 DNS 失败，需单独排查 Codex app-server 网络环境。
- 如果飞书 / lark-cli 仍报 Keychain，需单独处理本机 Keychain 初始化或授权，不归 sandbox 覆盖问题。

---

## OF-007：reload 时无条件把 open job 标为 stale

- 优先级：P0
- 状态：in-progress（低风险 heartbeat recovery 已落地；待真实 reload 验证）
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/index.ts`
  - `.pi/extensions/ox-factory/jobs.mjs`

### 现状

插件 `session_start` 时调用：

```ts
markOpenJobsStale(getWorkersDir(), "previous Pi process exited before this in-process job completed")
```

该函数会把所有非终态 job 标为 `stale`。

### 影响

如果插件 reload 但子任务仍在运行，job 可能被错误标 stale。

实际观察到过：job 被标 stale 后，event 文件仍继续写入工具输出。

### 建议方向

不要一刀切 stale。改成：

```text
recoverOpenJobs()
  - legacy job：保守 stale
  - 有 pid/heartbeat：检查进程是否还活着
  - 活着：标 running/recovered
  - 死了：标 stale/retryable
```

### 当前落地

- `session_start` 已改用 `recoverOpenJobsOnStartup()`，不再直接对启动时所有 open job 无条件 stale。
- 有新鲜 heartbeat 的 open job 会保留为 `orphan-running`；没有 heartbeat 或 heartbeat 过期的 legacy/open job 仍保守标 `stale`。
- 旧的 `markOpenJobsStale()` 保留原语义，避免影响已有兼容路径和测试。

---

## OF-008：job 缺少 PID / heartbeat / owner，无法可靠恢复

- 优先级：P0
- 状态：in-progress（已写入 ownerPid / ownerInstanceId / heartbeatAt；待真实 reload 验证）
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/spawner.ts`
  - `.pi/extensions/ox-factory/jobs.mjs`

### 现状

job 里有时会显示 `pid`，但当前 in-process job 没有稳定持久化：

- owner process id
- child pid
- heartbeatAt
- generation

### 影响

reload 时无法判断：

- 原进程是否活着
- 子进程是否活着
- 是否可以 attach
- 是否应该 stale
- 是否应该 retry

### 建议方向

新 job 增加可选字段：

```ts
ownerProcessId?: number;
childPid?: number;
heartbeatAt?: string;
generation?: string;
recoverable?: boolean;
```

老 job 没字段时走 legacy 兼容逻辑。

### 当前落地

- `startWorkerJob()` 启动时写入：
  - `ownerPid`
  - `ownerInstanceId`
  - `ownerStartedAt`
  - `heartbeatAt`
  - `heartbeatIntervalMs`
- 运行期间按固定间隔刷新 heartbeat；高频流式事件不会每次都改写 job JSON。
- startup recovery 用 heartbeat 新鲜度和 owner pid 存活性做低风险判断。

---

## OF-009：job 已 stale 后仍可能继续写 event

- 优先级：P0
- 状态：in-progress（新 job 事件写入已加 late-event guard；历史运行链路无法 retroactively 修复）
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/jobs.mjs`
  - `.pi/extensions/ox-factory/spawner.ts`

### 现状

`appendJobEvent()` 不检查 job 当前状态。一个 job 被标为 `stale` 后，原执行链路可能继续 append text/tool/done event。

### 影响

job metadata 和 event log 状态冲突：

- metadata 说 stale
- events 还在输出
- 最终可能又有 done 内容

### 建议方向

引入 owner/generation 校验：

1. `startWorkerJob()` 启动时写入 `runId/generation`。
2. `appendJobEvent()` 可选择校验当前 job 是否仍属于该 run。
3. 若终态后仍有 event，标记为 `late_event_after_terminal`，不要静默写乱。

### 当前落地

- 新增 `appendJobEventIfOpen()`：如果 job 已经是终态，后续 event 记录为 `late_event_after_terminal`。
- `startWorkerJob()` 的流式事件写入改走 late-event guard。
- job 已经 `stale/done/failed/aborted` 时，后续 finish patch 不会覆盖现有终态。

---

## OF-010：内存队列和 talk 状态 reload 后丢失

- 优先级：P0
- 状态：open
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/index.ts`

### 现状

这些状态只在内存里：

- `workerJobQueues`
- `workerRunningJobs`
- `talkTarget`
- `activeTalkJobId`
- `talkLiveBuffers`

### 影响

reload 后：

- 排队任务关系丢失。
- 当前 talk 接入对象丢失。
- 正在运行 job 的 live 输出接不上。
- 员工状态和 job 状态可能不一致。

### 建议方向

短期：

- 恢复时从 job store 重建 open job 视图。
- `/talk 员工名` 自动 attach 最近 open job。

长期：

- 将 queue state 持久化到 job store。
- talkTarget 是否持久化需要讨论，可能不应该跨主会话恢复。

---

## OF-011：in-process job 和 runner 队列是两套状态系统

- 优先级：P1
- 状态：open
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/index.ts`
  - `.pi/extensions/ox-factory/jobs.mjs`
  - `.pi/extensions/ox-factory/queue-utils.mjs`
  - `.pi/workers/runner.sh`

### 现状

in-process job 使用：

- `.pi/workers/jobs/*.json`
- `.pi/workers/events/*.jsonl`

runner 定时任务使用：

- `.pi/workers/queue.jsonl`
- `.pi/workers/history.log`
- `.pi/workers/.last-output-*.json`

### 影响

`factory_check` 需要同时读两套数据，状态语义不统一。

### 建议方向

不能直接废弃 `queue.jsonl`。建议过渡：

1. runner 继续读 `queue.jsonl`。
2. runner 执行时也创建 job/event。
3. `factory_check` 优先展示 job store，兼容展示 queue。
4. 稳定后再让 runner 读 job store。

---

## OF-012：Codex active turn 不可恢复，配置持久化边界不清

- 优先级：P1
- 状态：open
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/codex-backend.mjs`
  - `.pi/extensions/ox-factory/registry.ts`

### 现状

`codexActiveTurnId` 是 Worker 字段，但 `updateWorkerConfig()` 没有持久化它。

同时 Codex worker 执行中会频繁写 config entry。

### 影响

reload 后无法知道哪个 Codex turn 正在跑，也无法可靠 steer。

### 建议方向

- `codexThreadId` 属于 worker 持久配置。
- `codexActiveTurnId` 属于 job/run 运行态。
- active turn 应存到 job metadata，而不是 worker config。

---

## OF-013：`factory_transfer` 当前更像说明，不是真迁移

- 优先级：P2
- 状态：open
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/index.ts`

### 现状

`factory_transfer` 会读取源员工 session 部分内容，但没有真正写入目标员工 session。

### 影响

工具描述说“记忆迁移”，但实际效果更像“展示迁移摘要”。

### 建议方向

需要明确产品语义：

1. 只生成 handoff briefing。
2. 真的复制 session 前缀。
3. 生成结构化 memory entry。

建议优先做“handoff briefing”，避免污染目标员工上下文。

---

## OF-014：插件源码和 runtime 数据混在 `.pi` 目录

- 优先级：P1
- 状态：open
- 兼容性：低
- 相关文件：
  - `.pi/extensions/ox-factory`
  - `.pi/workers`
  - `.gitignore`

### 现状

`.pi` 目录同时包含：

- 插件源码
- 员工 session
- job / event 日志
- runner 队列
- worktree
- last output

`.pi` 当前未被 git 跟踪，但也未在 `.gitignore` 中整体忽略。

### 影响

商业化发布、升级、备份、隐私治理会困难。

### 建议方向

长期拆分：

```text
plugin source repo
  ox-factory/
    src/
    test/
    README.md
    CHANGELOG.md

runtime data
  ~/.ox-factory/
    workers/
    jobs/
    events/
    sessions/
```

短期至少明确：

- 源码哪些文件要提交。
- runtime 哪些必须忽略。

---

## OF-015：飞书进度管理在插件外部，缺少结构化项目源

- 优先级：P1
- 状态：open
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/index.ts`
  - `.pi/workers/sessions/布朗尼.jsonl`

### 现状

布朗尼可以维护飞书文档里的进度管理，但插件本体没有结构化项目数据源。

### 影响

飞书文档变成事实真相源，插件内部无法可靠查询：

- 项目状态
- backlog
- owner
- dependencies
- 今日进展

### 建议方向

让插件内部 Project store 成为结构化源，飞书作为展示/协作同步目标。

候选工具：

- `factory_project_sync_feishu`
- `factory_project_import_feishu`
- `factory_project_daily_report`

---

## OF-016：worktree / job 清理策略不清晰

- 优先级：P2
- 状态：open
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/spawner.ts`
  - `.pi/workers/worktrees`

### 现状

`factory_dispatch` 会创建 worktree，但清理策略不明确。

`cleanupWorktree()` 存在，但当前主流程里没有形成清晰生命周期。

### 影响

长期使用后 worktree 可能堆积，分支和磁盘占用难控。

### 建议方向

为 dispatch/race 增加 worktree 策略：

- `keep`：默认保留，便于人工接管。
- `cleanup_on_success`：成功自动清理。
- `archive`：记录分支/commit 后清理。

---

## OF-017：缺少 reload / recovery / migration 回归测试

- 优先级：P0
- 状态：in-progress（已补 heartbeat recovery / late-event 相关单测）
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/test/ox-factory.test.mjs`

### 现状

现有测试覆盖了：

- job store 基础读写
- stale 标记
- queue-utils
- Codex event 映射
- tool result parent 修复

但缺少：

- reload 恢复
- stale 后 late event
- 履历去重恢复
- worker responsibility 恢复
- Project 读旧写新

### 影响

越修 reload 和持久化，越需要测试保护，否则容易引入历史数据不兼容。

### 建议方向

每修一个数据/恢复问题，先补一个最小测试。

### 当前落地

- 已补以下回归测试：
  - 新鲜 heartbeat 的 job 在 startup recovery 中保留为 `orphan-running`。
  - 过期 heartbeat 和 legacy open job 会被标 `stale`。
  - stale 后 late event 会记录为 `late_event_after_terminal`。
  - 插件启动使用 heartbeat-aware recovery，不再直接无条件 stale。
  - worker job 写入 heartbeat 元数据并使用 late-event guard。

---

## OF-018：缺少员工 token 监控

- 优先级：P1
- 状态：in-progress（Token 监控 MVP 已落地；2026-07-06 确认 Codex job 使用 `last_token_usage` 会严重低估，已补 rollout 回算/修复脚本，并将主链路改为 cumulative delta，待 reload 验证）
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/token-report.mjs`
  - `.pi/extensions/ox-factory/token-report-cli.mjs`
  - `.pi/extensions/ox-factory/codex-backend.mjs`
  - `.pi/extensions/ox-factory/spawner.ts`
  - `.pi/extensions/ox-factory/jobs.mjs`
  - `.pi/workers/sessions/*.jsonl`

### 现状

job 与 session 中已有部分 token 字段：

- `inputTokens` / `cachedInputTokens` / `outputTokens` / `reasoningOutputTokens` / `totalTokens`
- session `message.usage.input` / `message.usage.output`
- Codex app-server turn payload 当前不含 usage；真实 token 通过 `thread/tokenUsage/updated` 通知返回，结构为 `ThreadTokenUsage { total, last, modelContextWindow }`

此前缺少统一的“按天、按员工” token 视图。

### 已确认范围

- 只统计 token，不计算钱；token 报告需要展示 cached input，避免和 Codex dashboard 口径差太远。
- 不做绩效评分。
- 不混入 job 完成数、产出质量或调度建议。
- session usage 优先，job token 只做兜底，避免同一员工同一天重复相加。

### 当前落地

- 新增 `token-report.mjs`：按日期/员工聚合 input/output/total token。
- 新增 `token-report-cli.mjs`：可通过 CLI 查看 token 报告。
- 新增 `factory_token_report` 工具；主 agent 通过自然语言触发，例如“看看东子的 token 消耗”，不注册 `/tokens` 命令。
- Codex app-server 增加 `extractCodexTokenUsage()`，支持常见 usage 字段形态和 v2 `ThreadTokenUsage { total, last }`，并提取 cached/reasoning token。
- Codex worker streaming 监听 `thread/tokenUsage/updated`，旧逻辑按 `last` usage 写入 job；2026-07-06 排障确认 `last_token_usage` 只是 Codex 任务内最后一次模型调用，不是整次任务/turn 的总量。现已改为记录任务累计 `total_token_usage` baseline，并在任务结束时写入 `final total - baseline`；reload 后对新 Codex job 生效。
- 2026-07-01 排障结论：美伢这类 Codex 员工没有 `.pi/workers/sessions/美伢.jsonl`，旧代码又只在 `turn/completed` 上找 usage，所以 job token 一直为 0。
- 2026-07-06 排障结论：光彦当天后续新增到 17 个 rollout task 段，修复前 `token-report` job 口径为 `2.58M input / 2.54M cached / 23.16K output / 2.61M total / 5.14M with cached`，但从 `~/.codex/sessions/2026/07/02/rollout-...019f219b...jsonl` 的 `total_token_usage` 累计差值回算为 `92.86M input / 89.31M cached / 204.83K output / 93.07M total / 182.38M with cached`，低估约 `35x`。
- 新增脚本 `codex-rollout-token-report.mjs`：可按员工/日期扫描 Codex rollout，按 `task_started -> task_complete` 分段计算累计差值，并和现有 `token_report` job 口径对比；默认只读，`--repair-preview` 预览 job patch，`--apply-jobs` 写回匹配的 done job token metadata。
- 已用 `--apply-jobs` 修复 2026-07-06 所有可匹配 Codex 员工 done job：光彦、川宝、布鲁克、步美、派派、路人甲，共 34 个 done job；随后全量历史回填 2026-06-29 至 2026-07-06 的 Codex done job；2026-07-06 审计结果为 284 个 Codex done job，其中 281 个匹配 rollout 并写回 `tokenSource=codex-rollout-delta`。
- 仍有 3 个 job 无法安全匹配 rollout task 段，保持原值不猜：美伢 `20260701072134-_-quqpnn`（“迷失”）、派派 `20260704154718-_-n6ja35`（Web projects 报错跟进）、光彦 `20260706023901-_-9lzxks`（活跃 turn 中途追加/steer 类消息）。
- 质量验收总账见 `docs/ox-factory-quality-checklist.md`。

### 需要继续讨论

- 是否要每日归档 `.pi/workers/token-usage-daily.jsonl`，还是保持按原始日志随查随算。
- 历史 Codex job 如果对应 rollout 仍存在且含 `token_count.info.total_token_usage`，可以用只读回算脚本恢复/核对；是否写回 job metadata 需要单独做 audit/匹配确认。没有 rollout 或缺少 token_count 的历史 job 不猜测回填。

## OF-019：员工间通信、请求接活与派活权限体系缺失

- 优先级：P1
- 状态：in-progress（授权式通信 MVP 已落地；请求接活/派活审批暂缓）
- 兼容性：中
- 相关文件：
  - `.pi/extensions/ox-factory/comm.mjs`
  - `.pi/extensions/ox-factory/comm-cli.mjs`
  - `.pi/extensions/ox-factory/index.ts`
  - `.pi/extensions/ox-factory/registry.ts`
  - `.pi/workers/sessions/*.jsonl`

### 现状

当前工厂支持人对员工说话和派活：

- `factory_talk` / `/talk`
- `factory_dispatch`
- `factory_queue`

但没有正式的员工间通信能力。员工如果要了解别人，只能读对方 session、读队列文件、写临时文件，或者让用户中转。

### 影响

缺少这些能力：

- 员工给员工发消息。
- 员工请求别人接活。
- 对方接受 / 拒绝请求。
- 工头或项目负责人直接派活。
- 普通员工只能请求，不能命令别人。
- 员工间沟通审计记录。

这会限制工厂从“用户手动管理多名 agent”升级成“agent 团队协作”。

### 建议方向

分三步做，避免一开始过重：

1. 先做共享 inbox：`factory_message_send` / `factory_inbox`。
2. 再做请求接活：`factory_request_work` / `factory_request_decide`。
3. 最后做派活权限：工头、项目 owner、直属上级可以直接派活；普通员工只能请求。

初期数据可以放到共享 JSONL：

```text
.pi/workers/messages.jsonl
.pi/workers/requests.jsonl
```

真正执行派活仍建议由主工厂控制器完成，不让任意员工子进程随意 spawn 其他员工。

### 当前落地

- 新增 `comm.mjs`：权限和消息存储逻辑。
- 新增 `comm-cli.mjs`：员工子进程可通过 CLI 发送/查看授权消息。
- 新增 `.pi/workers/permissions.json` 当前授权状态，以及 `.pi/workers/permission-events.jsonl` 审计日志。
- 新增 `.pi/workers/messages.jsonl`：消息和已读事件 append-only 记录。
- 新增 `factory_permission_grant` / `factory_permission_revoke` / `factory_permission_list` / `factory_permission_check`。
- 新增 `factory_message_send` / `factory_inbox` / `factory_message_read`。
- 当前明确不做审批：没有授权就拒绝；飞书/人工审批后续再接。
- 当前不自动派活：`work:request` / `work:assign` 仅作为权限动作预留，不会自动 dispatch/queue。
- 管理层权限补充：派派作为工厂负责人加入内置 admin；`worker:fire` 纳入权限动作，`factory_fire` 兼容默认秘书执行，也支持显式 `actor=派派` 执行。
- 质量验收总账见 `docs/ox-factory-quality-checklist.md`。

## OF-020：日报数据源只读 queue.jsonl，导致全员产出遗漏

- 优先级：P0
- 状态：in-progress（MVP 已落地，日报模板/飞书归档仍可继续完善）
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/report-context.mjs`
  - `.pi/extensions/ox-factory/report-sources.mjs`
  - `.pi/workers/queue.jsonl`
  - `.pi/workers/jobs/*.json`
  - `.pi/workers/sessions/*.jsonl`
  - `.pi/workers/runner.sh`
  - `.pi/extensions/ox-factory/jobs.mjs`
  - `.pi/extensions/ox-factory/index.ts`

### 现状

布朗尼写工厂日报时主要读取 `.pi/workers/queue.jsonl`。

但 `queue.jsonl` 当前只覆盖 `factory_queue` / runner / cron 这类离线队列任务，不是全局 activity ledger。

工厂真实工作大量发生在其他通道：

- `/talk` 对话模式；
- `factory_talk` / `factory_dispatch` 触发的 in-process job；
- `factory_note` / `factory_hire` / `factory_promote` 等主会话管理动作；
- 员工各自 session 中的工具调用、成本、代码编辑与外部系统操作；
- 可选的 git commit、MR、飞书文档等外部事实源。

因此日报会把“队列里没出现”误判为“员工没干活”，出现“工厂空转、只有小绿在跑”这类失真结论。

### 影响

- 日报无法准确反映全员产出，管理层看到的是 runner 队列视角，不是工厂全局视角。
- 东子展示页迭代、美伢 MR 流程、派派分析、广志 checklist、小新 review 等真实工作可能被遗漏。
- 该问题会放大 OF-007 / OF-010 / OF-011：reload stale、内存队列丢失、in-process job 与 runner 队列分裂都会让单一 queue 视角更不可靠。

### 建议方向

保留 `queue.jsonl`，但只把它定义为“runner / cron / factory_queue 队列流水”。日报改为多源只读聚合：

1. `.pi/workers/jobs/*.json` 与 events：作为“今日任务 / 产出”的主数据源。
2. `.pi/workers/queue.jsonl`：作为“定时任务 / runner 队列”的补充数据源。
3. 主 session 的 `custom` / tool call：作为人员、履历、派活、管理动作数据源。
4. 员工 session jsonl：作为工具调用、token/cost、原始活动佐证。
5. 可选 git/worktree/外部系统：作为代码提交、MR、飞书文档等事实校验。

同时固定日报模板，要求关键结论标注数据来源；禁止只凭 queue 说“空转”。

对 `status=done` 但带 stale/error 痕迹的 job，日报应计入产出，同时在“数据质量 / 恢复风险”里单独提示。

### 当前落地

- 新增 `report-context.mjs`：只读聚合 jobs、queue、员工 sessions、主 session 管理动作。
- 新增 `report-sources.mjs`：员工子进程可通过 `node .pi/extensions/ox-factory/report-sources.mjs --date YYYY-MM-DD` 获取日报上下文。
- 新增 `factory_report_context` 工具和 `/report` 命令：主工厂会话可直接查看日报上下文。
- 更新 foreman 提示：布朗尼写日报时禁止只看 queue，必须优先使用多源上下文。

### 需要继续讨论

- 日报是否只覆盖“工厂任务产出”，还是也要覆盖 token/cost、工具调用、代码提交、飞书文档变更？
- 日报模板要偏老板视角（摘要 + 风险 + 明日计划），还是偏审计视角（每个 job/queue/event 全展开）？
- 是否需要把日报聚合结果也 append 成新的 `ox-factory-daily-report` 结构化记录，方便后续追溯与对比？

---

## OF-021：员工上下文压缩质量不稳定，缺少 Codex 代压缩后端

- 优先级：P1
- 状态：in-progress（后端 smoke + shadow 双跑对比已落地；apply 仍需灰度）
- 兼容性：高
- 相关文件：
  - `.pi/extensions/ox-factory/compaction.mjs`
  - `.pi/extensions/ox-factory/compaction-smoke.mjs`
  - `.pi/extensions/ox-factory/compaction-report.mjs`
  - `.pi/extensions/ox-factory/codex-backend.mjs`
  - `.pi/extensions/ox-factory/index.ts`
  - `.pi/workers/compaction-shadow.jsonl`
  - `.pi/workers/compactions/*.pi.md`
  - `.pi/workers/compactions/*.codex.md`
  - `.pi/workers/sessions/*.jsonl`

### 现状

Pi 默认 compaction 会在上下文接近窗口时用当前员工自己的模型生成通用结构摘要。

这对长期员工不够稳定：

- 员工模型不同，压缩质量跟 MiniMax / DeepSeek / Kimi / Codex 能力强相关。
- 默认摘要不理解牛马工厂的“员工 / 项目 / job / 派活 / 工厂总账”语义。
- 工具输出默认偏头部截断，代码任务中的尾部错误和验证结论容易丢。
- 多项目长期 session 会把不同项目状态混在同一个摘要里。

### 影响

- 员工 reload / resume 后容易忘记当前任务真实状态。
- 布朗尼、东子这类长期员工的上下文越长，默认压缩越可能引入噪音。
- 后续想做商业级插件，需要更稳定、可解释、可灰度的压缩后端。

### 建议方向

保留 Pi 原生 compaction 存储和 `CompactionEntry` 机制，分三档运行：

- `off`：显式关闭 Codex 压缩 / shadow，不影响现有压缩。
- `shadow`：Pi 原生压缩仍是主链路，同时把同一份压缩输入发给 Codex，记录“Pi vs Codex”对比，不替换真实 compaction。
- `apply`：在 `session_before_compact` 阶段接管 summary 生成，把 Codex 摘要返回给 Pi 保存；失败时返回 `undefined`，回退 Pi 默认压缩。

`apply` 流程：

1. Pi 触发 compaction。
2. ox-factory 读取 `event.preparation`。
3. 调用 Codex app-server 的 ephemeral read-only thread 生成 factory-aware summary。
4. 返回 `{ compaction }` 给 Pi 保存。
5. Codex 失败时返回 `undefined`，自动回退 Pi 默认压缩。

第一阶段员工 session 仍 opt-in；主 agent 默认支持 `shadow` 评估，强制只评估、不采纳，避免影响用户主要上下文。员工灰度建议通过 `OX_FACTORY_CODEX_COMPACTION_WORKERS=测试员,东子` 指定名单。

### 当前落地

- 新增 `compaction.mjs`：
  - `serializeFactoryCompactionMessages`：把 Pi 消息序列化为压缩文本，工具结果保留头尾并带截断标记。
  - `buildFactoryCompactionRequest`：生成牛马工厂专用压缩 prompt。
  - `runCodexCompaction`：调用 Codex app-server 生成摘要，返回 Pi 兼容的 compaction result。
  - `handleFactoryCompactionEvent`：接入 `session_before_compact`，支持 `off / shadow / apply`。
  - `handleFactoryCompactionCompleted`：接入 `session_compact`，在 Pi 默认压缩完成后把 Pi 摘要和 Codex shadow 摘要落盘对比。
  - `buildFactoryCompactionReport` / `formatFactoryCompactionReport`：读取 shadow 记录生成 Markdown / JSON 报告。
- 主 agent shadow-only：
  - 识别 `~/.pi/agent/sessions/<cwd>/<session>.jsonl` 主会话。
  - 记录 `targetType=main`、`worker=主agent`。
  - 使用主 agent 专用压缩评估 prompt，强调用户长期目标、工厂路线图、员工调度、已确认需求和 brainstorm 边界。
  - 主 agent 默认拒绝 `apply`，除非显式设置危险开关 `OX_FACTORY_CODEX_COMPACTION_ALLOW_MAIN_APPLY=1`。
- 新增 `compaction-smoke.mjs`：只读员工 session，构造压缩样本，调用 Codex 产出 smoke 摘要。
- 新增 `compaction-report.mjs`：CLI 查看 `.pi/workers/compaction-shadow.jsonl` 对比记录。
- 已把 hook 接到 `index.ts`：主 agent 默认 shadow-only；员工默认关闭，避免 reload 后误影响员工任务。
- 已新增 `factory_compaction_report` 工具，用户可以直接问“看看最近压缩对比 / Codex 压缩效果怎么样”。
- shadow 记录写入：
  - `.pi/workers/compaction-shadow.jsonl`：结构化审计记录，包含 worker、session、Pi/Codex 摘要长度估算、结构命中、耗时、错误等。
  - `.pi/workers/compactions/<id>.pi.md`：Pi 原始摘要 copy。
  - `.pi/workers/compactions/<id>.codex.md`：Codex shadow 摘要 copy。
- 已用 `测试员` session 样本跑通 Codex smoke，结果写入 `/tmp/factory-codex-compaction-smoke.json`。
- 已复制 `测试员` session 到 `/tmp/ox-compaction-copy-*/测试员-copy.jsonl` 后再次跑通 copy smoke，结果写入 `/tmp/factory-codex-compaction-copy-smoke.json`，未改真实员工 session。

### 配置方式

```bash
# 默认：主 agent shadow-only；员工 off。主 agent 不需要额外环境变量。

# 如需显式关闭所有 Codex 压缩 / shadow
OX_FACTORY_CODEX_COMPACTION_MODE=off

# 员工灰度：Pi 原生压缩仍然生效，Codex 只双跑记录对比
OX_FACTORY_CODEX_COMPACTION_MODE=shadow
OX_FACTORY_CODEX_COMPACTION_WORKERS=测试员,东子

# 后续确认质量后再启用：Codex 摘要进入真实 Pi compaction
OX_FACTORY_CODEX_COMPACTION_MODE=apply
OX_FACTORY_CODEX_COMPACTION_WORKERS=测试员

# 兼容旧开关：OX_FACTORY_CODEX_COMPACTION=1 等价于 apply
```

查看对比：

```bash
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --limit 20
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --worker 东子 --json
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --target main
```

### 需要继续讨论

- 是否默认开启员工 Codex 压缩，还是先只给指定员工灰度。
- 主 agent shadow 样本积累后如何人工评分：是否保留长期偏好、已确认需求、项目路线图、员工调度和待办边界。
- shadow 对比积累多少样本后进入 `apply`；建议先看 5~10 次真实员工压缩对比。
- 压缩结果是否要进入日报数据源，展示“本日发生了几次上下文压缩、压缩前后 token 估算”。

---

## OF-022：缺少本地 Web 可视化工厂驾驶舱

- 优先级：P1
- 状态：in-progress（本地 Web + `/ox-web` 启动入口已落地，待 reload 验证）
- 兼容性：高
- 专项文档：`docs/ox-factory-web-visualization-plan.md`
- 任务交接：`docs/ox-factory-web-frontend-handoff-hachimura.md`
- 相关文件（预期）：
  - `.pi/extensions/ox-factory/web-server.mjs`
  - `.pi/extensions/ox-factory/web/index.html`
  - `.pi/extensions/ox-factory/web/app.js`
  - `.pi/extensions/ox-factory/web/styles.css`
  - `.pi/extensions/ox-factory/report-context.mjs`
  - `.pi/extensions/ox-factory/token-report.mjs`
  - `.pi/extensions/ox-factory/jobs.mjs`
  - `.pi/extensions/ox-factory/comm.mjs`
  - `.pi/extensions/ox-factory/compaction.mjs`

### 现状

牛马工厂的状态主要散落在 Pi 主对话、`.pi/workers` 下的 JSON/JSONL、员工 session、job event、日报上下文、token 报告和压缩 shadow 记录里。

主 agent 能通过自然语言查询，但用户缺少一个“打开就能看”的本地驾驶舱；东子的对外宣讲 / 落地页能讲价值，但不能替代真实本地状态页面。

### 影响

- 用户很难快速看到谁在干活、谁卡住、今日产出是什么。
- 布朗尼写日报前缺少人工可复核页面。
- token、reload recovery、权限通信、压缩评估这些能力都已有数据，但缺少统一呈现。
- 后续商业化插件需要更像产品，而不是一组散工具。

### 建议方向

新增本地 Web 模式，第一版定位为只读 / 轻操作的工厂驾驶舱：

```bash
node .pi/extensions/ox-factory/web-server.mjs --workers-dir .pi/workers --port 8787
```

访问：

```text
http://127.0.0.1:8787
```

MVP 页面：

1. 总览 Dashboard：员工数、job 状态、今日 token、今日产出、风险。
2. 员工看板：岗位、职责、负责项目、最近产出、token 趋势。
3. 任务 / Job 时间线：jobs + events + queue 合并视图。
4. 日报 / 产出页：复用 `factory_report_context`。
5. Token 页：复用 `factory_token_report`。
6. 压缩评估页：主 agent / 员工 Pi vs Codex shadow 对比。
7. 权限 / 消息页：授权矩阵、收件箱、审计日志。

### 当前落地

- 已新增专项规划：`docs/ox-factory-web-visualization-plan.md`。
- 已新增八村任务交接单：`docs/ox-factory-web-frontend-handoff-hachimura.md`。
- 已通过工厂消息系统派活给八村：`主agent -> 八村`。
- 明确第一版 Web 不替代主 agent，不直接执行高风险写操作。
- 明确 Web 接口要复用现有模块，不重复散扫 JSONL。
- 明确主 agent 压缩评估是 Web 压缩页的重点场景之一。
- 已新增 `/ox-web` 命令作为本地 dashboard 服务管理入口：
  - 默认检查 `http://127.0.0.1:8787/api/health`；
  - 已启动时复用已有服务；
  - 未启动时后台启动 `web-server.mjs --workers-dir .pi/workers --port 8787 --host 127.0.0.1`；
  - 通过系统浏览器打开页面；
  - 日志写入 `.pi/workers/web-server-8787.log`；
  - 支持 `/ox-web --status`、`/ox-web --no-open`、`/ox-web 8799`。

### 需要继续讨论

- `/ox-web` reload 后真实 smoke：未启动启动、已启动复用、端口被其它服务占用时的错误提示。
- 第一版是否用原生 HTML/JS，还是直接 Vue/Vite。
- 哪些操作允许在 Web 里直接做，哪些必须回到主 agent 确认。
- 东子对外宣讲页和本地 Web 页面是否共用同一套视觉组件。

---

## OF-023：Pi 后端多模型来源接入与工厂 profile 管理

- 优先级：P1
- 状态：in-progress（super-relay 试点已接入）
- 兼容性：高
- 相关文件：
  - `~/.pi/agent/models.json`
  - `.pi/workers/profiles.json`
  - `.pi/extensions/ox-factory/spawner.ts`

### 现状

牛马工厂的 Pi 后端员工通过 `pi --model ...` 启动，模型实际来源由 Pi 的 provider registry 决定。工厂侧只记录员工使用的 `model` / `thinking`，不直接实现 Responses 或 Chat Completions 协议。

### 影响

- 新模型来源如果只散落在用户口头配置里，后续招人、赛马、日报和 token 统计都不稳定。
- 模型 id 可能带 `/`，需要明确使用 `provider/model-id` 形式，避免和全局模型匹配混淆。
- 多个内网/外部 provider 接入后，需要统一命名 profile，方便自然语言指派员工。

### 建议方向

- Pi 自定义模型统一写入 `~/.pi/agent/models.json`，凭据放 Keychain 或环境变量，不写入仓库。
- 工厂只维护 profile，不维护密钥：

```json
{
  "super-relay-exp": {
    "model": "super-relay/model_api/experimental_0630",
    "thinking": "off",
    "description": "Super Relay Responses 实验模型 experimental_0630"
  }
}
```

- 后续如需 provider 独立字段，再给 `factory_hire` / worker profile 增加 `provider`，当前先用 Pi 已支持的 `provider/model-id` 保持兼容。

### 当前落地

2026-07-02 已接入 Super Relay 试点：

- 新增 Pi provider：`super-relay`，API 类型为 `openai-responses`。
- base URL：`https://super-relay.byted.org/v1`。
- 模型 id：`model_api/experimental_0630`。
- bearer token 已放入本机 Keychain，`models.json` 仅保存读取命令。
- `x-session-id` 使用请求时动态生成值，避免多个员工共享同一个固定会话 id。
- 新增工厂 profile：`super-relay-exp`。
- 直连 smoke 发现该网关会返回 Responses `reasoning` summary item；Pi 会将其记录为 thinking 内容。当前不影响文本输出，但如果不希望员工日志里出现 reasoning summary，需要后续在网关侧隐藏/关闭，或为该模型改走兼容层。

### 需要继续讨论

- 是否给 `factory_hire` 增加独立 `provider` 参数，避免长 `provider/model-id`。
- 是否把模型能力（上下文、是否支持图像、是否支持 reasoning、token 价格）做成工厂可视化的一部分。
- 是否给不同模型来源建立赛马 profile 分组，例如 `fast` / `reasoning` / `cheap` / `review`。

---

## OF-024：Pi custom_message 进入上下文且 compaction 估算忽略，导致主 agent 上下文爆炸

- 优先级：P0
- 状态：planned（先工厂止血，后给 Pi 提 issue/MR）
- 兼容性：中
- 相关文件：
  - Pi 上游：`dist/core/session-manager.js`, `dist/core/compaction/compaction.js`, `dist/core/agent-session.js`
  - 工厂侧：`index.ts` 的 `/talk` / `factory_talk` / `sendTalkMessage` / `flushTalkLive`
  - 分析报告：飞书文档《牛马工厂主 Agent 上下文爆炸与 Subagent 留痕隔离分析》
  - Pi 上游交接：`docs/pi-custom-message-context-handoff.md`

### 现状

2026-07-04 主 agent 触发上下文窗口错误：

```text
Error: 400 This model's maximum context length is 1048565 tokens. However, you requested 2594293 tokens.
```

只读分析确认：主 session 内 `ox-talk-live` / `ox-talk-attached` / `ox-talk-finished` 等员工展示消息以 Pi `custom_message` 形式落盘，而 Pi `buildSessionContext` 会把 `custom_message` 作为 LLM 上下文消息。最新一次 compaction 的 `firstKeptEntryId` 指到两天前，保留段里有 1.1 万多条 `ox-talk-live`，成为实际 token 主体。

### Pi 上游问题判断

这不只是 ox-factory 使用姿势问题，Pi 上游也存在可提交 issue/MR 的点：

1. `appendCustomMessageEntry` 注释明确 custom message participates in LLM context，但 `display` 字段容易被扩展作者误解为“只展示”。
2. `findCutPoint` 反向累计 `keepRecentTokens` 时只累计 `entry.type === "message"`，没有把 `custom_message` 纳入预算；但 `buildSessionContext` 又会真实携带 custom_message。
3. `findValidCutPoints` / `findTurnStartIndex` 把 `custom_message` 当 user-role turn，可导致 cutpoint 选择与实际 token 预算偏离。
4. compaction 结束后缺少“压完后的上下文是否仍超窗”的校验与更激进 fallback。

### 工厂侧止血方向

- `/talk` 的 live 输出默认改成 display-only：写 job events + Web/Widget 展示，不再 `pi.sendMessage` 进入主 session。
- `ox-talk-attached` / `ox-talk-finished` 只允许短摘要或 job id，完整 transcript 留在 `.pi/workers/jobs/*/events.jsonl`。
- `factory_talk` 默认返回短摘要 + job id，避免完整 worker transcript 作为 toolResult 污染主上下文。
- 当前损坏主 session 不直接原地编辑；优先 clean handoff session 或复制文件 sanitizer。

### Pi issue / MR 方向

- Issue：说明 `custom_message` 参与上下文但 compaction token 预算忽略，导致 overflow recovery 后仍可能超窗。附主 session 统计、复现 fixture 和期望行为。
- MR 方案 A：`findCutPoint` 预算累计使用 `getMessageFromEntryForCompaction`，将 `custom_message` 纳入 token 估算。
- MR 方案 B：为 `sendMessage` 增加 `context: false` / `displayOnly` 或新的 UI-only message channel，明确不进入 LLM context。
- MR 方案 C：compaction 后重新估算 context，仍超窗则自动降级为更激进 cutpoint 或提示无法恢复。

### 控制台完整输出与上下文隔离的取舍

用户希望继续在控制台看到员工完整输出，但不让主 agent 感知这些内容。当前 Pi 插件 API 下，`pi.sendMessage` 只有“写入 session 并展示”这一条主路径；只要走 `custom_message`，后续就会进入 LLM context。

可选方向：

1. **短期保守**：继续 `pi.sendMessage` 展示 started/attached/finished 短摘要；`ox-talk-live` 不再写上下文，完整 live 留在 job events，并提供 `/attach` / `/watch` / Web 查看。控制台不再天然完整，但最安全。
2. **TUI Widget**：用 `ctx.ui.setWidget` 在控制台显示 live 面板，不写 session。这样控制台能看到实时内容，但历史滚动/持久化能力取决于 Pi Widget 行为；完整历史仍以 job events 为准。
3. **Pi 上游增强**：给 `sendMessage` 增加 `context:false` / `displayOnly`，做到“控制台正常展示 + 不进 LLM context”。这是最理想方案，适合作为 Pi MR。
4. **命令式查看**：默认不污染；用户显式 `/attach <job>` 或“把这段交给秘书”时，只注入 capped summary 或指定片段。

### 临时 Pi 验证记录

2026-07-04 已在隔离临时目录做两组验证，未影响真实主 session：

- `ctx.ui.setWidget` 探针：
  - 临时目录：`/tmp/ox-widget-probe-run`
  - 临时扩展：`/tmp/ox-widget-probe/index.ts`
  - 结果：真实 Pi TUI 可展示并刷新 widget；退出后未发现 `custom_message` / `ox-widget-probe` / `tick=` 落盘。
- 当前 ox-factory `/talk` 旧链路 smoke：
  - 临时目录：`/tmp/ox-factory-talk-smoke`
  - 临时 worker：`临时包包`
  - 后端：`minimax/MiniMax-M2.7-highspeed`
  - job：`20260704065456-_-gdglz1`
  - 结果：能招人、能启动 `/talk`、能 streaming、能写 job/events/worker session，job 状态 `done`。
  - 风险确认：主 session 仍写入 `ox-talk-started` / `ox-talk-live` / `ox-talk-finished` 三条 `custom_message`，因此旧 live 链路功能可用但上下文安全不合格。

结论：可以进入工厂侧止血实现；目标不是继续加固旧 `ox-talk-live` custom_message，而是把 live tail 迁到 `ctx.ui.setWidget`，完整内容保留在 job events。

### 当前救援记录

2026-07-04 已做一次主 session 止血：

- 操作方式：备份原 session 后，把历史 `ox-talk-live` 的 `custom_message` 转成 `custom` 归档 entry。
- 备份：`<main-session-backup>.jsonl.bak-emergency-ox-talk-live-20260704-140221`
- 归档数量：23444 条 `ox-talk-live`。
- 验证：`buildSessionContext` 估算从约 2.26M tokens 降到约 808K tokens，低于 deepseek-v4-pro 的 1,048,565 上下文窗口。
- 兼容性：旧完整 live 内容保留在归档 entry 的 `data.content` 和 backup 文件中，但不再作为 Pi custom_message 渲染/进入上下文。

### 当前结论

先通过 live-only sanitizer 让主 agent 可恢复；后续仍要做工厂侧止血，避免新 `ox-talk-live` 继续累积；再整理 Pi 上游最小复现和 MR。

---

## OF-025：Web 项目视角仍使用 job.project 派生，定时任务缺少可视化页面

- 优先级：P1
- 状态：assigned（包包）
- 兼容性：高
- 相关文件：
  - `web-server.mjs`
  - `web/app.js`
  - `web/index.html`
  - `web/styles.css`
  - `projects.mjs`
  - `.pi/workers/projects.jsonl`
  - `.pi/workers/queue.jsonl`
  - 交接文档：`docs/ox-factory-web-project-schedule-handoff-baobao.md`

### 现状

Project Entity MVP 已经存在，`GET /api/projects` 也返回了 `catalog`。但当前 Overview 的“项目态势”仍来自 `buildProjectStrips(workersDir)`，也就是从 `job.project` 派生的活动条。

这会导致：

- `talk` 这类对话模式 / 默认 job 标签被当成项目展示。
- 真正的 Project Entity（如 `ox-factory`、`capital-pie`、`nextact-client`）没有成为 Web 大盘的一等主视角。
- 项目 source-of-truth、Todo、Worktree、进展、成员关系没有被充分可视化。

另外，`factory_queue` / runner / cron 的定时任务记录在 `.pi/workers/queue.jsonl` 和 `history.log`，当前只能通过 `factory_check` 看文本，Web 没有独立 Schedules 页面。

### 影响

用户现在看到的是“人员视角 + job 标签视角”，不是完整“工厂 / 项目大盘”。随着项目增多，会出现：

- 不知道当前有哪些真实项目。
- 不知道每个项目的负责人、Todo、进展和 source-of-truth。
- 不知道定时任务是否还在跑、失败了多少、哪些是循环任务。
- 容易再次把 `queue.jsonl` 误当成全员工作总账。

### 建议方向

1. Overview 的项目态势改为 Project Entity 优先，`job.project` 派生活动只作为辅助区。
2. 新增 `Projects` 页面，只读展示项目：状态、优先级、source-of-truth、links、members、todos、worktrees、progress、相关 jobs。
3. 新增 `Schedules` 页面，只读展示 runner/cron/factory_queue 队列流水：pending/running/done/failed/stale/repeat、计划时间、循环周期、worker、project、task、summary/error。
4. 保留当前 `/api/projects` 兼容字段；必要时新增 `/api/schedules`，不破坏旧接口。
5. 第一版继续手动刷新，不做自动轮询。

### 当前动作

2026-07-04 派派已整理包包交接文档，并通过 `messages.jsonl` 把任务发给包包（message id: `msg_mr5zr5mt_iwa67d`）。

2026-07-05 补充 Project 文档入口需求：

- Project Entity 继续只记录必要结构和文档入口，不把长项目管理内容全部结构化。
- 网络地址 / 飞书 URL：Web 页面点击直接新窗口打开。
- 本地 Markdown：新增只读 API `GET /api/project-doc?project=<id>&ref=<ref>`，前端点击后在页面内渲染 Markdown。
- 安全边界：只读取项目结构里已登记的本地 `.md`，未登记路径拒绝；不做编辑、不做飞书抓取、不新增写接口。
- 已新增包包交接文档：`docs/ox-factory-web-project-doc-handoff-baobao.md`，并发消息给包包（message id: `msg_mr7kyga3_co5bia`）。

---

## OF-026：员工通信只是留言，缺少回调唤醒和有记忆指挥模式

- 优先级：P0
- 状态：design
- 兼容性：中
- 相关文件：
  - `comm.mjs`
  - `comm-cli.mjs`
  - `index.ts` 的 `factory_message_send` / `factory_talk` / `factory_queue` / `/talk`
  - `jobs.mjs`
  - 设计文档：`docs/ox-factory-command-mode-design.md`

### 现状

授权式通信已经可以写入 `.pi/workers/messages.jsonl`，员工也能通过 `factory_inbox` 或 `comm-cli.mjs inbox` 查看。但它本质仍是留言板：

- 消息不会自动触发员工去看。
- 忙碌员工没有“空闲后处理 inbox”的回调。
- 主 agent 想像 subagent 一样直接指挥某个长期员工时，没有一个明确的“有记忆指挥模式”工具。

### 用户期望

1. 邮件 / 消息进入后，可以 queue 一个任务让员工去看。
2. 员工空闲后可以处理这些消息，必要时执行任务。
3. 如果员工空闲，主 agent 可以直接唤起该员工的长期 session 做事。
4. 该模式要隔离主 agent 上下文：员工完整输出留在 worker session / job events，不回灌到主 agent。

### 推荐方向

- `messages.jsonl` 仍是通信事实源。
- `jobs/events/session` 承担执行事实源。
- 第一版显式 `wake=true`，不默认自动唤醒，避免任务风暴。
- 单人消息可 wake；广播第一版不自动唤醒全员。
- 新增 `factory_command` 作为“有记忆 subagent”指挥入口：复用员工 session，返回 job id / 短摘要。

详细设计见 `docs/ox-factory-command-mode-design.md`。

### 当前实现记录

2026-07-04 已落地最小内核版：

- 新增 `factory_command`：
  - 复用员工长期 session；
  - 复用 per-worker in-process queue；
  - 支持 `auto` / `queue` / `steer` / `now`；
  - 返回 job id / placement 短摘要，完整输出留在 job events 和员工 session。
- `factory_message_send` 新增显式 `wake`：
  - 默认不唤醒，避免普通留言触发任务风暴；
  - `wake=true` 且单人目标时，检查 `work:assign`；
  - 有权限则创建 `kind=inbox` job，让员工处理指定 message id；
  - 广播 wake 默认拒绝。
- `factory_talk(background=true)` 与即时 `factory_queue` 复用同一 `enqueueWorkerCommand`，减少多套队列行为分叉。

待真实 reload 后验证：

- 主 agent 自然语言触发 `factory_command`。
- `factory_message_send(... wake=true ...)` 能给空闲员工启动 inbox job。
- 忙碌员工 wake job 正确排队。
- 无 `work:assign` 时 wake 被拒绝但消息仍发送。

---

## OF-027：员工后台成果缺少未读 pick 入口，完成结果容易漏看

- 优先级：P0
- 状态：in-progress（`factory_pick` + `/pick` 已落地，待 reload 后人工验证）
- 兼容性：高
- 相关文件：
  - `job-pick.mjs`
  - `jobs.mjs`
  - `index.ts`
  - `.pi/workers/job-read.jsonl`
  - `test/ox-factory.test.mjs`

### 现状

后台 job 体系已经能记录员工执行结果，但用户想“随手捞一个没读过的成果看看”时，只能手动翻 `factory_jobs` / `factory_attach`。

这会导致：

- 员工做完的结果容易被淹没。
- 主 agent 不知道哪些 job 用户已经看过。
- Web/日报之外缺少一个低成本的“消费成果”入口。

### 方案

新增 append-only 已读事实源：`.pi/workers/job-read.jsonl`。

- `pickUnreadJob` 从最近 job 中挑终态且未读的 job。
- 默认随机挑选，支持 `latest`。
- 默认展示后写入 `job_read` event，不修改原 job metadata / events。
- `/pick --peek` 只预览，不写 `job_read`，适合“先看一眼、晚点再处理”。
- 输出短摘要 + 最近结果，完整内容继续引导 `/attach <jobId>`。

### 当前落地

2026-07-05 已实现最小安全版：

- 新增 `job-pick.mjs`：
  - `readJobReadState`
  - `markJobRead`
  - `pickUnreadJob`
  - `formatPickedJob`
- 新增 `factory_pick`：
  - 支持 `worker` / `project` / `status` / `mode` / `markRead` / `limit`。
  - 适配主 agent 自然语言：“pick 一个结果看看”。
- 新增 `/pick [员工名]`：
  - 默认随机未读并标记已读。
  - 支持 `/pick --peek` / `/pick 员工名 --peek`，预览但不标记已读。
  - 支持 `/pick --latest`，查看最近未读。
  - 不触发额外 LLM turn。
- 已补单测：
  - 未读终态筛选。
  - 已读落盘。
  - 工具 / slash command 暴露。

### 暂不做

- 不做自动推送结果，避免再次污染主 agent 上下文。
- 不做 Web 未读页面；后续可以复用 `job-read.jsonl`。
- 不做已读撤销；需要时再补 `job_unread` event。

---

## OF-028：缺少任务取消、steer 后端语义说明和员工休假状态

- 优先级：P0
- 状态：in-progress（内核已落地，待 reload 后人工验证）
- 兼容性：中
- 相关文件：
  - `index.ts`
  - `registry.ts`
  - `types.ts`
  - `jobs.mjs`
  - `web-server.mjs`
  - `docs/ox-factory-web-worker-state-handoff-baobao.md`
  - `test/ox-factory.test.mjs`

### 背景

用户反馈三类“工厂运行控制”能力缺口：

1. 发错任务时，需要能当场取消后台 job，而不是只能等它跑完。
2. `steer` 的行为要按后端讲清楚：Codex active turn 可以插入当前 turn；Pi 后端没有当前 turn steer 能力，只能在当前 job 后优先排队。
3. 有些员工长期没活，用户不希望推荐/派活/指挥他们，需要一个“休假”状态。

2026-07-06 步美调研补充：Pi 本身如果以 `pi --mode rpc` 长期子进程运行，可以通过 stdin/stdout JSONL 发送 `{type:"steer", message:"..."}` 或 prompt + `streamingBehavior:"steer"`，在当前 assistant turn / 已发起 tool calls 完成后、下一次 LLM call 前插入。这意味着“Pi 后端 active steer”技术上可做，但需要把当前 one-shot `--mode json -p` worker 改成 RPC 生命周期管理，不能只在现有队列上补一行。

### 当前落地

2026-07-06 已落地最小内核版：

- 新增 `WorkerStatus = "vacation"`，并新增 `ox-worker-status` 事件持久化。
- 新增 `factory_worker_status`：
  - `status="vacation"`：员工休假，不再接新任务；
  - `status="idle"`：返岗，恢复接任务。
- `getActiveWorkers()` 排除休假员工；`dispatch` / `race` / `/talk` / `/queue` / `/steer` / `factory_talk` / `factory_command` / `factory_queue` / `message wake` 都会拒绝休假员工接新任务。
- 新增 `factory_cancel_job` 和 `/cancel`：
  - 当前 Pi 进程内 running job：触发 `AbortController`，Codex 后端走 `turn/interrupt`，Pi 后端 kill 子进程；
  - 等待队列 job：移出内存队列并标记 `aborted`；
  - reload 前遗留 / 其他进程 job：只能标记 `aborted`，无法保证杀掉底层进程。
- `steer` 文案和 placement 明确分后端：
  - Codex 后端且存在 active turn：直接 `turn/steer` 插入当前 turn；
  - Pi 后端或没有 active turn：创建优先 job，排在当前 job 后。
- 新增结论：Pi RPC steer 可作为后续升级方向，但当前代码仍使用 `spawner.ts` 的一次性 `pi --mode json -p` 子进程，因此本轮不直接改主链路。
- Web API 只读暴露 `vacation` 状态：`/api/workers` / `/api/workers/:name` 会读取 `ox-worker-status`，页面展示交给包包。

### 待 reload 后验证

1. `factory_worker_status(name=某员工, status=vacation)` 后，该员工从推荐/派活/指挥/talk/wake 中被拒绝。
2. `factory_worker_status(..., status=idle)` 后可重新接任务。
3. `/cancel <jobId>` 能取消当前 Pi 进程内 in-process job；job metadata/status/events 显示 `aborted`。
4. 忙碌 Codex 员工 `/steer xxx` 在有 `codexActiveTurnId` 时走当前 turn；Pi 员工文案明确是“当前 job 后优先执行”。
5. Web 页面刷新后能展示 `vacation` 状态，不把休假员工误算成 busy/error。

### 暂不做

- 不做 Web 写操作：页面不直接让用户点按钮休假/返岗/取消 job；先只读展示。
- 不做跨进程强杀：reload 后遗留 job 只能标记 `aborted`，不猜测 PID 杀进程。
- 不做“休假中但当前 job 仍在跑”的复杂双状态；当前 job 继续以 job events 为准，休假状态只阻止新任务。
- 不在当前 one-shot Pi 后端里伪造 active steer。真正的 Pi active steer 需要新增 `pi-rpc` worker 运行模式：长期进程、stdin 写 steer、stdout 事件转换、heartbeat/cancel/reload 恢复都要重新设计。

---

## 初始推进建议

建议按以下顺序逐条讨论：

1. `OF-020` 日报多源聚合与模板固定：低侵入、高收益，先让布朗尼不再误判全员产出。
2. `OF-004` 履历恢复去重：小、明确、兼容性高。
3. `OF-001` 员工职责字段：直接解决“谁负责什么”。
4. `OF-017` 补测试框架：为后续恢复问题兜底。
5. `OF-008` job PID / heartbeat：reload 稳定性的基础。
6. `OF-007` reload recovery：替换粗暴 stale。
7. `OF-002` Project 实体：开始系统化项目管理。
8. `OF-015` 飞书同步：把布朗尼工作产品化。
9. `OF-022` 本地 Web 可视化：在数据源稳定后做只读驾驶舱，承接东子对外宣讲和真实本地使用。

## 更新记录

| 日期 | 更新 |
|---|---|
| 2026-06-30 | 初版：记录 18 条牛马工厂架构和稳定性问题。 |
| 2026-06-30 | 新增 OF-019：员工间通信、请求接活与派活权限体系缺失。 |
| 2026-06-30 | OF-019 落地授权式通信 MVP：无授权拒绝、秘书全权限、显式授权后可发消息/广播。 |
| 2026-06-30 | OF-018 落地 Token 监控 MVP：新增 token 聚合器、CLI、factory_token_report 和 Codex usage 提取。 |
| 2026-07-01 | OF-018 修复 Codex 员工 token 记 0：确认 app-server `Turn` 无 usage，新增 `thread/tokenUsage/updated` 通知捕获，按 `last` turn usage 写入 job。 |
| 2026-07-01 | OF-018 补充 cached/reasoning token 口径：token_report 展示缓存输入、推理输出、provider total 和含缓存合计；Codex usage 捕获同步写入这些字段。 |
| 2026-07-01 | OF-018 优化 Markdown 展示单位：token_report Markdown 用 K/M 紧凑显示，JSON 输出继续保留原始整数，方便机器消费。 |
| 2026-06-30 | 新增 OF-020：日报数据源只读 queue.jsonl，导致全员产出遗漏。 |
| 2026-06-30 | OF-020 落地 MVP：新增日报上下文聚合器、CLI、工厂工具和 foreman 日报数据规则。 |
| 2026-06-30 | OF-007/008/009/017 落地 reload/job 恢复低风险版：新增 heartbeat、startup recovery、orphan-running 和 late-event guard。 |
| 2026-07-02 | 新增 OF-021：员工上下文压缩质量不稳定，落地 Codex 代压缩后端和 smoke CLI；`测试员` session 样本已跑通。 |
| 2026-07-02 | OF-021 补充 shadow 双跑灰度：Pi 原生压缩保持主链路，Codex 只旁路生成摘要并写入 `compaction-shadow.jsonl` / `compactions/*.md`，新增 `factory_compaction_report` 和 CLI 对比报告。 |
| 2026-07-02 | OF-021 补充主 agent shadow-only：识别 `~/.pi/agent/sessions/...` 主会话，记录 `targetType=main`，拒绝主 agent apply，专注评估不采纳。 |
| 2026-07-02 | OF-021 调整主 agent shadow 为默认开启：无需额外环境变量，加载新代码后主 agent compaction 会自动旁路双跑 Codex 并落对比记录；员工仍默认关闭。 |
| 2026-07-02 | 新增 OF-022：本地 Web 可视化工厂驾驶舱，专项规划见 `docs/ox-factory-web-visualization-plan.md`。 |
| 2026-07-02 | OF-022 已派给八村：新增 `docs/ox-factory-web-frontend-handoff-hachimura.md`，通过 `messages.jsonl` 发送 Phase 1 只读 dashboard 任务。 |
| 2026-07-02 | 新增 OF-023：Pi 后端多模型来源接入与工厂 profile 管理；已接入 `super-relay` Responses 试点模型并新增 `super-relay-exp` profile。 |

| 2026-07-04 | OF-002 落地 Project Entity MVP：新增 `projects.jsonl`、`projects.mjs`、`factory_project_*` 工具和 `docs/ox-projects` 文档模板，项目可维护 source-of-truth、Todo、Worktree、进展与人员。 |
| 2026-07-04 | 新增 OF-024：记录 Pi custom_message/compaction 预算不一致导致主 agent 上下文爆炸；后续先工厂止血，再给 Pi 提 issue/MR。 |
| 2026-07-04 | 新增 OF-025：Web 项目态势需切到 Project Entity，定时任务需要 Schedules 页面；已整理包包交接文档并通过 messages.jsonl 派活。 |
| 2026-07-04 | OF-024 执行主 session emergency sanitizer：备份原文件并归档 23444 条 `ox-talk-live`，验证上下文估算降到约 808K；后续仍需从源头停止 live 输出污染。 |
| 2026-07-04 | OF-024 临时 Pi 验证：`ctx.ui.setWidget` 可 display-only 展示且未落 `custom_message`；临时 Minimax worker 跑通旧 `/talk`，同时确认旧链路仍会写 `ox-talk-live` custom_message。 |
| 2026-07-04 | OF-024 补充 Pi 上游交接文档：`docs/pi-custom-message-context-handoff.md`，可直接给 Pi issue/MR 负责人看。 |
| 2026-07-04 | 新增 OF-026：员工通信回调唤醒与有记忆指挥模式；设计文档见 `docs/ox-factory-command-mode-design.md`。 |
| 2026-07-04 | OF-026 落地最小内核版：新增 `factory_command`，`factory_message_send` 支持显式 `wake` 创建 inbox job；后台 talk/即时 queue 复用统一员工队列入口。 |
| 2026-07-04 | OF-025 修复 Web Projects 详情兼容问题：旧 8787 web-server 未加载 `/api/projects/:id` 时会把 API 请求 fallback 成 `index.html`，前端误当详情对象读取 `status`；现前端增加 catalog 兜底与数据防御，后端补 `/api/*` JSON 404。 |
| 2026-07-05 | OF-025 补 Project 文档入口方案：新增 `/api/project-doc` 只读接口用于渲染已登记本地 Markdown，外链/飞书 URL 由前端直接打开；已发包包交接。 |
| 2026-07-05 | OF-006/OF-023 修复 Codex 员工 full access 配置被旧全量 `ox-worker-config` 快照覆盖：`updateWorkerConfig` 改为只追加显式 patch，新增 `factory_worker_config`，并为步美补最终 `danger-full-access` 配置；待 reload 后实测。 |
| 2026-07-05 | OF-006/OF-023 补 `resetCodexThread`：旧 Codex thread 仍保持 `workspace-write` 时，可清空 thread id 并把最近 job handoff 注入新 full-access thread；需要 reload 一次加载新工具。 |
| 2026-07-05 | OF-006/OF-023 补 `factory_worker_config.workerId` alias：兼容主 agent 按“workerId=步美”调用导致的参数不匹配；标准写法仍是 `name=步美`。 |
| 2026-07-05 | OF-006/OF-023 调整 Codex 招募默认权限：`factory_hire backend=codex` 默认 `codexSandbox=danger-full-access`，显式指定时才使用受限 sandbox。 |
| 2026-07-05 | OF-019 补管理层权限：派派加入内置 admin，新增 `worker:fire` 权限动作，`factory_fire` 默认秘书兼容旧调用并支持显式 actor 权限校验。 |
| 2026-07-05 | 新增 OF-027：落地 `/pick` / `factory_pick` 未读成果入口，用 append-only `job-read.jsonl` 记录已读 job，避免后台成果漏看。 |
| 2026-07-05 | OF-027 补 `/pick --peek`：只预览未读成果、不写 `job_read`，适合“先看一眼，晚点再看”。 |
| 2026-07-06 | 新增 OF-028：落地 `factory_worker_status` 休假/返岗、`factory_cancel_job`/`/cancel` 取消任务，并明确 Codex/Pi steer 后端语义；Web 只读展示需求已交给包包。 |
| 2026-07-06 | OF-028 补充步美 Pi RPC steer 调研：`pi --mode rpc` 可通过 JSONL IPC 支持运行中 steer；当前 one-shot `--mode json -p` 链路不改，后续如要做需新增 `pi-rpc` worker backend。 |
| 2026-07-06 | OF-018 复查光彦 Codex token：确认 `last_token_usage` 低估整次任务约 33x；新增只读 `codex-rollout-token-report.mjs` 按 rollout `total_token_usage` delta 回算并对比现有 job 口径。 |
| 2026-07-06 | OF-018 修复 Codex token 主链路：新增累计 usage tracker，后续 job 写入 `total_token_usage` delta；`codex-rollout-token-report.mjs` 增加 `--repair-preview/--apply-jobs`，并已审计所有 Codex done job，可匹配项修复 281/284。 |
| 2026-07-06 | 新增 OF-029：内网 Codebase 分享安装层补齐 README Quick Install、INSTALL.md、`.env.example` 和 `npm run install-check`，明确不提交本地 token / `.pi/workers` 运行数据。 |
| 2026-07-06 | OF-022 补 `/ox-web`：Pi 内一条指令即可检查/启动/打开本地 Web dashboard，日志写入 `.pi/workers/web-server-PORT.log`，手动 node 启动降级为兜底。 |
