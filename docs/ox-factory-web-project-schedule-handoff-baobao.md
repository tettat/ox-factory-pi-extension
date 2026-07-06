# 包包任务交接：Web 项目视角与定时任务视图优化

> 日期：2026-07-04  
> 发起：派派  
> 接手建议：包包  
> 范围：`.pi/extensions/ox-factory` 本地 Web 驾驶舱，只读优先；不要改 `/talk` 控制台实时输出主链路。

## 1. 背景

牛马工厂已经补了轻量 Project Entity：

- 数据：`.pi/workers/projects.jsonl`
- 读写模块：`projects.mjs`
- 主 agent 工具：`factory_project_upsert/list/todo_set/worktree_set/progress_add/member_set`
- Web 后端：`GET /api/projects` 已同时返回：
  - `catalog`：真正的一等 Project Entity。
  - `projects`：从历史 job 的 `job.project` 派生出来的活动条。

但当前 Web 页面仍主要沿用早期“从 `job.project` 聚合”的展示。用户反馈：

1. 现在大盘里 `talk` 被当成一个项目，这其实只是对话模式 / 默认 job project，不应占据“项目态势”的主体。
2. 已经有 Project Entity，但 Web 还没有真正把它做成一等展示。
3. 定时任务 / cron / runner 队列目前只有 `factory_check` 文本输出，Web 没有可视化页面。
4. 八村当前页面完成度不错，但后续项目视角和定时任务视图压力较大，需要包包辅助推进。

## 2. 当前代码事实

### 2.1 项目数据

相关文件：

- `projects.mjs`
- `web-server.mjs`
- `web/app.js`
- `web/styles.css`
- `.pi/workers/projects.jsonl`

当前接口：

```text
GET /api/projects
```

当前字段：

```js
{
  generatedAt,
  projects,      // 从 jobs 的 job.project 派生的活动条，最多 8 个
  catalogTotal,  // Project Entity 数量
  catalog,       // 从 projects.jsonl 回放出来的项目实体
  note
}
```

当前 8787 本地服务观测到：

```text
/api/projects.catalogTotal = 7
/api/projects.projects = 8
/api/projects.projects 前几项 = talk, ox-factory-showcase, pi-agent-research, ...
/api/projects.catalog 前几项 = capital-pie, nextact-client, dev-machine, ox-factory-share, bes-deploy, ox-factory, ox-factory-project-entity
```

结论：后端已经把真项目给出来了，但 Overview 仍用派生项目活动条。

### 2.2 Overview 项目态势

`web-server.mjs` 的 `handleOverview()` 当前返回：

```js
projects: buildProjectStrips(workersDir)
```

`buildProjectStrips()` 当前逻辑：

```js
const name = job.project || "未归档";
```

`web/app.js` 当前 Overview 文案：

```text
项目态势：从 job.project 派生视角；无 project 归『未归档』
```

这就是 `talk` 这类 job project 被展示成“项目”的原因。

### 2.3 定时任务数据

相关文件：

- `.pi/workers/queue.jsonl`
- `.pi/workers/history.log`
- `index.ts` 里的 `factory_queue` / `factory_check`
- `web-server.mjs` 里已有 `readQueueFile()` helper，但没有独立 `/api/schedules`。

当前语义：

- `queue.jsonl` 只代表 runner / cron / factory_queue 队列流水，不是全局工作总账。
- 即时一次性任务很多走 in-process jobs：`.pi/workers/jobs/*.json`。
- 定时 / 循环任务才更适合从 `queue.jsonl`、`history.log` 看。

因此 Web 上需要把“Jobs”和“Schedules / Runner 队列”明确分开，避免又让用户误以为 queue 是全员产出总账。

## 3. 建议产品形态

### 3.1 Overview：项目态势改成 Project Entity 优先

目标：用户打开 Overview 先看到真正的项目，而不是 `talk`。

建议：

1. Overview 项目态势优先展示 `catalog` 中的 Project Entity。
2. 每个项目卡片展示：
   - 项目名 / ID
   - 状态：active / paused / done / archived
   - 优先级：P0/P1/P2
   - owner / lead / contributors（来自 `members`）
   - Todo 概览：todo / doing / done / blocked 数量
   - 最近进展：`progress[0]` 或最新一条
   - Worktree 数量和状态
   - Source of Truth：`truth.type + truth.ref`
3. 派生 job project 只作为“活动归档 / job 标签热度”辅助区，不再叫主项目态势。
4. 对 `talk` 做语义降级：
   - 可以展示在“对话 / 临时咨询活动”里；
   - 不应该作为“项目态势”首位。

### 3.2 Project 页面：新建一级导航

建议在左侧导航增加：

```text
Projects
```

页面结构：

1. 顶部项目总览：项目总数、active 数、blocked todo 数、最近更新时间。
2. 左侧或上方项目列表：按优先级和更新时间排序。
3. 项目详情卡：
   - Summary
   - Source of Truth
   - Links
   - Members
   - Todos
   - Worktrees
   - Progress timeline
