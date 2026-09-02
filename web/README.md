# 牛马工厂本地 Web 驾驶舱 · Phase 1

> read-first 的工厂指挥舱：亮色 + 玻璃感 + 状态光点 + 细线网格。**纯只读**，不写权限 / 不派活 / 不 apply 主 agent 压缩 / 不扫全局 session。


## 启动

```bash
# 方式 1：在项目根目录
node .pi/extensions/ox-factory/web-server.mjs

# 方式 2：指定 workers 目录 / 端口
node .pi/extensions/ox-factory/web-server.mjs \
    --workers-dir .pi/workers \
    --port 8787 \
    --host 127.0.0.1
```

访问 `http://127.0.0.1:8787`。

可选项：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--workers-dir, -w` | `.pi/workers`（相对项目根） | 员工数据根目录 |
| `--port, -p` | `8787` | HTTP 端口 |
| `--host, -H` | `127.0.0.1` | 监听地址（**默认仅本机**，避免误开公网） |
| `--help, -h` | — | 显示帮助 |

按 `Ctrl+C` 停止。

## 文件结构

```text
.pi/extensions/ox-factory/
├── web-server.mjs           # Node HTTP server + API 路由 + 静态文件
└── web/
    ├── index.html           # 单页骨架（顶部状态条 + 左侧导航 + 主区 + 抽屉 + Toast）
    ├── app.js               # 原生 JS：hash 路由 + fetch 包装 + 页面渲染
    ├── math-support.js      # 公式分隔符扫描 + KaTeX 安全渲染桥
    ├── vendor/katex/        # 本地 KaTeX 0.18.5、MIT 许可证与 WOFF2 字体
    └── styles.css           # 全部 CSS 变量 + 视觉规范 + 组件样式
