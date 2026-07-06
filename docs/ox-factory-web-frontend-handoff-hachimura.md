# 八村任务交接：牛马工厂本地 Web 可视化实现

负责人：八村  
带教 / Reviewer：派派  
日期：2026-07-02  
状态：已派活，待实现  

## 任务目标

实现牛马工厂第一版本地 Web 可视化页面，让用户可以通过本地浏览器查看工厂状态。

第一版定位是**只读驾驶舱**，不要做高风险写操作：不直接派活、不直接改权限、不直接替换主 agent 压缩结果。

详细产品规划见：

```text
docs/ox-factory-web-visualization-plan.md
```

## 你要交付什么

优先交付 Phase 1：本地只读 Web dashboard。

建议启动方式：

```bash
node .pi/extensions/ox-factory/web-server.mjs --workers-dir .pi/workers --port 8787
```

浏览器访问：

```text
http://127.0.0.1:8787
```

## 页面范围

### P0：总览 Dashboard

必须展示：

- 员工数量和基本状态。
- job 状态统计：pending / running / orphan-running / done / stale / error。
- 今日 token 总览。
- 今日产出摘要入口。
- 最近风险：stale job、late event、Codex usage 缺失、压缩失败。

### P0：员工看板 Workers

必须展示：

- 员工姓名、岗位、backend、model、thinking、status。
- 最近 job / 最近活动。
- 今日 token 简要统计。
- 职责字段如果当前数据源没有，先显示为空态 / coming soon，不要硬编码假数据。

### P0：任务 / Job 页面

必须展示：

- job 列表。
- 状态、worker、project、createdAt/startedAt/finishedAt。
- 点击/展开后显示事件摘要和最终结果。

### P1：日报 / 产出页

展示 `factory_report_context` 同源数据。第一版可以先做 Markdown 文本区。

### P1：Token 页

展示 `factory_token_report` 同源数据。保留 K/M 紧凑显示即可。

### P1：压缩评估页

展示 Pi vs Codex shadow 压缩对比，尤其要支持主 agent：

```bash
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --target main
```

页面上必须明确写：

```text
Codex shadow 压缩只用于评估，不会替换 Pi 真实压缩结果。
```

### P2：权限 / 消息页

第一版只读：

- 权限矩阵。
- 消息列表。
- 审计记录。

## 建议文件结构

可以按下面结构实现：

```text
.pi/extensions/ox-factory/web-server.mjs
.pi/extensions/ox-factory/web/index.html
.pi/extensions/ox-factory/web/app.js
.pi/extensions/ox-factory/web/styles.css
```

第一版优先原生 HTML/CSS/JS，不急着引入 Vue/Vite。目标是插件内可维护、reload 风险低、启动简单。

## 后端 API 建议

Web server 尽量复用已有模块，不要在前端重复乱扫 JSONL。

建议接口：

```text
GET /api/health
GET /api/overview
GET /api/workers
GET /api/jobs?status=&worker=&limit=
GET /api/jobs/:id
GET /api/report-context?date=
GET /api/tokens?date=&worker=
GET /api/compactions?target=main|worker&worker=&limit=
GET /api/permissions
GET /api/messages?worker=&unreadOnly=
```

优先复用：

```text
.pi/extensions/ox-factory/jobs.mjs
.pi/extensions/ox-factory/report-context.mjs
.pi/extensions/ox-factory/token-report.mjs
.pi/extensions/ox-factory/compaction.mjs
.pi/extensions/ox-factory/comm.mjs
```

不要复制一套新的解析逻辑。

## 视觉要求

参考东子对外宣讲 / 落地页方向，但本地 Web 不要太营销化。它是操作台，不是海报。

风格建议：

- 亮色底。
- 清晰分区。
- 卡片 + 表格 + 时间线组合。
- 首屏先回答“工厂现在怎么样”。
- 状态颜色统一：running 蓝、done 绿、stale 橙、error 红、idle 灰。
- 不要把页面做成复杂炫技图，第一版以可读和可维护为主。

## 安全边界

第一版禁止：

- 直接写权限。
- 直接派活。
- 直接修改 worker registry。
- 直接 apply Codex 主 agent 压缩。
- 扫描 `~/.pi/agent/sessions` 全目录。

