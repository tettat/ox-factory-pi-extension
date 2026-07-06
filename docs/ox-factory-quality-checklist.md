# 牛马工厂质量 Checklist

更新时间：2026-07-06 +0800

定位：`talk / ox-factory` 的功能质量总账。用于把我们聊过并确认过的需求拆成可验收条目，持续记录能力边界、实现状态、测试证据、剩余风险和下一步。  
关系：`docs/ox-factory-improvement-tracker.md` 记录问题 backlog；本文记录“要做到什么程度才算稳”。

## 使用规则

1. 新能力先在本文登记边界和验收项，再补测试，再实现，再回填证据。
2. 不能只因为“代码写了”就标完成。完成至少要有：预期行为、测试/人工验证证据、检查时间。
3. 涉及员工互相派活、自动执行、飞书审批、外部写接口的能力，默认拆成单独条目；未确认前不自动执行。
4. 当前阶段优先做 append-only 或只读能力，避免 reload 后影响工厂主链路。
5. 本文不复制所有设计细节；复杂设计可以另开专项文档，但验收状态回填到本文。

## 状态字段

| 字段 | 说明 |
| --- | --- |
| 对齐度 | 未盘点 / 待确认 / 已确认 / 不适用 |
| 完成度 | 未开始 / 设计中 / 代码完成 / 已验证 / 暂缓 |
| 用例覆盖 | 无用例 / 已有单测 / 已人工验证 / 待补 E2E / 不适用 |
| 文档覆盖 | 无文档 / 已在总账细化 / 已有专项文档 |
| 检查时间 | 最近一次认真检查日期 |

## 近期优先级看板

| 优先级 | 事项 | 范围/验收 | 状态 | 最近进展 | 下一步 | 证据/链接 | 更新时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | 员工职责 / 负责项目 | 能为员工显式设定当前职责，Web 大盘可显示，不与历史履历混淆 | 已验证 | 已新增 `responsibilities.jsonl`、职责工具、Web API/详情展示 | reload 后用自然语言设定真实员工职责 | `responsibilities.mjs`, `factory_responsibility_*`, `/api/responsibilities` | 2026-07-02 |
| P0 | Project Entity / 项目视角 | 项目作为一等实体维护必要信息、source-of-truth、Todo、Worktree、进展和人员 | 已确认 | MVP 已落地 | 已有单测 | `projects.mjs`, `factory_project_*`, `.pi/workers/projects.jsonl`, `docs/ox-factory-project-entity-design.md` | 2026-07-04 |
| P0 | 日报数据视野 | 布朗尼不能只看 queue；日报上下文要聚合 jobs/queue/sessions/主 session 管理动作 | 进行中 | 已落地 `factory_report_context`、`/report`、`report-sources.mjs` | reload 后人工验证工具可用，并固定日报模板 | `report-context.mjs`, `report-sources.mjs`, `ox-factory.test.mjs` | 2026-06-30 |
| P0 | 授权式员工通信 | 默认无权限不能通信；秘书全权限；显式 grant 后才能发消息/广播 | 代码完成-待 reload 验证 | 已落地权限文件、消息 JSONL、permission/message 工具、员工 CLI 和单测 | reload 后人工验证工具注册和实际收发 | `comm.mjs`, `comm-cli.mjs`, `factory_permission_*`, `factory_message_*` | 2026-06-30 |
| P0 | 通信回调 / 有记忆指挥模式 | 消息可显式 wake 成员工 job；主 agent 可用短摘要方式唤起长期员工 session，像有记忆 subagent 一样隔离干活 | 核心已落地-待 reload 验证 | 已新增 `factory_command`；`factory_message_send` 支持 `wake`；后台 talk/即时 queue 复用统一员工队列入口 | reload 后验证自然语言触发、wake 空闲/忙碌/无权限/广播边界 | `index.ts`, `docs/ox-factory-command-mode-design.md`, OF-026 | 2026-07-04 |
| P0 | 运行控制：取消 / steer / 休假 | 能取消当前后台 job；steer 文案按 Codex/Pi 后端讲清楚；员工可设休假并从新任务入口排除 | 代码完成-待 reload 验证 | 已新增 `factory_cancel_job`、`/cancel`、`factory_worker_status`、`vacation` 状态与 Web API 只读暴露 | reload 后验证休假拒绝新任务、返岗可接活、取消 running/queued job、Codex/Pi steer placement 正确；包包补页面展示 | `index.ts`, `registry.ts`, `types.ts`, `web-server.mjs`, OF-028 | 2026-07-06 |
| P0 | `/pick` 未读成果入口 | 主 agent / 用户能从后台 job 中随机捞一个未读终态成果，展示短结果并标记已读；`--peek` 只预览不标已读 | 代码完成-待 reload 验证 | 已新增 `job-read.jsonl`、`job-pick.mjs`、`factory_pick`、`/pick` 和 `/pick --peek` | reload 后说“pick 一个结果看看”验证自然语言工具触发；`/pick [员工名] --peek` 验证预览不标已读 | `job-pick.mjs`, `factory_pick`, `/pick`, `pickUnreadJob...` 单测 | 2026-07-05 |
| P1 | 员工 Token 监控 | 按日期/员工统计 input/cached-input/output/reasoning-output/total token；不算钱、不做绩效；session 优先、job 兜底；主 agent 通过自然语言触发 | 代码完成-待 reload 验证 | 已修复 Codex 记 0 并补 cached/reasoning；2026-07-06 发现 `last_token_usage` 只是 Codex 任务内最后一次模型调用，光彦当天 job 口径低估约 35x；已改主链路为 `total_token_usage` 累计 delta，并新增 rollout 回算/修复脚本 | reload 后验证新 Codex job；历史可用 `codex-rollout-token-report.mjs --apply-jobs` 恢复/核对；已审计所有 Codex done job，当前可匹配已修复 281/284，剩余 3 个无独立 rollout 段不猜 | `token-report.mjs`, `token-report-cli.mjs`, `codex-backend.mjs`, `codex-rollout-token-report.mjs`, `factory_token_report` | 2026-07-06 |
| P1 | Codex 员工运行配置 | 能显式修正 Codex 员工 sandbox / approval；运行态 thread 更新不能覆盖人工授权配置；旧 thread sandbox 粘住时可 reset thread 并带 handoff | 代码完成-待 reload 验证 | 已新增 `factory_worker_config`；`updateWorkerConfig` 改为只追加显式 patch；补 `resetCodexThread` 清空 `codexThreadId` 并生成最近 job handoff，下一次任务新建 full-access thread；`name`/`workerId` 均可指定员工；Codex 招募默认 `danger-full-access`，只有显式指定时才收紧 sandbox | 需要 reload 一次加载新工具；reload 后重新招募 Codex 员工默认就是 full access；对旧员工/旧 thread 可执行 `factory_worker_config(name=步美, codexSandbox=danger-full-access, codexApprovalPolicy=never, resetCodexThread=true)` 后再只测 touch | `index.ts`, `registry.ts`, `codex-backend.mjs`, `types.ts`, `ox-factory.test.mjs`, OF-006/OF-023 | 2026-07-05 |
| P1 | reload/job 恢复 | 不再粗暴 stale；补 ownerPid/ownerInstanceId/heartbeat；能识别 fresh orphan-running；stale 后 late event 不再污染正常事件流 | 代码完成-待 reload 验证 | 已落地 heartbeat、startup recovery、late-event guard 和单测 | reload 后人工验证 running job 不被误标 stale，过期 job 仍 stale | `jobs.mjs`, `spawner.ts`, `index.ts`, `ox-factory.test.mjs` | 2026-06-30 |
| P1 | Web 展示与启动入口 | Web agent 基于稳定数据接口做 dashboard；用户可用 `/ox-web` 启动/打开本地页面 | 代码完成-待 reload 验证 | 已补 `/ox-web`：健康检查、未启动自动后台启动、打开浏览器、状态查询、日志路径 | reload 后执行 `/ox-web --status` 与 `/ox-web` 人工验证 | `web-server.mjs`, `index.ts`, `README.md`, `INSTALL.md`, OF-022 | 2026-07-06 |
| P1 | Web 项目视角 / 定时任务视图 | Overview 使用 Project Entity 作为项目态势主视角；Schedules 页面只读展示 runner/cron/factory_queue 流水；Project 文档入口支持外链打开和本地 Markdown 渲染 | 已派活给包包 | 已补 `/api/project-doc` 只读接口和安全路径校验，并将前端渲染任务派给包包 | 包包实现 Project 详情页文档点击：外链新开，本地 md 用 `mdNode()` 渲染 | `docs/ox-factory-web-project-schedule-handoff-baobao.md`, `docs/ox-factory-web-project-doc-handoff-baobao.md`, OF-025, `web-server.mjs` | 2026-07-05 |
| P1 | Pi display-only 输出探针 | 评估 `ctx.ui.setWidget` 作为 live 输出展示通道，避免 `custom_message` 污染主上下文 | 已验证-待接入 | 临时 Pi 已验证 widget display-only 可展示且未落 `custom_message`；临时 Minimax worker 证明旧 `/talk` 功能链路可跑但仍污染 session；Pi 上游交接文档已整理 | 实现 `talkLiveSink`，再做一轮 “widget live + 无 ox-talk-live custom_message” 回归 | `docs/pi-display-only-output-plan.md`, `docs/pi-custom-message-context-handoff.md`, OF-024 | 2026-07-04 |
| P1 | 内网 Codebase 分享 / 安装体验 | 朋友 clone 后知道放到哪里、怎么检查、怎么启动 Web、哪些运行数据不提交；不携带用户 token | 已确认 | 文档完成-已验证 | 跑 `install-check` + `verify`；后续开 remote 前人工看 staged diff | `README.md`, `INSTALL.md`, `.env.example`, `install-check.mjs`, OF-029 | 2026-07-06 |

