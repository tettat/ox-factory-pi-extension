# Web UX 问题交接：Tokens / Job Drawer / 流式事件聚合

> 日期：2026-07-04  
> 维护人：派派  
> 接收人：八村  
> 范围：页面体验优化；内核侧性能和 drawer 遮罩 bug 已由派派先做低风险修复。

## 1. 已修复：Tokens 页面刷新慢的主要后端原因

现象：Tokens 页面刷新慢，尤其趋势区间切到 7 / 14 / 30 天时明显卡。

根因：`/api/tokens/trend` 之前按天循环调用 `buildFactoryTokenReport()`，每一天都会重新全量读取并解析所有 worker sessions 和 jobs。

派派已改：

- `token-report.mjs` 增加 token index：一次扫描 sessions/jobs，按日期聚合。
- `buildFactoryTokenReport()` 复用该 index。
- 新增 `buildFactoryTokenTrend()`，趋势接口不再 N 天重复全量扫描。
- 保留旧行为：所有 session 员工仍会在当日报告中占位展示，即使当天 0 token。

本机真实数据 smoke：

| 接口 | 优化后耗时 |
|---|---:|
| `/api/tokens` 首次 | ~326ms |
| `/api/tokens/trend?days=7` | ~8ms |
| `/api/tokens/trend?days=30` | ~5ms |
| `/api/tokens` 缓存命中 | ~4ms |

八村后续页面建议：

1. Tokens 页面 loading 应该分区展示：明细和趋势分别显示 skeleton，避免整个页面空白等待。
2. 日期/趋势 select 变化时可禁用控件并显示轻量 loading 状态。
3. 如果 trend 请求失败，不要影响当天明细展示。
4. 可以在页面上显示 `generatedAt` 和“手动刷新”提示，避免误以为自动实时。

## 2. 已修复：Job Drawer 灰色遮罩覆盖右侧内容

现象：点开事件流 / job 详情后页面一片灰，右侧 drawer 内容能看到但无法滚动或操作。

根因：HTML 中 `.drawer__backdrop` 排在 `.drawer__panel` 后面，二者在同一 stacking context 中；backdrop 后渲染，覆盖了 panel 并拦截点击/滚动。

派派已改：

- `.drawer__backdrop { z-index: 1; }`
- `.drawer__panel { z-index: 2; }`
- `.drawer__body { flex: 1; min-height: 0; overflow-y: auto; }`

八村后续验证：

1. Job 页面点击任一 job 行，右侧 drawer 可正常点击关闭按钮。
2. 点击灰色 backdrop 可关闭 drawer。
3. 事件流很长时，右侧 drawer body 内部可滚动；左侧页面不需要可操作。
4. 移动端宽度下 drawer 仍覆盖全屏但内容可滚动。

## 3. 待处理：包包输出被拆成大量单字/短片段事件

现象：包包的一些 job events 里，`thinking` 或 `text` 是按 token delta 写入的，页面事件流会显示成几十万条“单字消息”，比如：

```text
thinking 用户
thinking 提醒
thinking 我
thinking 派
thinking 派发
...
```

观察样本：

- `20260704072709-_-zxtydu`：约 7 万条事件，很多是单字/短词 delta。
- `20260704071005-_-rr85ol`：约 6 万条事件，类似。
- `20260704075026-_-qcyl1z`：数千条事件，仍是碎片化 thinking。

原因判断：不同后端 streaming 粒度不一致：

- 有的 Pi/OpenAI/Responses 兼容层按完整句子/段落返回 delta。
- 有的模型或网关按 token / 字符返回 delta。
- 当前 `spawner.ts` 会把每个 delta 直接 append 为一个 job event。
- `web-server.mjs` 的 `handleJobDetail()` 现在返回 `tailJobEvents(job, 100)` 的原始尾部事件，前端照单渲染，所以看起来像“一条条消息”。

建议八村先做页面侧聚合，不改底层事件日志：

1. Job drawer 事件流区按连续同类事件合并展示：
   - 连续 `thinking` 合成一个 collapsible block。
   - 连续 `text` 合成一个 assistant output block。
   - `tool_start` / `tool_output` / `tool_end` 保持独立或按 tool call 分组。
2. 原始事件数量很大时，只渲染最近聚合后的 N 组，而不是直接渲染 100 条 raw event。
3. 每组显示：类型、起止时间、原始事件数、合并文本预览；点击展开看完整文本。
4. 不要在前端一次性渲染几万条 DOM。后端当前只给 tail 100，但后续如果开放 full events，更要虚拟列表/分页。

后续内核可选优化：

- 在 `web-server.mjs` 增加 `eventsGrouped` 字段，后端统一聚合。
- 或在 `jobs.mjs` 增加 `tailJobEventGroups()`。
- 但第一步建议前端先做 display grouping，保持 API 兼容。

## 4. 八村接下来的建议优先级

1. 验证 drawer 遮罩修复，补 UI smoke 截图/说明。
2. Tokens 页面增加分区 loading 和失败降级。
3. Job drawer 增加 event grouping，解决包包这类模型 token-delta 刷屏。
4. 若要新增 API 字段，先保持旧 `events` 不变，新增 `eventGroups`，避免破坏现有页面。
