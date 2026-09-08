# 工厂能否脱离 Pi：当前代码核查

日期：2026-09-08；核查 main@afec2e7。结论：**员工执行不必用 Pi，但正式员工的工厂调度目前仍依赖 Pi 宿主。不能只关掉 Pi 保留 Web，就认定功能完整。**

## 当前事实
| 能力 | 现状 | 依据 |
|---|---|---|
| Web 页面、查询与本地数据 API | 已可作为独立 Node 服务启动 | web-server.mjs main/buildRouter |
| 文件权限、消息、任务事件账本 | 核心函数无需 Pi session | comm.mjs / task-requests.mjs |
| 看板到期检查 | Web 自己启动 scheduler，但通常只创建 worker-task request | web-server.mjs createFactoryTaskScheduler；task-dispatcher.mjs |
| Codex/Claude/Kimi 员工执行适配 | 独立后端模块已有；不等于独立调度完成 | spawner.ts 与 *-backend.mjs |
| 外包独立执行 | detached 子进程链路已有；Pi profile 仍需要 Pi 可执行文件 | outsource-dispatcher.mjs、outsource-worker.mjs、outsource-runner.mjs |
| 正式员工 Web 对话、派活与控制队列 | poller 和队列仍在 Pi 插件中，session_start 时启动 | index.ts ensureWebTalkPoller/ensureWorkerTaskPoller/startWorkerJobQueued |
| 主 agent 对话 | 仍直接调用 pi.sendUserMessage | index.ts drainMainAgentTalkRequests |
| 员工注册与恢复 | 已有文件侧记录，但还使用主 session entries 恢复，不能当成完全独立 | registry.ts setPi/appendEntry；index.ts restoreFromEntries |
| 工厂工具入口 | factory_* 注册在 Pi ExtensionAPI；CLI 覆盖部分能力，不是全部替代 | index.ts pi.registerTool |
| Pi 压缩 hooks | 本质上是 Pi 专属能力，其他后端需各自观测适配 | index.ts session_before_compact/session_compact |

## 推荐拆法：把 Pi 从“宿主”降为“可选后端/适配器”

Web / CLI / Agent工具 → 同一 Factory Service → 队列与恢复 → Codex / Claude / Kimi / Pi / 后续直连API。

第一阶段不必重写 UI、不必立即换数据库：
1. 提取 runtime 初始化、worker registry 持久化、任务队列、控制命令、回调与恢复为独立服务。
2. 单独 factory-server 入口同时启动 Web 和 runtime；Pi 插件只调用这个服务，不再拥有第二套队列。
3. 一个 workersDir 只能有一个调度 owner，设置所有权/心跳与接管边界，避免 Pi 与新服务同时派同一任务。
4. 所有入口统一走服务权限校验。不要让 Web、CLI 和工具各自实现一份授权逻辑。
5. 第一位管理员 agent 就是普通员工加权限，不再要求存在一个 Pi 主 session。
6. Pi 压缩等专属观测按后端能力展示“不适用”，不伪造跨后端等价指标。

## 必须先验收的闭环
在临时 workersDir、未运行 Pi 宿主的环境：招募 Codex 员工 → Web 对话 → 忙时排队 → 取消/steer → 到时派活 → 回传结果 → 权限审批后继续 → 服务重启恢复且不重复执行。再加入 Claude/Kimi/Pi 等后端矩阵。

当前只分析，没有关闭 Pi、重构 runtime 或更改生产启动方式。建议作为独立功能分支推进，不与手绘皮肤和排版绑定。