```

无运行时 npm 安装依赖，不生成 lockfile；KaTeX 浏览器产物随插件本地提供，服务端仍只使用 Node 内置模块和现有 ox-factory 模块。

## 消息中的数学公式

详细消息正文支持本地 KaTeX 排版：

- 行内公式：单美元分隔符，或反斜杠圆括号分隔符
- 块级公式：双美元分隔符，或反斜杠方括号分隔符
- 行内代码和代码围栏中的公式分隔符不会被渲染
- KaTeX 不可用时自动退化为原始文本；单个错误公式不会阻断整条消息
- KaTeX 使用 trust: false，资源全部从当前 Web 服务加载，不访问第三方 CDN

## 页面

### P0 · Overview（工厂大盘）

首屏回答 7 个问题：工厂健康 / 员工忙闲 / 项目态势 / job 风险 / token 烧在哪 / 最近消息 / 压缩评估。

- 工厂健康徽章（健康 / 注意 / 异常 + 信号源）
- KPI 行：员工（活跃/总数）/ Jobs（今日）/ Stale / Tokens（含缓存）
- **项目态势**：从 `job.project` 派生（无 project 归『未归档』），按最近活动排序，最多 8 个 strip
- Job 状态分布：7 个状态徽章 + 数字（点击预过滤跳 Jobs 页）
- 最近风险：Stale / Orphan / Failed / 压缩失败，按级别排序，最多 8 条
- 今日 Token Top 5：纯 CSS 条形图
- 三列紧凑预览：员工状态 / 最近消息 / 压缩评估

### P0 · Workers

- 左侧员工列表：头像（首字 + 状态色边框）+ 姓名 + 状态点 + 角色 + 简易统计（Jobs / Tok / 未读）
- 右侧员工详情：基本信息（role / backend / model / thinking）+ 职责字段（**空态：数据源未注入**）+ 最近 jobs 表格 + 收件箱/发件通信时间线 + 今日 token

### P0 · Jobs

- 筛选条：状态 chips（多选）/ 员工下拉 / 项目下拉 / 关键词搜索（任务·摘要·ID·员工）/ 时间范围
- 全宽表格：状态徽章 / 短 ID / 员工 / 项目 / 任务（截断 80 字 + tooltip）/ 耗时 / 更新时间
- 点击行 → 右侧抽屉滑入：完整 task + 事件流时间线 + summary / error 全文

### P1 · Tokens

完整 Token 报告：6 个 KPI（输入/缓存/输出/推理/总/含缓存合计）+ 员工明细条形图 + 数据警告。

### P1 · Compactions

顶部固定警告条：「⚠ Codex shadow 压缩只用于评估，不会替换 Pi 真实压缩结果。」
Pi (真实) vs Codex (shadow) side-by-side 摘要对比，按时间倒序，最多 20 条。

### P1 · Messages

按员工选择收件箱，列出全部 / 未读 / 收件 / 发件，区分 IN / OUT。

### P1 · Report

`factory_report_context` 同源 Markdown 文本区。

### P2 · Permissions（只读）

权限矩阵 + 授权记录 + grant/revoke 事件流。

## API 路由

| 路由 | 说明 |
|---|---|
| `GET /api/health` | 健康检查（version, phase, timestamp） |
| `GET /api/overview` | Overview 大盘聚合数据 |
| `GET /api/workers` | 员工列表（含 status / lastJob / tokenToday / unreadMessages） |
| `GET /api/workers/:name` | 员工详情（jobs / inbox / tokenToday） |
| `GET /api/jobs?status=&worker=&project=&search=&date=&limit=` | Job 列表（多维过滤） |
| `GET /api/jobs/:id` | Job 详情 + 最近 100 个事件 |
| `GET /api/report-context?date=&format=json|markdown` | 日报上下文 |
| `GET /api/tokens?date=&worker=&format=json|markdown` | Token 报告 |
| `GET /api/compactions?target=main|worker&worker=&limit=` | 压缩对比（默认 main 优先） |
| `GET /api/permissions` | 权限矩阵 + 事件流 |
| `GET /api/messages?worker=&unreadOnly=&limit=` | 消息收件箱 |
| `GET /api/projects` | 项目视角（从 job.project 聚合） |
| `GET /api/responsibilities?worker=` | 员工当前职责 / 负责项目 |

所有路由均为 **GET only**；不允许任何写操作。

## 数据来源

完全复用现有模块，不重新发明解析：

- `jobs.mjs` — job CRUD + 事件流
- `comm.mjs` — 权限 / 消息
- `token-report.mjs` — Token 报告（session 优先，job 兜底）
- `report-context.mjs` — 日报上下文
- `compaction.mjs` — Codex shadow 压缩记录读取
- `responsibilities.mjs` — 员工当前职责 / 负责项目

## 视觉规范

**基调**：Command Center / War Room（亮色，可读，克制，炫酷）

- 主色 / 状态色 / 间距 / 圆角 / 阴影 / 字体 / 动效 — 全部走 CSS 变量
- 玻璃感卡片（`backdrop-filter: blur` + 半透明白底）
- 细线网格（`body::before` 32px 网格层）
- 状态光点（`pulse` 动画）
- 浅渐变背景（暖灰 + 蓝 + 橙三色 radial）
- 弹性动效（`cubic-bezier(0.34, 1.56, 0.64, 1)` 抽屉）

**硬编码颜色**：`grep -nE '#[0-9a-fA-F]{6}' web/styles.css` 排除变量定义后 = **0**

## 边界（明确禁止）

- ❌ 直接写权限文件
- ❌ 直接派活
- ❌ 直接修改 worker registry
- ❌ 直接 apply Codex 主 agent 压缩
- ❌ 扫描 `~/.pi/agent/sessions` 全局目录
- ❌ 引入 npm 依赖 / 生成 lockfile
- ❌ 任何 POST/PUT/DELETE 路由

## 范围外（Phase 1 不做）

- 主题切换（已留 CSS 变量位）
- 实时 SSE / WebSocket 推送（仅手动 ↻ 刷新）
- 移动端深度优化（基础响应式已做）
- 飞书审批联动
- Web → 主 agent 协调写操作（`联系员工` UI 入口预留，但点击提示「需主 agent 协调」）

## 验收清单

- [x] `node .pi/extensions/ox-factory/web-server.mjs --port 8787` 一行启动
- [x] `curl http://127.0.0.1:8787/api/health` 返回 `ok: true`
- [x] Overview / Workers / Jobs P0 三页可用，P1/P2 入口存在
- [x] Workers 详情含收件箱/发件时间线
- [x] Jobs 详情抽屉含事件流时间线
- [x] Compactions 页顶部固定 shadow-only 警告条
- [x] 项目态势 strip 来自 `job.project` 聚合
- [x] 任意单 API 失败 → 该模块独立错误态，其他模块不受影响
- [x] 移动状态色 / 主交互色 / 背景色 / 字体 全部走 CSS 变量
- [x] `grep` 硬编码颜色 = 0
- [x] 不引入 npm 依赖、不生成 lockfile
- [x] 不执行任何高风险写操作
- [x] 不扫描 `~/.pi/agent/sessions` 全局目录
- [x] 主 agent 压缩明确为 shadow-only，不替换 Pi 真实结果