---

## OF-029 内网 Codebase 分享 / 安装体验

模块整体状态：对齐度 `已确认`；完成度 `文档完成-已验证`；用例覆盖 `install-check + verify`；文档覆盖 `README + INSTALL + .env.example`；检查时间 `2026-07-06`。

### 已确认需求

1. 先支持内网 Codebase 私有分享，不按公开互联网开源标准一次性做完。
2. 朋友拿到仓库后，应能知道源码要放在 `<host-project>/.pi/extensions/ox-factory`。
3. 安装说明必须覆盖：clone、更新、reload/restart Pi、Web dashboard、Codex 后端可选条件。
4. 分享不应带走用户本地 token、session、rollout、`.pi/workers` 运行数据。
5. 保持现有开发验证路径：`npm run verify`。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 文档 | Quick install | README 给出最短 clone / check / verify / reload 路径 | 已确认 | 完成 | 人工检查 | `README.md` | 2026-07-06 |
| 文档 | 完整安装 | INSTALL 覆盖全新安装、更新、Web、Codex、运行数据边界、常见问题 | 已确认 | 完成 | 人工检查 | `INSTALL.md` | 2026-07-06 |
| 配置 | 示例环境变量 | `.env.example` 只放可公开变量名和安全默认值，不放真实 token | 已确认 | 完成 | secret scan | `.env.example`, `install-check.mjs` | 2026-07-06 |
| 检查 | 安装自检 | `npm run install-check` 检查布局、Node、Pi CLI、Codex WebSocket 条件和明显 token 字面量 | 已确认 | 完成 | CLI smoke | `install-check.mjs` | 2026-07-06 |
| 安全 | 运行数据边界 | `.pi/workers`、`.env`、session/rollout/token 数据不进入源码仓库 | 已确认 | 完成 | `.gitignore` + 文档 | `.gitignore`, `INSTALL.md` | 2026-07-06 |

### 当前边界

- `package.json` 仍保留 `"private": true`：当前是源码型 Pi extension，不是 npm 发布包。
- `npm run verify` 不能替代真实 Pi reload；分享安装后仍要在宿主项目实际启动一次 Pi。
- 内网 Codebase 分享允许保留部分产品讨论文档；公开互联网开源前仍需要专门做 license、商标、内部路径/域名/事故文档脱敏。

## OF-028 运行控制：取消 / steer / 休假

模块整体状态：对齐度 `已确认`；完成度 `代码完成-待 reload 验证`；用例覆盖 `工具名/源码静态校验`；文档覆盖 `已在总账细化 + 包包交接文档`；检查时间 `2026-07-06`。

### 已确认需求