4. 最近相关 Jobs：
   - 用项目 `id/name/aliases` 去匹配 `job.project`。
   - 未匹配的只放辅助区，避免混淆。

第一版可以只读，不做新增/编辑按钮。

### 3.3 Schedules 页面：展示定时 / runner 队列

建议在左侧导航增加：

```text
Schedules
```

推荐后端接口：

```text
GET /api/schedules
```

返回建议：

```js
{
  generatedAt,
  total,
  pending,
  running,
  done,
  failed,
  stale,
  repeat,
  entries: [
    {
      id,              // 若 queue entry 没有 id，可用 index/hash 派生稳定展示 id
      status,
      worker,
      project,
      taskPreview,
      scheduled,
      repeat,
      mode,
      cwd,
      time,
      elapsed,
      exitCode,
      summary,
      error,
      source: "queue.jsonl" | "history.log"
    }
  ],
  note: "queue.jsonl 只代表 runner/cron/factory_queue 队列，不代表全员工作总账"
}
```

页面展示建议：

1. 顶部 KPI：pending / running / failed / repeat 数。
2. 表格列：状态、员工、项目、计划时间、循环周期、最近执行、任务摘要、结果摘要。
3. 对 repeat 任务展示“循环任务”标识。
4. 失败 / stale 高亮，点击展开完整 task/summary/error。
5. 页面文案明确：这是 runner/cron 队列，不是全员产出统计。

### 3.4 刷新方式

当前页面已有手动刷新按钮：

- `web/index.html`：`#refreshBtn`
- `web/app.js`：`refreshCurrent()` 每次重新请求当前页面数据和 topbar。

第一版继续保持手动刷新即可，不建议加自动轮询。后续如果要自动刷新：

- 默认关闭；
- 用户显式开启；
- 间隔不小于 15-30 秒；
- 只刷新轻量接口。

## 4. 实现边界

包包接手时请遵守：

1. 只做本地 Web / 只读 API，不做派活、权限写入、项目写入。
2. 不改 `/talk`、`flushTalkLive`、`pi.sendMessage` 主链路。
3. 不 revert 八村已有页面改动，基于现有 `web/app.js`/`styles.css` 增量改。
4. 不引入 npm 依赖、不生成 lockfile。
5. 后端新增接口时复用现有 helpers：`readQueueFile()`、`safeReadJsonl()`、`listStoredProjects()`、`listJobs()`。
6. 文案必须区分：
   - Project Entity = 真项目。
   - job.project = job 标签 / 旧活动归档。
   - queue.jsonl = runner/cron 队列流水。

## 5. 最小落地路径

建议按三步做：

### Step A：Project 页面只读 MVP

- `web/index.html` 增加 Projects 导航。
- `web/app.js` 增加 `renderProjects()` route。
- 读取 `/api/projects` 的 `catalog`。
- 项目详情先全部在前端渲染，不需要新 API。
- Overview 项目态势优先改用 `catalog`，辅助保留派生 activity strips。

### Step B：Schedules 后端接口

- `web-server.mjs` 新增 `handleSchedules()`。
- route：`/api/schedules`。
- 只读 `queue.jsonl` + 可选 `history.log`。
- 先给最近 200 条，避免大文件撑爆。

### Step C：Schedules 页面

- `web/index.html` 增加 Schedules 导航。
- `web/app.js` 增加 `renderSchedules()`。
- 列表 + 状态筛选 + 展开详情即可。

## 6. 验收标准

1. `GET /api/projects` 仍兼容旧字段；JSON 结构不破坏。
2. `GET /api/schedules` 返回 200，且不写任何文件。
3. Overview 不再把 `talk` 作为“项目态势”的主体首位。
4. Projects 页面能看到 `ox-factory`、`capital-pie`、`nextact-client` 等 Project Entity。
5. Schedules 页面能看到小绿“履历整理”这类历史 runner/cron 记录。
6. 手动刷新按钮能刷新 Projects / Schedules 当前页面。
7. `npm test` 或现有 `npm test -- --runInBand`（按项目实际脚本）通过；至少跑 `npm test` + Web API smoke。

## 7. 给包包的直接任务摘要

包包，你先按这个文档实现 Web 大盘的项目视角和定时任务视图。优先做只读，不要碰 `/talk` 控制台输出。核心目标：

- Overview 的“项目态势”使用 Project Entity，不再被 `talk` 这种 job 标签主导。
- 新增 Projects 页面，展示项目 source-of-truth、Todo、成员、worktree、进展。
- 新增 Schedules 页面，展示 `queue.jsonl` / runner / cron 的定时任务流水。
- 保持手动刷新即可；不要自动轮询。
- 完工后把改动说明、验证命令、API smoke 发给派派 review。
