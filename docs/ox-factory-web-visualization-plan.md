# 牛马工厂本地 Web 可视化模式规划

更新时间：2026-07-02

## 背景

牛马工厂目前主要通过 Pi 插件工具、JSONL 文件和主 agent 对话来管理员工、任务、日报、token、通信权限和压缩评估。随着员工和功能变多，单靠对话查询会变得不直观：用户不知道谁在干什么、哪些 job 卡住了、今天产出在哪里、主 agent / 员工压缩是否可靠。

东子正在整理对外宣讲 / 落地页，适合把“对外讲清楚的产品能力”和“本地可操作的工厂控制台”并行推进：对外页负责讲价值，本地 Web 负责真实使用。

## 产品定位

第一版 Web 不是替代 Pi 主 agent，而是一个本地只读/轻操作的“工厂驾驶舱”：

- 主 agent 仍负责自然语言决策、调度和复杂操作。
- Web 负责把工厂状态可视化，让用户快速看见全局。
- 涉及派活、授权、删除、apply 压缩等高风险动作，第一版默认不直接执行，或必须回到主 agent 确认。

## MVP 页面

### 1. 总览 Dashboard

目的：打开本地 URL 后 10 秒内知道工厂是否健康。

展示：

- 当前员工数量、在线/忙碌/空闲/异常状态。
- 今日完成 job、运行中 job、stale/error job。
- 今日 token 消耗 Top N。
- 今日主要产出摘要：来自 `factory_report_context` 的多源上下文。
- 最近风险：stale job、late event、Codex usage 缺失、压缩失败。

数据源：

- `.pi/workers/profiles.json`
- `.pi/workers/jobs/*.json`
- `.pi/workers/events/*.jsonl`
- `.pi/workers/queue.jsonl`
- `.pi/workers/sessions/*.jsonl`
- 当前主 session 的 `ctx.sessionManager.getEntries()` 投影（运行时注入）

### 2. 员工看板 Workers

目的：回答“谁负责什么、现在在干什么、最近产出什么”。

展示：

- 员工卡片：姓名、岗位、backend/model/thinking、状态。
- 负责项目 / 职责字段：后续来自 OF-001 `Responsibility`。
- 最近 job 和最近 session 活动。
- token 今日/近 7 日趋势。
- 通信权限摘要：谁可以联系谁、谁可以广播。

第一版动作：

- 只读详情。
- “复制派活提示词”或“让主 agent 给他派活”的入口，先不直接自动派 job。

### 3. 任务 / Job 时间线

目的：替代散看 jobs/events/queue。

展示：

- job 列表：pending/running/orphan-running/done/stale/error。
- job 详情：事件流、工具调用、最终产出、错误原因。
- runner 队列任务和 in-process job 合并展示。
- reload 恢复状态：heartbeat、新鲜度、late event 标记。

数据源：

- `factory_jobs`
- `readJobEventsSince` / `.pi/workers/events/*.jsonl`
- `.pi/workers/queue.jsonl`

### 4. 日报 / 产出页

目的：让布朗尼写日报前看到正确上下文，也让用户能人工复核。

展示：

- 今日工厂总览。
- 每个员工的产出和证据链接。
- 管理动作：招聘、配置、授权、note、transfer。
- 风险和明日计划。

数据源：

- `factory_report_context`
- `report-sources.mjs`

### 5. Token / 成本观察页

目的：看投入，不在第一版算钱。

展示：

- input / cached input / output / reasoning output / provider total / total including cache。
- Pi 后端与 Codex 后端分组。
- session 优先、job 兜底的来源标识。
- 哪些 job 缺 usage。

数据源：

- `factory_token_report`
- `token-report-cli.mjs`

### 6. 压缩评估页

目的：重点服务主 agent 压缩质量评估。

展示：

- 主 agent / 员工的 Pi vs Codex shadow 压缩对比。
- 摘要长度、估算 token、Codex 耗时、结构命中。
- Pi 摘要和 Codex 摘要 side-by-side。
- 标记“只评估，不采纳”。

数据源：