1. 用户发错员工任务时，要能取消当前后台 job。
2. `steer` 要分后端解释：
   - Codex 后端且存在 active turn：插入当前 turn；
   - Pi 后端或没有 active turn：排在当前 job 后优先执行。
   - 2026-07-06 步美调研补充：如果工厂把 Pi 后端改为长期 `pi --mode rpc` 子进程，Pi 理论上也能通过 stdin/stdout JSONL 接收运行中 steer；这不是当前 one-shot `--mode json -p` 链路。
3. 员工需要“休假”状态：长期不接新任务，但不删除履历、不影响历史记录。
4. 休假员工应从推荐、派活、指挥、talk、queue、message wake 中排除。
5. Web 页面先只读展示这些状态，不做写操作。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 数据层 | `vacation` 状态 | `WorkerStatus` 支持 `vacation`，追加 `ox-worker-status` 事件，reload 后可恢复 | 已确认 | 代码完成 | 源码校验 | `types.ts`, `registry.ts`, `worker vacation status...` | 2026-07-06 |
| 工具 | `factory_worker_status` | 支持 `vacation`/`idle`，休假后拒绝新任务，返岗后可接任务 | 已确认 | 代码完成 | 工具名校验 | `factory_worker_status` | 2026-07-06 |
| 任务入口 | 休假拒绝接活 | dispatch/race/talk/command/queue/message wake 均不向休假员工创建新 job | 已确认 | 代码完成 | 源码校验 | `workerCanAcceptWork` | 2026-07-06 |
| 取消 | `factory_cancel_job` | running job 触发 abort/interrupt；queued job 移除并标记 aborted；跨进程只标记 aborted | 已确认 | 代码完成 | 工具名校验 | `cancelWorkerJob`, `workerJobControllers` | 2026-07-06 |
| 命令 | `/cancel` | 控制台可取消当前 talk job 或指定 jobId 前缀 | 已确认 | 代码完成 | 工具名校验 | `registerCommand("cancel"` | 2026-07-06 |
| Steer | 后端语义 | Codex active turn 走 `turn/steer`；Pi/无 active turn 排当前 job 后 | 已确认 | 代码完成 | 源码校验 | `canSteerActiveCodexTurn`, `/steer` description | 2026-07-06 |
| Steer | Pi RPC 可行性 | 后续可新增 Pi RPC worker backend：长期进程 + stdin steer；当前不改 one-shot Pi 后端 | 已确认 | 待设计 | 步美调研 + 源码核对 | `spawner.ts` 当前使用 `--mode json -p` | 2026-07-06 |
| Web API | 休假只读暴露 | `/api/workers` / `/api/workers/:name` 能返回 `status=vacation` | 已确认 | 代码完成 | 源码校验 | `web-server.mjs` scan `ox-worker-status` | 2026-07-06 |

### 当前边界

- 不做 Web 写按钮，避免浏览器误触发高风险操作。
- 不做 reload 后跨进程强杀，只做 metadata `aborted`。
- “休假中仍有旧 job 在跑”的情况以 job events 作为执行事实源，员工状态只表示是否接新任务。
- Pi 后端真正“当前 turn 前插入”的 steer 需要把 `spawnWorkerStreaming()` 从一次性 `pi --mode json -p <prompt>` 升级为可复用 RPC 子进程；这会影响进程生命周期、session 复用、stdout 解析和取消语义，单独排期，不混进当前安装文档任务。

---

## OF-027 `/pick` 未读成果入口

模块整体状态：对齐度 `已确认`；完成度 `代码完成-待 reload 验证`；用例覆盖 `已有单测 + 工具名校验`；文档覆盖 `已在总账细化`；检查时间 `2026-07-05`。

### 已确认需求

1. 员工后台 job 完成后，主 agent / 用户需要一个轻量入口“捞一个没读过的成果看看”。
2. 第一版只处理终态 job：`done` / `failed` / `aborted` / `stale`。
3. 默认随机 pick，避免每次都只看最新；也支持 `latest` 便于排查。
4. 展示短结果，不把完整输出灌回主 agent；完整记录通过 `/attach <jobId>` / `factory_attach` 查看。
5. 已读状态独立 append-only 落盘，不改 job 原始 metadata / events，兼容旧 `jobs` 体系。
6. 用户只是想“先看一眼、晚点再看”时，可用 `/pick --peek` 或 `/pick 员工名 --peek`，不标记已读。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 数据层 | 已读落盘 | pick 后向 `.pi/workers/job-read.jsonl` 追加 `job_read` event；不修改原 job 文件 | 已确认 | 代码完成 | 已有单测 | `pickUnreadJob selects terminal unread jobs...` | 2026-07-05 |
| 筛选 | 终态未读 | 只从终态 job 中挑选；已读 job 默认跳过 | 已确认 | 代码完成 | 已有单测 | `pickUnreadJob` | 2026-07-05 |
| 展示 | 短结果 | Markdown 展示 worker/project/status/task/最近结果，并给出 `/attach <jobId>` | 已确认 | 代码完成 | 已有单测 | `formatPickedJob` | 2026-07-05 |
| 工具 | `factory_pick` | 主 agent 可通过自然语言触发 pick，支持 worker/project/status/mode/markRead/limit | 已确认 | 代码完成 | 工具名校验 | `factory pick is exposed...` | 2026-07-05 |
| 命令 | `/pick` | 用户可直接 `/pick` 或 `/pick 员工名`，默认随机并标记已读 | 已确认 | 代码完成 | 工具名校验 | `registerCommand("pick"` | 2026-07-05 |
| 命令 | `/pick --peek` | 用户可预览一个未读结果但不写 `job_read`，之后仍会被 pick 到 | 已确认 | 代码完成 | 已有单测 + 工具名校验 | `parsePickCommandArgs supports peek...`, `--peek` | 2026-07-05 |

### 当前边界

- 不做 Web 未读队列页面；后续可让八村/包包接 `.pi/workers/job-read.jsonl` 和 jobs API。
- 不自动把员工输出推给主 agent；仍由用户/主 agent 主动 pick，避免上下文膨胀。
- 已读是“至少读过一次”的 append-only 口径；第一版不做 unread/reopen。

---

## OF-001 员工职责 / 负责项目

模块整体状态：对齐度 `已确认`；完成度 `已验证-待 reload 使用`；用例覆盖 `已有单测 + Web API smoke`；文档覆盖 `已在总账细化`；检查时间 `2026-07-02`。

### 已确认需求

