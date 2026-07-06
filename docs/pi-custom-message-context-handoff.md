# Pi custom_message 上下文污染与 compaction 预算问题 Handoff

> 日期：2026-07-04  
> 维护人：派派  
> 关联：OF-024、`docs/pi-display-only-output-plan.md`  
> 用途：给 Pi 上游 issue / MR 负责人快速理解问题、复现方向和建议修复点。

## 一句话结论

Pi 插件侧 `pi.sendMessage({ customType, display: true })` 产生的 `custom_message` 会被写入 session，并参与后续 LLM 上下文；但 Pi compaction 的保留预算估算没有一致地计算这些 `custom_message`，导致“压缩看似成功，但实际构造请求仍超模型上下文窗口”。

牛马工厂 `/talk` live 曾大量写入 `ox-talk-live custom_message`，触发主 agent 上下文膨胀。工厂侧可以先改为 `ctx.ui.setWidget()` display-only 展示来止血，但 Pi 上游仍建议修复语义和预算一致性。

## 现象

主 agent 曾触发：

```text
Error: 400 This model's maximum context length is 1048565 tokens. However, you requested 2594293 tokens (2594293 in the messages, 0 in the completion). Please reduce the length of the messages or completion.
```

当时 session 中存在大量员工 live 展示消息：

- `ox-talk-live`
- `ox-talk-attached`
- `ox-talk-finished`

这些消息以 `custom_message` 形式落在主 session 里。用户直觉以为 `display: true` 是“展示给人看”，但实际它同时会进入模型上下文。

## 根因判断

### 1. `custom_message` 语义容易误用

插件作者看到 `display: true`，容易理解成“UI only”。但 Pi 当前行为是：

- 写入 session；
- 可在 TUI 渲染；
- 后续参与 LLM context；
- 参与 compaction cutpoint / turn 边界逻辑。

如果这是设计行为，需要更明确的 API/文档；如果不是，建议增加 display-only 通道。

### 2. compaction token 预算与实际 context 构造不一致

分析方向来自本地 Pi 安装包中的相关实现：

- `dist/core/session-manager.js`
- `dist/core/compaction/compaction.js`
- `dist/core/agent-session.js`

问题点：

1. `buildSessionContext` 会把 `custom_message` 纳入后续 LLM 上下文。
2. `findCutPoint` / keep recent token 预算主要统计普通 `message`，没有一致地把 `custom_message` 纳入同一预算。
3. `findValidCutPoints` / `findTurnStartIndex` 又会把 `custom_message` 当作 turn 边界相关 entry 处理。
4. compaction 结束后缺少“重新按真实 buildSessionContext 估算是否仍超窗”的兜底。

结果就是：压缩动作可能选择了一个理论上足够的 cutpoint，但真实请求里仍携带大量 `custom_message`，最终模型 API 报超窗。

## 最小复现建议

可以构造一个小 session fixture：

1. 写入少量普通 user / assistant message。
2. 插入大量 `custom_message`，每条 content 模拟几百到几千 token。
3. 触发 compaction。
4. compaction 结束后调用与真实 agent turn 相同的 `buildSessionContext` 路径。
5. 对比：
   - compaction 选择 cutpoint 时估算的 token；
   - 最终请求 messages 的 token；
   - 是否仍超过模型窗口。

预期复现点：

- 如果 `custom_message` 很多，compaction 后实际 messages token 仍可能明显高于预算。
- 即使 summary 本身很短，保留区里的 `custom_message` 仍会导致请求过大。

## 工厂侧验证证据

### 临时 Widget 探针

位置：`/tmp/ox-widget-probe/index.ts`  
临时目录：`/tmp/ox-widget-probe-run`

验证：

- `ctx.ui.setWidget()` 能在真实 Pi TUI 中显示并刷新面板。
- 退出后未发现 `custom_message` / widget tick 内容落盘。

结论：`ctx.ui.setWidget()` 可作为短期 display-only UI 通道。

### 临时 ox-factory `/talk` smoke

位置：`/tmp/ox-factory-talk-smoke`  
后端：`minimax/MiniMax-M2.7-highspeed`  
临时员工：`临时包包`  
job：`20260704065456-_-gdglz1`

验证：

- `/talk` 功能链路可跑通；
- worker events / jobs / session 正常落盘；
- TUI 能看到 `ox-talk-started` / `ox-talk-live` / `ox-talk-finished`；
- 但主 session 仍写入三条 `custom_message`。

结论：旧 `/talk` live 不是功能不可用，而是上下文隔离不合格。

## 建议 Pi 上游修复方向

### 方案 A：补齐 compaction 预算一致性

在 cutpoint 预算估算时，使用与 `buildSessionContext` 等价的 entry-to-message 逻辑，至少确保：

- `custom_message` 如果会进入最终 LLM context，就必须计入 token 预算；
- cutpoint 选择不能忽略大量 custom entry；
- compaction 后应重新估算真实 context，仍超窗则继续压缩或提示无法恢复。

优点：修复根因，兼容现有 API。  
缺点：不能解决插件作者想要 UI-only 输出的需求。

### 方案 B：增加 display-only / context:false 通道

为 `sendMessage` 或插件 UI API 增加明确语义，例如：

```ts
pi.sendMessage({
  customType: "xxx",
  content: "...",
  display: true,
  context: false,
});
```

或新增专门 UI-only message channel。

期望：

- 控制台可见；
- 不进入 LLM context；
- 可选择是否落 session；
- API 名称避免把 `display: true` 误解成 context false。

优点：满足插件 display-only 场景。  
缺点：需要明确历史兼容和 session replay 行为。

### 方案 C：文档和类型标注增强

如果短期不改 API，至少应在插件 API 文档和类型注释里写清楚：

- `custom_message` 会参与 LLM context；
- `display` 只是 UI 展示标记，不表示 display-only；
- 大流量 live 输出不应通过 `sendMessage` 写入。

优点：低风险。  
缺点：只能防误用，不能修复已存在的预算不一致。

## 工厂侧短期落地计划

牛马工厂不等待 Pi 上游修复，先做止血：

1. `/talk` 完整输出继续写 `.pi/workers/events/*.jsonl`。
2. 控制台 live tail 改用 `ctx.ui.setWidget()`。
3. 主 session 只保留 started / finished 短摘要和 job id。
4. 不再发送 `ox-talk-live custom_message`。
5. Web / 命令查看完整历史时，从 job events 读取。

这可以让用户继续看到实时输出，同时避免主 agent 持续观察到所有员工输出。

## 交付给 Pi 负责人的建议话术

可以直接这样开 issue：

> We found that extension `custom_message` entries appended through `pi.sendMessage({ display: true })` participate in later LLM context construction, but compaction token budgeting does not consistently account for them. This can make compaction appear successful while the next model request still exceeds the model context limit. We can provide a fixture with many custom messages to reproduce. We also suggest either including custom messages in compaction budgeting, adding a post-compaction real-context token check, and/or introducing an explicit display-only/context:false channel for extension UI output.

## 相关文档

- `docs/pi-display-only-output-plan.md`：工厂侧 display-only 输出方案和临时 Pi 验证记录。
- `docs/ox-factory-improvement-tracker.md#OF-024`：问题总账、救援记录、后续方向。
- `docs/ox-factory-quality-checklist.md`：OF-024 的验收状态和下一步。