- `.pi/workers/compaction-shadow.jsonl`
- `.pi/workers/compactions/*.pi.md`
- `.pi/workers/compactions/*.codex.md`
- `factory_compaction_report`

### 7. 工厂配置 / 权限页

目的：把授权式通信可视化，但不让员工越权互相派活。

展示：

- 当前权限矩阵：subject / action / target。
- 消息收件箱：未读、已读、广播。
- 审计日志。

第一版动作：

- 可先只读。
- 后续再接“通过主 agent 发起授权变更”。

## 本地 Web 模式架构建议

### 启动方式

建议新增一个本地 server，而不是先上云：

```bash
node .pi/extensions/ox-factory/web-server.mjs --workers-dir .pi/workers --port 8787
```

访问：

```text
http://127.0.0.1:8787
```

### 后端接口

第一版用 Node 原生 HTTP 或轻量框架均可，重点是接口稳定：

- `GET /api/health`
- `GET /api/overview`
- `GET /api/workers`
- `GET /api/jobs?status=&worker=&limit=`
- `GET /api/jobs/:id`
- `GET /api/report-context?date=`
- `GET /api/tokens?date=&worker=`
- `GET /api/compactions?target=main|worker&worker=&limit=`
- `GET /api/permissions`
- `GET /api/messages?worker=&unreadOnly=`

接口应复用现有模块：`report-context.mjs`、`token-report.mjs`、`jobs.mjs`、`comm.mjs`、`compaction.mjs`，不要让 Web 直接重复解析所有散文件。

### 前端形态

MVP 可以先做一个静态 HTML + JS：

```text
.pi/extensions/ox-factory/web/
  index.html
  app.js
  styles.css
```

后续如果复杂，再升级到 Vite/Vue。第一版不建议引入大框架，避免插件发布体积和构建复杂度上升。

## 与东子对外宣讲的关系

东子的对外宣讲 / 落地页适合讲这几件事：

1. 牛马工厂是“本地 AI 员工操作系统”。
2. 主 agent 是用户代理，员工是可配置角色。
3. 工厂有审计、日报、token、权限和恢复机制，不是普通多 agent demo。
4. Web 可视化让老板视角可见：谁在工作、产出在哪、哪里有风险。

本地 Web 页面则展示真实数据，不负责营销夸张表达。两者可以共用信息架构，但文案口径分开：

- 对外页：价值表达、截图、流程图、能力清单。
- 本地 Web：状态、证据、操作入口、风险提示。

## 分阶段路线

### Phase 0：文档和数据契约

- 固定 Dashboard 页面范围。
- 固定 API 列表和返回字段。
- 明确哪些动作只读、哪些动作需要主 agent 确认。

### Phase 1：只读本地 Dashboard

- 本地 server。
- Overview / Workers / Jobs / Report / Tokens / Compactions 六个只读页。
- 不做写操作。

### Phase 2：轻操作

- 消息标已读。
- 复制派活 prompt。
- 通过主 agent 生成授权/派活建议，但不直接执行。

### Phase 3：受控写操作

- 权限变更。
- 派活。
- 重新运行失败 job。
- 这些都需要明确授权日志，后续再接飞书审批。

## 风险和约束

- Web 不能自己绕过权限直接写入高风险文件。
- 不能只读 `queue.jsonl`，必须复用多源聚合，避免日报误判重演。
- 主 agent session 在 `~/.pi/agent/sessions/...`，Web 第一版不应直接扫描全局目录；主 session 数据应由插件运行时提供或通过明确路径只读。
- runtime 数据和插件源码都在 `.pi`，后续发布商业插件前需要重新规划数据目录边界。

## 第一批验收标准

1. 本地能打开 `http://127.0.0.1:<port>`。
2. Dashboard 能展示员工、job、日报上下文、token、压缩对比五类数据。
3. 页面能区分“主 agent”和“员工”。
4. 压缩页明确展示“Codex shadow 只评估，不采纳”。
5. 所有 API 都有 CLI/单测覆盖的数据来源，不重复发明解析逻辑。