1. 员工除了岗位 `role` 外，需要能记录“当前负责什么”。
2. 职责不是历史履历，不能继续塞进 `projects` / `ProjectRecord`。
3. 第一版先做显式设定，不自动从 job 文本猜测，避免 Web 页面硬编码假职责。
4. Web 大盘能读取文件层数据，不依赖 Pi 进程内存 registry。
5. 使用 append-only 记录，兼容 reload 和后续审计。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 数据层 | append-only | `factory_responsibility_set` 写入 `.pi/workers/responsibilities.jsonl`；同 `worker + project + relation` 后写覆盖展示 | 已确认 | 代码完成 | 已有单测 | `worker responsibilities are append-only...` | 2026-07-02 |
| 数据层 | remove | 移除职责写 remove event，不删除历史行；默认列表不显示 removed | 已确认 | 代码完成 | 已有单测 | `removeWorkerResponsibility` | 2026-07-02 |
| 工具 | set/list/remove | 主 agent 可通过自然语言调用职责设定、查看和移除工具 | 已确认 | 代码完成 | 工具名校验 | `factory_responsibility_set/list/remove`, `validate-tools.mjs` | 2026-07-02 |
| Web | 员工详情 | `/api/workers/:name` 返回 `responsibility` / `responsibilities`，页面职责卡片展示真实记录 | 已确认 | 已验证 | Web API smoke | `/api/workers/东子` 临时样本 smoke | 2026-07-02 |
| Web | API | `/api/responsibilities?worker=` 返回职责列表 | 已确认 | 已验证 | Web API smoke | `curl /api/responsibilities` | 2026-07-02 |

### 当前工具

| 工具 | 用途 |
| --- | --- |
| `factory_responsibility_set` | 设定员工当前职责 / 负责项目 |
| `factory_responsibility_list` | 查看员工当前职责 |
| `factory_responsibility_remove` | 移除员工当前职责（append-only remove event） |

### 使用例子

```text
给东子设定职责：负责牛马工厂 Web 大盘，relation=lead，scope=负责 Overview 大盘、项目态势和视觉 polish。
```

### 当前边界

- 这不是完整 Project Store；项目 owner、成员、backlog、文档链接仍是 OF-002。
- reload 前新工具不可用；reload 后可在主 agent 自然语言中使用。

---


## OF-002 Project Entity / 项目视角

模块整体状态：对齐度 `已确认`；完成度 `MVP 已落地-待 reload 使用`；用例覆盖 `已有单测 + 工具名校验`；文档覆盖 `设计文档 + 项目文档模板`；检查时间 `2026-07-04`。

### 已确认需求

1. 项目提升为和员工类似的一等实体，但系统不做重型项目管理。
2. 项目只记录必要信息：基本信息、single source of truth、Todo、Worktree、进展、相关人员。
3. 长 checklist、方案和报告继续放 Markdown/飞书等文档里，Project 只保存链接。
4. 旧 job 的 `project: string` 保持兼容，不做历史迁移。
5. 后续 Web 项目视角交给八村基于 Project Entity 数据层可视化。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 数据层 | append-only | `factory_project_*` 写入 `.pi/workers/projects.jsonl`，回放得到当前项目快照 | 已确认 | 代码完成 | 已有单测 | `project store records lightweight project metadata...` | 2026-07-04 |
| 项目信息 | source-of-truth | Project 保存 Markdown/飞书/外部 checklist 链接，不复制长文档 | 已确认 | 代码完成 | 已有单测 | `truthRef`, `truthType` | 2026-07-04 |
| 运行管理 | Todo/Worktree/Progress | 项目可维护待办、worktree、进展流水 | 已确认 | 代码完成 | 已有单测 | `setProjectTodo`, `setProjectWorktree`, `addProjectProgress` | 2026-07-04 |
| 人员关系 | Members | 项目可维护 owner/lead/developer/designer/reviewer 等相关人员 | 已确认 | 代码完成 | 已有单测 | `setProjectMember` | 2026-07-04 |
| 文档 | 项目模板 | 提供 `docs/ox-projects/_template.md` 作为人类可读真相源模板 | 已确认 | 文档完成 | 人工检查 | `docs/ox-projects/` | 2026-07-04 |

### 当前工具

| 工具 | 用途 |
| --- | --- |
| `factory_project_upsert` | 创建/更新项目基本信息、别名、source-of-truth 和链接 |
| `factory_project_list` | 查看项目列表或单个项目详情 |
| `factory_project_todo_set` | 维护项目 Todo |
| `factory_project_worktree_set` | 维护项目 Worktree 记录 |
| `factory_project_progress_add` | 追加项目进展流水 |
| `factory_project_member_set` | 维护项目相关人员 |

### 当前边界

- 不做飞书自动同步。
- 不做 Web 项目页实现。
- 不迁移旧 job。
- `responsibilities.jsonl` 和 Project members 暂时并行，后续可通过 projectId/aliases 对齐。

## OF-019 授权式员工通信

模块整体状态：对齐度 `已确认`；完成度 `代码完成-待 reload 验证`；用例覆盖 `已有单测`；文档覆盖 `已在总账细化`；检查时间 `2026-06-30`。

### 已确认需求

