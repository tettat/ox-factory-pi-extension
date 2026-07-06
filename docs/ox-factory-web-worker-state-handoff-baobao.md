# 包包任务：Web 展示员工休假 / 取消状态 / steer 语义

负责人：包包  
整理：派派  
日期：2026-07-06  
关联：OF-028

## 背景

工厂内核新增了三类运行控制能力：

1. 员工可以进入 `vacation`（休假）状态：长期不接新任务，但保留履历和历史记录。
2. 后台 job 可以被取消：运行中/队列中的 job 会进入 `aborted`；跨进程遗留 job 只能标记 aborted。
3. `steer` 需要按后端解释：
   - Codex 后端 + active turn：插入当前 turn；
   - Pi 后端或没有 active turn：排在当前 job 后优先执行。

这次页面先做**只读展示**，不要加写按钮，不要在 Web 页面直接调用取消/休假工具。

## 已有后端/API 变化

### `/api/workers`

- worker 的 `status` 可能新增：`vacation`。
- `vacation` 来自主 session 里的 `ox-worker-status` 事件，不是从 job 状态推断。
- 若员工休假，页面应显示为“休假 / 不接新任务”，不要按最新 job 推断成 idle/busy/error。

### `/api/workers/:name`

- detail payload 新增/可用 `status`。
- 同样可能是 `vacation`。

### `/api/jobs` / `/api/jobs/:id`

- job status 已有 `aborted`，后续会更多出现在取消任务场景。
- job events 里可能出现：
  - `type=aborted`
  - `type=steer`
  - `type=late_event_after_terminal`（取消后底层进程迟到输出，不应当作异常主事件吓人）

## 页面需求

### 1. Workers / Overview 状态展示

- `vacation` 使用独立颜色与图标，例如：🏖️ / 紫色或琥珀色。
- 文案建议：`休假`、`不接新任务`。
- Overview 的员工卡片里不要把休假员工算作“忙碌/异常”。
- Workers 列表建议支持按状态筛选时能看到 vacation（如果当前已有筛选 UI）。

### 2. Worker 详情页

在员工头部状态区展示：

- 状态：休假 / 空闲 / 忙碌 / 异常。
- 如果是 `vacation`，补一句说明：
  > 休假中：不会被推荐、派活、指挥、talk 或 message wake 唤起。

不要提供“返岗/休假”按钮；这类写操作仍由主 agent 通过 `factory_worker_status` 管理。

### 3. Jobs 页面 / Job 详情

- `aborted` 状态使用明确样式，不要和 failed 混成红色严重错误。
- Job 详情 timeline 中：
  - `aborted`：显示为“用户/系统取消”。
  - `late_event_after_terminal`：弱化展示为灰色提示，表示终态后的迟到事件。
  - `steer`：显示为“补充指令 / steer”，最好能展示 queuedJobId/sourceMessageId。

### 4. 帮助文案 / 空状态

如果页面有 command/help/tooltip，可补这段语义：

```text
steer 行为按员工后端不同：Codex 员工如果正在 active turn，会插入当前 turn；Pi 员工或没有 active turn 时，会创建优先 job，排在当前 job 后执行。
```

取消能力说明：

```text
取消当前 Pi 进程内 job 会尝试中止底层进程；reload 前遗留或其他进程 job 只能标记 aborted，不能保证杀进程。
```

## 不做范围

- 不做 Web 端 `Cancel` 按钮。
- 不做 Web 端 `Vacation/Return` 切换。
- 不新增写 API。
- 不为了页面展示重写 job events；只做前端聚合/样式。

## 验收建议

1. 构造/等待一个 `status=vacation` 的员工，`#/workers` 和 worker detail 都能显示休假。
2. Jobs 列表里 `aborted` pill 正常显示，颜色不等同 failed。
3. Job detail 能看懂 `aborted`、`steer`、`late_event_after_terminal`。
4. 刷新页面后状态仍在；不需要点 reload，只要 API 读到新主 session 即可。
5. 不引入任何 Web 写操作。