## API Smoke 输出

```text
GET /api/health                            HTTP 200
GET /api/overview                          HTTP 200  (15 workers, 278 jobs, 7 risks, 8 projects)
GET /api/workers                           HTTP 200
GET /api/workers/Alice                      HTTP 200  (4 jobs, 6 inbox, tokenToday=1.42M)
GET /api/jobs?limit=5&status=done          HTTP 200
GET /api/jobs/20260702065930-_-s0kxkl      HTTP 200  (100 events)
GET /api/projects                          HTTP 200
GET /api/permissions                       HTTP 200
GET /api/tokens                            HTTP 200  (13 workers)
GET /api/compactions?target=main&limit=20  HTTP 200  (0 records, no compactions yet)
GET /api/messages?worker=主agent            HTTP 200
GET /api/report-context?format=markdown    HTTP 200  (text/markdown)
GET /api/responsibilities                  HTTP 200  (empty until factory_responsibility_set is called)
GET /                                       HTTP 200  text/html
GET /app.js                                HTTP 200  application/javascript
GET /styles.css                            HTTP 200  text/css
GET /api/jobs/notexist                     HTTP 404
GET /api/messages                          HTTP 400  (worker required)
```

## 已知空态（registry / 数据源未提供）

- **role / backend / model / thinking** — 这些字段当前在 Pi 进程内存的 `registry.ts` 中，文件层未提供（registry snapshot 未提供）；前端显示「— (registry snapshot 未提供)」。Phase 2 可考虑在 web-server 启动时从 main session 投影 registry 到文件。
- **职责字段** — 来自 `.pi/workers/responsibilities.jsonl`，可由主 agent 通过 `factory_responsibility_set` 设定；无记录时前端显示「暂未提供，可以让主 agent 用 factory_responsibility_set 设定」。
- **Codex 主 agent 压缩** — 当前 `.pi/workers/compaction-shadow.jsonl` 为空（codex 后端可能未触发）；页面上 Compactions 入口会显示空态「暂无主 agent 压缩记录」。

## 数据刷新机制（重要）

**不是 realtime push**。Web 仪表舱采用 **request-time read** 模式：

- 没有 SSE / WebSocket / 轮询。
- 所有 API 都是 `fetch(..., { cache: "no-store" })`。
- web-server 每次收到 GET 请求都重新读 jobs/messages/token/report/compaction/responsibilities 等文件，并立即返回最新结果。
- Token 由 `buildFactoryTokenReport()` 每次请求聚合；只要底层 session/job usage 写入了，下一次请求就能看到新值。

**用户触发刷新的 3 种方式**：

1. **顶部 ↻ 刷新按钮** — 永远刷新当前页面主体 + topbar，保留当前 hash / query / filter。点击后有「已刷新」toast 提示。
2. **浏览器整页刷新**（F5 / Cmd+R）— 完全重载；当前 hash route 对应页面数据会刷新。
3. **切换 hash route** — 重新 fetch 对应页面数据；Worker 详情 / Job 抽屉会按需重新加载。

**Phase 1 范围外**：自动轮询 / 30s auto-refresh。如果后续要加，建议作为可关闭开关，默认关闭，避免对本地文件 I/O 造成压力。

**Worker 卡片「消息 N」说明**：当前 `/api/workers` 返回的 `unreadMessages` 字段，实际语义是「主 agent 收件箱中 to=该员工 的消息数」，并不是 per-worker 真正的未读数。Phase 1 文案已改为「消息 N」以避免误导；Phase 2 计划做完整的 per-worker inbox 聚合函数。

## Review 重点

Release review 时建议关注：

1. **是不是"工厂大盘"** — Overview 7 大块信息是否回答"工厂现在怎么样"
2. **有没有 agent 对话/消息视角** — Overview 消息预览 + Workers 详情收件箱/发件
3. **有没有项目视角** — Overview 项目态势 strip
4. **视觉是否现代 War Room** — 玻璃感 + 浅渐变 + 状态光点 + 细线网格 + 状态色
5. **是否复用现有模块** — grep `import` 全是相对路径的 `.mjs`
6. **是否做了危险写操作** — `grep "POST\|PUT\|DELETE" web-server.mjs` = 0
7. **主 agent 压缩是否明确是 shadow-only** — Compactions 页顶部警告条 + API note 字段