1. 员工之间**不默认自由通信**。
2. 未授权时直接拒绝，不走审批；飞书审批/人工确认以后再接。
3. 秘书 / 主 agent 代表用户，默认拥有全部权限；派派作为工厂负责人/管理层也默认拥有管理权限。
4. 用户后续通过秘书给各员工调整权限。
5. 第一版只做授权式通信，不做自动互相派活。
6. 权限动作预留 `work:request` / `work:assign`，但当前不自动创建 job。
7. 广播和单聊分开授权：`message:broadcast` 不等于 `message:send`。
8. 通信记录必须落盘，reload 后可查。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 权限默认值 | 管理层全权限 | `秘书` / `主agent` / `用户` / `user` / `secretary` / `派派` 默认允许所有动作和目标 | 已确认 | 代码完成 | 已有单测 | `comm.mjs`, `secretary can communicate by default...`, `paipai is a builtin factory admin...` | 2026-07-05 |
| 权限默认值 | 普通员工默认无权限 | 未 grant 的员工执行 `message:send` / `message:broadcast` 被拒绝，且不写消息 | 已确认 | 代码完成 | 已有单测 | `authorized communication denies ungranted workers...` | 2026-06-30 |
| 授权管理 | grant | 秘书可授予 subject/actions/targets，状态写入 `.pi/workers/permissions.json`，审计写入 `permission-events.jsonl` | 已确认 | 代码完成 | 已有单测 | `grantPermission`, `factory_permission_grant` | 2026-06-30 |
| 授权管理 | revoke | 秘书可撤销授权；撤销后同一员工不能继续向该目标发消息 | 已确认 | 代码完成 | 已有单测 | `revokePermission`, `factory_permission_revoke` | 2026-06-30 |
| 授权管理 | list/check | 可查看授权列表，也可检查某员工对某目标是否有动作权限 | 已确认 | 代码完成 | 工具名校验 | `factory_permission_list`, `factory_permission_check` | 2026-06-30 |
| 消息发送 | 单聊 | 有 `message:send` 且 target 匹配时写入 `.pi/workers/messages.jsonl` | 已确认 | 代码完成 | 已有单测 | `sendAuthorizedMessage`, `factory_message_send` | 2026-06-30 |
| 消息发送 | 广播 | `to="*"` 需要 `message:broadcast`，广播出现在所有员工 inbox | 已确认 | 代码完成 | 已有单测 | `secretary can communicate...broadcast` | 2026-06-30 |
| 收件箱 | inbox | 员工可以查看发给自己的消息；广播消息对所有员工可见 | 已确认 | 代码完成 | 已有单测 | `listMessages`, `factory_inbox` | 2026-06-30 |
| 收件箱 | 已读状态 | 标记已读通过 append `read` event，不改写历史消息 | 已确认 | 代码完成 | 已有单测 | `markMessageRead`, `factory_message_read` | 2026-06-30 |
| 员工子进程 | CLI 通信入口 | 员工没有主工厂工具时，可通过 `comm-cli.mjs send/inbox/check` 走同一套授权规则 | 已确认 | 代码完成 | 已有单测 | `comm-cli.mjs`, `comm CLI lets authorized worker...` | 2026-06-30 |
| 派活权限 | work action 预留 | `work:request` / `work:assign` 只作为权限模型预留；当前不自动 dispatch/queue | 已确认 | 代码完成 | 不适用 | `comm.mjs` action list | 2026-06-30 |
| 管理动作 | fire 权限 | `worker:fire` 纳入权限动作；`factory_fire` 默认以秘书执行，派派/管理层可显式作为 actor 执行，普通员工无授权会被拒绝 | 已确认 | 代码完成 | 已有单测 | `factory_fire`, `paipai is a builtin factory admin...` | 2026-07-05 |
| 审批 | 未授权 fallback | 当前不做 approval 队列；没授权就是没权限 | 已确认 | 暂缓审批实现 | 不适用 | 本文已确认需求 | 2026-06-30 |
| 外部审批 | 飞书审批 | 后续可接飞书/人工确认，但不进入当前实现范围 | 已确认 | 暂缓 | 不适用 | 用户确认“后面接飞书，暂时不做” | 2026-06-30 |

### 当前工具

| 工具 | 用途 |
| --- | --- |
| `factory_permission_grant` | 授权某员工对某目标执行动作 |
| `factory_permission_revoke` | 撤销授权 |
| `factory_permission_list` | 查看授权 |
| `factory_permission_check` | 检查授权 |
| `factory_message_send` | 发送授权消息 |
| `factory_inbox` | 查看员工收件箱 |
| `factory_message_read` | 标记消息已读 |
| `comm-cli.mjs` | 员工子进程通过 CLI 发送/查看授权消息，不提供 grant/revoke |

### 使用例子

允许派派给东子发消息：

```text
factory_permission_grant(
  subject="派派",
  actions=["message:send"],
  targets=["东子"],
  note="允许派派和东子讨论展示页/工厂插件开发"
)
```

派派给东子发消息：

```text
factory_message_send(
  from="派派",
  to="东子",
  content="东子，你那边展示页进度怎么样？"
)
```

查看东子收件箱：

```text
factory_inbox(worker="东子")
```

员工子进程里发送消息：

```bash
node .pi/extensions/ox-factory/comm-cli.mjs send --from 派派 --to 东子 --content "东子，你那边进展怎么样？"
```

---

## OF-018 员工 Token 监控

模块整体状态：对齐度 `已确认`；完成度 `代码完成-待 reload 验证`；用例覆盖 `已有单测 + CLI smoke + rollout 回算/修复 smoke`；文档覆盖 `已在总账细化`；检查时间 `2026-07-06`。

### 已确认需求

1. 只统计 token，不计算钱。
2. 不做绩效评分。
3. 不混入 job 完成数、产出质量或调度建议。
4. 按日期和员工统计 input token、cached input token、output token、reasoning output token、total token。
5. session usage 优先，job token 作为兜底，避免重复相加。
6. Codex app-server 的 token 来自 `thread/tokenUsage/updated` 通知；不能再直接把 `last_token_usage` 当成整次 job 用量，因为它只是 Codex 任务内最后一次模型调用。正确主链路应以 `total_token_usage` 的任务开始/结束累计差值写入 job，保留 cached/reasoning 子字段。
7. 历史 Codex job 如有 `~/.codex/sessions/**/rollout-*.jsonl`，可用只读 rollout 回算脚本恢复/核对；没有 rollout 或缺少 token_count 的历史 job 不猜测回填。
8. 主 agent 应通过自然语言使用，例如“看看东子的 token 消耗”，不要要求用户输入 `/tokens`。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 统计口径 | token only | Markdown 报告只输出 input/cached-input/output/reasoning-output/total/含缓存合计 token，不出现成本/绩效字段；Markdown 数字用 K/M 紧凑显示，JSON 保持整数 | 已确认 | 代码完成 | 已有单测 | `token report ... token-only output` | 2026-07-01 |
| 数据源 | session 优先 | 同员工同日同时有 session/job token 时，按 session 上报并提示避免重复相加 | 已确认 | 代码完成 | 已有单测 | `token report prefers session usage...` | 2026-06-30 |
| 数据源 | job 兜底 | 没有 session usage 但 job 有 token 时，用 job token 上报 | 已确认 | 代码完成 | 已有单测 | `token report prefers session usage...` | 2026-06-30 |
| Codex | usage 提取 | 支持 `usage` / `tokenUsage` / `tokens` 常见字段形态，以及 app-server v2 `ThreadTokenUsage { total,last }`；提取 cached/reasoning 字段 | 已确认 | 代码完成 | 已有单测 | `extractCodexTokenUsage` | 2026-07-01 |
| Codex | 通知捕获 | 监听 `thread/tokenUsage/updated`，以任务开始/结束 `total_token_usage` delta 给当前 job 写 input/cached/output/reasoning/total token；不再把 `last` 当整次 job 用量 | 已确认 | 代码完成-待 reload 验证 | 已有单测 + 排障证据 | `codex-backend.mjs`, `codex-rollout-token-report.mjs` | 2026-07-06 |
| 工具 | 主会话工具 | `factory_token_report` 可按日期/员工输出 markdown/json，并在工具描述里明确自然语言触发场景 | 已确认 | 代码完成 | 工具名校验 + 单测 | `index.ts`, `validate-tools.mjs` | 2026-06-30 |
| 交互 | 不用 slash command | 不注册 `/tokens`；用户在主 agent 直接说“看看 xxx 的 token 消耗” | 已确认 | 代码完成 | 已有单测 | `token report is exposed as a natural-language tool without a slash command` | 2026-06-30 |
| CLI | 员工/脚本入口 | `token-report-cli.mjs --date YYYY-MM-DD` 可输出 token-only 报告 | 已确认 | 已验证 | CLI smoke | `token report CLI prints token-only output` | 2026-06-30 |
| CLI | Codex rollout 回算/修复 | `codex-rollout-token-report.mjs --worker 光彦 --date YYYY-MM-DD` 从 rollout 累计差值回算真实消耗；`--repair-preview` 预览 job patch；`--apply-jobs` 写回匹配的 done job token metadata | 已确认 | 已验证 | 单测 + 光彦 smoke | `codex rollout token report sums...`, `codex rollout token repair...` | 2026-07-06 |