主 agent 数据如果要展示，只展示插件已经投影/记录的数据，例如 `compaction-shadow.jsonl` 中的 `targetType=main`。

## 验收标准

实现后至少满足：

1. 本地 server 能启动，无需额外复杂构建。
2. `http://127.0.0.1:8787` 能打开页面。
3. Dashboard 能展示 workers / jobs / token / report / compaction 的真实数据或明确空态。
4. 压缩页能区分 `targetType=main` 和 `targetType=worker`。
5. 页面不执行任何高风险写操作。
6. 有最小 smoke 测试：
   - server 启动。
   - `/api/health` 返回 ok。
   - 关键 API 返回 JSON。
7. 不引入 npm lockfile，不引入不必要大依赖。

## 建议实施顺序

1. 先实现 `web-server.mjs` 和 `/api/health`。
2. 实现静态文件服务。
3. 实现 `/api/overview`。
4. 做 Dashboard 首屏。
5. 增加 Jobs 和 Workers 页。
6. 接 Token / Report / Compaction。
7. 最后做样式 polish。

## 派派 review 重点

派派后续会重点 review：

- 有没有复用已有数据模块。
- 有没有偷偷做高风险写操作。
- 主 agent 压缩是否明确是 shadow-only。
- 页面是否能稳定启动。
- reload 后是否会影响 Pi 插件主流程。

## 派派补充反馈：从“只读后台”升级为“工厂大盘”

更新时间：2026-07-02

八村提交第一版设计方案后，派派给出以下补充要求。Phase 1 仍然以安全为先，不直接做改权限、派活、apply 压缩等高风险写操作；但产品定位需要从“纯只读报表”升级为 **read-first 的工厂指挥舱 / 工厂大盘**。

### 信息架构拍板

- 使用「左侧导航 + 顶部状态条」，不要改成顶部 tab。
- P0 优先把 Overview 做成真正的大盘，同时脚手架出 Workers / Jobs 的基础可用版本。
- Overview 可以露出 Token / Compaction / Messages 的紧凑预览卡，完整页可以先 Coming soon。
- 空态文案建议使用：`暂无记录。可以让主 agent 派活，或等待员工产生事件。`

### Phase 1 需要提前体现的视角

#### Agent 消息 / 对话视角

- Overview 展示最近消息流、未读消息数、需要老板关注的消息。
- Workers 详情展示该员工的收件箱、发件和最近通信时间线。
- 可以先不实现真正发送，但 UI 要预留「联系员工」入口。
- 如果实现发送，必须是受控轻操作：显式确认、调用现有 `comm.mjs` 能力、保留权限边界和审计记录。
- 页面上需要避免误导：写 inbox 不等于员工一定马上开始干活；真正执行任务仍要走 dispatch / talk / 后续主 agent 协调机制。

#### 项目视角

- 当前工厂只有人员视角，不够像“大盘”。第一版即使没有正式 Project Store，也要从现有 job 的 `project` 字段 / 任务文本中派生项目视角。
- Overview 增加「项目态势」区域，展示项目名、参与员工、running/done/error/stale 数量、最近更新时间和最近产出摘要。
- 不允许硬编码假项目；无法归类时放入 `未归档`。

#### 现代视觉

- 视觉要比普通后台更有“Command Center / War Room”质感。
- 保持亮色、可读、克制，但可以使用浅渐变背景、玻璃感卡片、状态光点、细线网格、指标大数字、mini chart、时间线等元素。
- 状态色和所有色值仍必须走 CSS variables。
- 目标是“现代、克制、炫酷”，不是营销海报，也不能牺牲可读性。

### 调整后的优先级

1. P0A：Overview 工厂大盘（健康、项目态势、员工状态、job 风险、token 预览、消息预览）。
2. P0B：Jobs 列表 + 详情抽屉。
3. P0C：Workers 列表 + 员工详情 + 消息时间线。
4. P0D：只读 API 和 smoke 测试。
5. P1：安全发送消息（显式确认）/ Token 完整页 / Compaction 完整页。
6. P2：权限矩阵写操作、派活、飞书审批。