### 当前工具

| 工具/命令 | 用途 |
| --- | --- |
| `factory_token_report` | 主工厂工具，供主 agent 在自然语言询问 token 消耗时自动调用 |
| `token-report-cli.mjs` | 子进程/脚本入口，输出 token 报告 |
| `codex-rollout-token-report.mjs` | 只读读取 `~/.codex/sessions/**/rollout-*.jsonl`，用 `total_token_usage` 累计差值回算 Codex 员工真实消耗并对比当前 job 口径 |

### 使用例子

```text
用户：看看东子的 token 消耗
主 agent：调用 factory_token_report(worker="东子")
```

```bash
node .pi/extensions/ox-factory/token-report-cli.mjs --date 2026-06-30
node .pi/extensions/ox-factory/codex-rollout-token-report.mjs --workers-dir .pi/workers --worker 光彦 --date 2026-07-06
```

---

## OF-025 Web 项目视角 / 定时任务视图

模块整体状态：对齐度 `已确认`；完成度 `已派活给包包`；用例覆盖 `待补 Web smoke`；文档覆盖 `已有专项文档`；检查时间 `2026-07-04`。

### 已确认需求

1. 项目应成为 Web 大盘的一等视角，优先展示 Project Entity，而不是早期 `job.project` 派生活动条。
2. `talk` 是对话模式 / job 标签，不应作为“项目态势”的主体项目。
3. 项目页面要展示 source-of-truth、Todo、Worktree、进展、相关人员和相关 jobs。
4. 定时任务页面要展示 runner / cron / `factory_queue` 的队列流水，并明确 `queue.jsonl` 不是全员工作总账。
5. 第一版只读、手动刷新，不做自动轮询，不做派活/权限/项目写操作。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Overview | Project Entity 优先 | “项目态势”主体来自 `/api/projects.catalog`；`talk` 不占据项目首位 | 已确认 | 待实现 | 待补 Web smoke | OF-025 | 2026-07-04 |
| Projects 页面 | 项目详情 | 展示项目状态、优先级、truth、links、members、todos、worktrees、progress、相关 jobs | 已确认 | 待实现 | 待补 Web smoke | 包包交接文档 | 2026-07-04 |
| Schedules API | 只读队列 | `/api/schedules` 只读汇总 `queue.jsonl` / `history.log`，不写文件 | 已确认 | 待实现 | 待补 API smoke | 包包交接文档 | 2026-07-04 |
| Schedules 页面 | 定时任务展示 | 展示 pending/running/done/failed/stale/repeat、计划时间、循环周期、worker/project/task/summary | 已确认 | 待实现 | 待补 Web smoke | 包包交接文档 | 2026-07-04 |
| 边界 | 不混淆数据源 | 页面文案明确 Project Entity、job.project 标签、queue runner 流水三者差异 | 已确认 | 待实现 | 人工检查 | 包包交接文档 | 2026-07-04 |


---

## OF-020 日报数据视野

模块整体状态：对齐度 `已确认`；完成度 `代码完成-待 reload 验证`；用例覆盖 `已有单测 + CLI smoke`；文档覆盖 `已在总账细化`；检查时间 `2026-06-30`。

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 数据源边界 | queue 不是全局总账 | `queue.jsonl` 只代表 runner/cron/factory_queue 队列流水 | 已确认 | 代码完成 | 已有单测 | `report context treats jobs as primary daily activity...` | 2026-06-30 |
| 多源聚合 | jobs 为主数据源 | 日报上下文聚合 jobs，并把 done 但带 stale/error 的 job 计入产出同时提示风险 | 已确认 | 代码完成 | 已有单测 | `report-context.mjs` | 2026-06-30 |
| 多源聚合 | sessions 作为佐证 | 员工 session 用于 assistant 消息数、工具调用、token/cost 统计 | 已确认 | 代码完成 | 已有单测 | `report context summarizes worker sessions...` | 2026-06-30 |
| 主会话管理动作 | custom/tool call | 当前主 session entries 可进入日报上下文管理动作 | 已确认 | 代码完成 | 已有单测 | `factory_report_context` | 2026-06-30 |
| CLI 入口 | 员工子进程可用 | 子进程可运行 `report-sources.mjs` 获取日报上下文 | 已确认 | 已验证 | CLI smoke | `report-sources CLI prints...` | 2026-06-30 |

---

## OF-021 Codex 代压缩后端

模块整体状态：对齐度 `已确认`；完成度 `后端跑通-shadow 可灰度；主 agent shadow-only 已默认接入`；用例覆盖 `已有单测 + Codex smoke + CLI smoke`；文档覆盖 `已在总账细化`；检查时间 `2026-07-02`。

### 已确认需求

1. 不改 Pi 核心，不直接改真实员工 session。
2. 先验证压缩后端能不能调用 Codex 生成可用摘要。
3. 使用员工 session 的 copy / 只读样本触发 smoke。
4. 第一阶段员工 session 仍 opt-in；主 agent 默认 shadow-only，单独模板、只评估不采纳。
5. 自动 hook 对主 agent 默认 shadow，对员工默认关闭；失败均回退 Pi 默认压缩。
6. 支持 shadow 灰度：Pi 原生压缩保持主链路，Codex 只旁路生成摘要并记录对比。
7. 支持员工名单灰度：通过 `OX_FACTORY_CODEX_COMPACTION_WORKERS` 控制哪些员工参与 shadow/apply。
8. 主 agent 是核心使用场景；默认直接做 shadow 评估，不需要额外环境变量，不采纳 Codex 压缩结果。
9. 主 agent apply 默认拒绝，避免误伤用户主要上下文。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 序列化 | 工具输出截断 | 压缩输入保留 user/assistant/tool call/tool result，超长工具输出带截断标记 | 已确认 | 代码完成 | 已有单测 | `factory compaction prompt keeps worker state...` | 2026-07-02 |
| Prompt | 工厂专用模板 | Codex 摘要包含 Worker State / Active Task / Factory Context / Next Turn Instructions 等结构 | 已确认 | 代码完成 | 已有单测 | `buildFactoryCompactionRequest` | 2026-07-02 |
| 样本准备 | 员工 session copy | CLI 可从员工 session 只读构造 compaction sample，不改真实 session | 已确认 | 代码完成 | 已有单测 + dry-run | `prepareSessionCompactionFixture`, `compaction-smoke.mjs --dry-run` | 2026-07-02 |
| Codex 后端 | app-server smoke | 使用 Codex app-server 对 `测试员` session 样本和 `/tmp/ox-compaction-copy-*/测试员-copy.jsonl` copy 样本生成摘要，输出写到 `/tmp/factory-codex-compaction-smoke.json` / `/tmp/factory-codex-compaction-copy-smoke.json` | 已确认 | 已验证 | Codex smoke | `compaction-smoke.mjs` | 2026-07-02 |
| Hook 安全 | 主 agent 默认 shadow / 员工默认 off | `session_before_compact` 已接入；未显式配置时主 agent 只旁路双跑，员工不触发 Codex；旧开关 `OX_FACTORY_CODEX_COMPACTION=1` 兼容为 `apply`；失败回退 Pi 默认压缩 | 已确认 | 代码完成 | 已有单测 | `index.ts`, `handleFactoryCompactionEvent` | 2026-07-02 |
| Shadow 灰度 | 不替换 Pi 摘要 | `OX_FACTORY_CODEX_COMPACTION_MODE=shadow` 时 `session_before_compact` 返回 `undefined`，Pi 默认压缩继续作为真实结果，Codex 旁路双跑 | 已确认 | 代码完成 | 已有单测 | `shadow compaction runs Codex side channel...` | 2026-07-02 |
| Shadow 落盘 | 对比记录 | Pi 压缩完成后写入 `.pi/workers/compaction-shadow.jsonl`，并保存 `compactions/<id>.pi.md` / `<id>.codex.md` 摘要 copy | 已确认 | 代码完成 | 已有单测 | `handleFactoryCompactionCompleted` | 2026-07-02 |
| 灰度名单 | 指定员工 | `OX_FACTORY_CODEX_COMPACTION_WORKERS` 或测试注入 `workers` 可限制参与员工；未授权员工不触发 Codex | 已确认 | 代码完成 | 已有单测 | `shadow compaction respects worker graylist...` | 2026-07-02 |
| 报告入口 | 工具 + CLI | 用户可问“看看压缩对比”触发 `factory_compaction_report`；CLI 支持 Markdown / JSON，JSON 保留结构化原始字段 | 已确认 | 代码完成 | 已有单测 + CLI smoke | `compaction-report.mjs`, `factory_compaction_report` | 2026-07-02 |
| 主 agent shadow | 默认只评估不采纳 | 无需环境变量即可识别 `~/.pi/agent/sessions/...` 主会话并触发 Codex shadow，记录 `targetType=main` / `worker=主agent`，Pi 摘要仍为真实结果 | 已确认 | 已验证（待真实样本） | 已有单测 + CLI smoke | `main agent shadow compaction is enabled by default...`; `compaction-report.mjs --target main` | 2026-07-02 |
| 主 agent 防误用 | 拒绝 apply | 主 agent scope 下即使误配 `mode=apply`，默认也不调用 Codex、不返回 compaction，只通知应使用 shadow；除非未来显式危险开关 | 已确认 | 代码完成 | 已有单测 | `main agent compaction refuses apply mode...` | 2026-07-02 |

### 当前入口

```bash
node .pi/extensions/ox-factory/compaction-smoke.mjs \
  --session .pi/workers/sessions/测试员.jsonl \
  --worker 测试员 \
  --role tester \
  --keep-recent 4 \
  --max-messages 6 \
  --max-chars 8000 \
  --output /tmp/factory-codex-compaction-smoke.json
```

### Shadow 灰度入口

```bash
# 主 agent：默认 shadow-only，无需额外环境变量；普通 reload / 启动插件加载新代码即可。

# 员工灰度：reload / 启动插件前设置；推荐先只给测试员工或少数长期员工
OX_FACTORY_CODEX_COMPACTION_MODE=shadow
OX_FACTORY_CODEX_COMPACTION_WORKERS=测试员,东子

# 查看最近对比
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --limit 20
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --worker 东子 --json
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --target main
```

### 主 agent 评估当前状态

2026-07-02 已重新验证：

```bash
node --test --test-name-pattern compaction .pi/extensions/ox-factory/test/ox-factory.test.mjs
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --target main --limit 5
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --target main --limit 1 --json
```

验证结果：

- compaction 相关 8 个子测试通过，其中包含 `main agent shadow compaction is enabled by default without env flags`。
- `--target main` CLI 能正常输出 Markdown / JSON。
- 当前 `.pi/workers/compaction-shadow.jsonl` 尚无主 agent 真实 shadow 样本，因此报告为空态；加载新代码后等待主 agent 下一次真实触发 compaction，即会产生可比较记录。

---

## OF-022 本地 Web 可视化工厂驾驶舱

模块整体状态：对齐度 `已确认方向`；完成度 `代码完成-待 reload 验证`；用例覆盖 `静态单测 + Web API 单测`；文档覆盖 `已有专项文档 + 安装/启动文档`；检查时间 `2026-07-06`。

### 已确认需求

1. Web 是本地访问模式，优先服务真实使用，不是对外营销页本身。
2. 东子的对外宣讲 / 落地页可以复用信息架构，但本地 Web 要展示真实工厂数据。
3. 第一版以只读 dashboard 为主，避免绕过主 agent 做高风险写操作。
4. 数据接口复用现有模块，不重复解析散文件。
5. 页面必须区分主 agent 和员工，压缩页要展示“只评估、不采纳”。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 产品范围 | 本地驾驶舱 | Web 定位为本地工厂状态页：Dashboard/Workers/Jobs/日报/Token/压缩/权限 | 已确认方向 | 设计完成 | 不适用 | `docs/ox-factory-web-visualization-plan.md` | 2026-07-02 |
| 任务交接 | 派给八村 | 八村负责 Phase 1 只读 dashboard，派派只 review 不写前端 | 已确认 | 已派活 | 不适用 | `docs/ox-factory-web-frontend-handoff-hachimura.md`, `.pi/workers/messages.jsonl` | 2026-07-02 |
| 数据契约 | 复用模块 | API 复用 `report-context.mjs`、`token-report.mjs`、`jobs.mjs`、`comm.mjs`、`compaction.mjs` | 已确认方向 | 设计完成 | 待补 | `docs/ox-factory-web-visualization-plan.md` | 2026-07-02 |
| 安全边界 | 只读优先 | 第一版不直接派活、不改权限、不 apply 主 agent 压缩；高风险动作回到主 agent 确认 | 已确认方向 | 设计完成 | 待补 | `docs/ox-factory-web-visualization-plan.md` | 2026-07-02 |
| 主 agent | 可视化主会话 | Web 压缩页能按 `target=main` 展示 Pi vs Codex shadow 对比 | 已确认方向 | 依赖 OF-021 已完成数据层 | 已有单测覆盖数据层 | `factory_compaction_report`, `compaction-report.mjs --target main` | 2026-07-02 |
| 启动入口 | `/ox-web` | Pi 内一条指令检查/启动/打开 `127.0.0.1` 本地 dashboard；已运行则复用；支持 status/no-open/自定义端口 | 已确认 | 代码完成 | 静态单测 | `registerCommand("ox-web")`, `ensureOxWebDashboard` | 2026-07-06 |

### 下一步

1. reload 后执行 `/ox-web --status`，确认未启动状态展示正常。
2. 执行 `/ox-web`，确认能启动本地 server 并打开浏览器。
3. 再讨论轻操作入口：复制派活 prompt、跳回主 agent 确认授权。

---

## OF-007/008/009/017 Reload / Job 恢复低风险版

模块整体状态：对齐度 `已确认`；完成度 `代码完成-待 reload 验证`；用例覆盖 `已有单测`；文档覆盖 `已在总账细化`；检查时间 `2026-06-30`。

### 已确认需求

1. reload 时不能再无条件把所有 open job 标为 `stale`。
2. 新启动的 in-process job 要写入 owner 和 heartbeat 元数据，方便 reload 后判断是否还活着。
3. startup recovery 只对没有新鲜 heartbeat 的 open job 做 stale；有新鲜 heartbeat 的 job 保留为 `orphan-running`。
4. 已经进入终态的 job 不应被后续 late event 静默污染；late event 需要显式记为 `late_event_after_terminal`。
5. 先做低风险版本，不重构 queue.jsonl，也不尝试恢复内存队列和 Codex active turn。

### 验收表

| 分类 | 子项/用例 | 预期行为 | 对齐度 | 完成度 | 用例覆盖 | 证据 | 检查时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Heartbeat | 运行中 job 元数据 | `startWorkerJob` 写入 `ownerPid`、`ownerInstanceId`、`ownerStartedAt`、`heartbeatAt`、`heartbeatIntervalMs` | 已确认 | 代码完成 | 静态单测 | `worker jobs write heartbeat metadata...` | 2026-06-30 |
| Startup recovery | 新鲜 heartbeat | `recoverOpenJobsOnStartup` 遇到新鲜 heartbeat 时标为 `orphan-running`，不 stale | 已确认 | 代码完成 | 已有单测 | `recoverOpenJobsOnStartup keeps fresh heartbeat...` | 2026-06-30 |
| Startup recovery | 过期/legacy open job | heartbeat 过期或没有 heartbeat 的 open job 仍标 `stale` | 已确认 | 代码完成 | 已有单测 | `recoverOpenJobsOnStartup stales expired heartbeat...` | 2026-06-30 |
| Late event | stale 后继续写事件 | 终态 job 收到后续 event 时写 `late_event_after_terminal`，不写成普通 text/tool/done | 已确认 | 代码完成 | 已有单测 | `appendJobEventIfOpen records late events...` | 2026-06-30 |
| 插件启动 | 替换粗暴 stale | `session_start` 使用 `recoverOpenJobsOnStartup`，不再直接调用旧的无条件 stale 流程 | 已确认 | 代码完成 | 静态单测 | `startup recovery uses heartbeat-aware recovery...` | 2026-06-30 |
| 兼容性 | 旧函数保留 | `markOpenJobsStale` 保留旧语义，避免影响已有调用和测试 | 已确认 | 代码完成 | 已有单测 | `markOpenJobsStale marks leftover...` | 2026-06-30 |

### 当前状态口径

| 状态 | 含义 |
| --- | --- |
| `running` | 当前实例启动并持有的运行中 job |
| `orphan-running` | reload 后发现 heartbeat 仍新鲜，但当前实例没有内存句柄；可继续观察 event 文件 |
| `stale` | 没有新鲜 heartbeat / legacy open job，认为上次执行链路已失联 |
| `late_event_after_terminal` | event 类型，不是 job 状态；表示终态后到来的 late event 被显式隔离 |

### 暂不做

- 不恢复 `workerJobQueues` 内存队列。
- 不恢复 `talkTarget` / `activeTalkJobId`。
- 不恢复 Codex active turn。
- 不自动 retry stale job。
