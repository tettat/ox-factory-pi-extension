# Worker Compaction 监控缺口报告

日期：2026-07-07  
相关问题：OF-021 / OF-033  
对象：Pi 后端员工 session，重点样本：包包

## 结论

包包已经发生过 Pi 原生 compaction，但没有进入牛马工厂的 `compaction-shadow.jsonl` 监控视野。

这不是“包包没 compact”，而是此前 ox-factory 的 compact 监控不是通用审计；它只记录 **Codex shadow / apply 链路** 的结果。主 agent 默认启用 shadow，所以会有记录；员工此前默认关闭 shadow，所以员工 Pi 原生 compaction 只写回自己的 session JSONL，不会生成工厂侧 shadow 对比记录。2026-07-07 已改为 worker 默认 shadow-only：下次 reload 后，新触发的 worker compaction 会进入 `.pi/workers/compaction-shadow.jsonl` 对比。

## 证据

### 包包 session 中已有 compaction

文件：`.pi/workers/sessions/包包.jsonl`

截至 2026-07-07 统计：

- session 文件大小：约 4.31 MB
- JSONL 行数：709
- `type=compaction` 记录数：6
- 今日 token report：约 1.94M totalWithCachedTokens

精确 compaction 记录：

| line | id | timestamp | tokensBefore | fromHook |
| --- | --- | --- | ---: | --- |
| 114 | 508a81d3 | 2026-07-02T12:21:05.638Z | 128,532 | false |
| 331 | eb451c42 | 2026-07-04T05:20:24.540Z | 143,459 | false |
| 430 | 480d4aa0 | 2026-07-04T07:26:21.961Z | 112,562 | false |
| 477 | 506895bb | 2026-07-04T07:50:06.670Z | 273,665 | false |
| 616 | 1fc58e64 | 2026-07-05T04:09:44.834Z | 124,313 | false |
| 656 | 512a9809 | 2026-07-07T08:23:16.763Z | 111,740 | false |

`fromHook=false` 表示这些是 Pi 默认 compaction 结果，不是 ox-factory hook 返回的 Codex compaction。

### 工厂 shadow 记录只有主 agent

命令：

```bash
node .pi/extensions/ox-factory/compaction-report.mjs --workers-dir .pi/workers --limit 20 --json
```

结果摘要：

- `.pi/workers/compaction-shadow.jsonl` 当前只有 2 条记录。
- 两条均为 `targetType=main` / `worker=主agent`。
- 没有 `worker=包包` 的记录。

## 当前代码行为

入口：`.pi/extensions/ox-factory/index.ts`

```ts
pi.on("session_before_compact", async (event, ctx) => {
  return handleFactoryCompactionEvent(event, ctx, {
    workersDir: getWorkersDir(),
    model: process.env.OX_FACTORY_CODEX_COMPACTION_MODEL || "gpt-5.5",
  });
});

pi.on("session_compact", (event, ctx) => {
  void handleFactoryCompactionCompleted(event, ctx, {
    workersDir: getWorkersDir(),
  });
});
```

决策逻辑：`.pi/extensions/ox-factory/compaction.mjs`

- `getCompactionModeSetting()` 默认 `off`。
- 主 agent 如果没有显式配置且目标在 scope 内，自动变成 `shadow`。
- worker 默认已改为 `shadow`（2026-07-07），显式 `off` 仍可关闭。
- worker 只有配置了 `OX_FACTORY_CODEX_COMPACTION_MODE=shadow/apply`，并通过 `OX_FACTORY_CODEX_COMPACTION_WORKERS` 允许后，才会触发 Codex shadow/apply。
- `handleFactoryCompactionCompleted()` 只会在 `pendingShadowCompactions` 有对应记录时写 `compaction-shadow.jsonl`。普通 Pi 原生 compaction 没有 pending shadow，所以不会落审计记录。

因此当前语义是：

> “Codex compaction shadow 评估记录”，不是“所有 compaction 事件记录”。

## 为什么主 agent 有，包包没有

1. 主 agent 默认 shadow-only，所以主 agent 的 compaction 会触发 Codex side channel 并写 `compaction-shadow.jsonl`。
2. 员工默认关闭 shadow，避免早期把所有员工压缩都发给 Codex 造成风险/成本/延迟。
3. 包包的 6 次 compaction 是 Pi 原生压缩；它们只落在 `.pi/workers/sessions/包包.jsonl`。
4. Web / `factory_compaction_report` 只读 `.pi/workers/compaction-shadow.jsonl`，所以看不到包包。

## 风险

- 用户会误以为“员工没 compact”或“监控坏了”。
- 长期员工是否频繁 compact、压缩前 token 多大、摘要质量如何，当前 Web/报告不可见。
- 包包这类高噪声 session 发生多次 compaction 后，质量退化不会进入风险列表。
- 后续如果要灰度 Codex worker compaction，缺少 baseline：不知道哪些员工最需要先处理。

## 建议最小修复路径

### A. 先做只读审计，不动压缩主链路

后续如需补历史 native 视图，再新增 worker compaction indexer：

- 只读 `.pi/workers/sessions/*.jsonl`。
- 扫描 `type=compaction` 记录。
- 生成 `.pi/workers/compaction-events.jsonl` 或在 Web API 动态聚合。
- 字段建议：
  - worker
  - sessionFile
  - compactionId
  - timestamp
  - tokensBefore
  - fromHook
  - summaryChars
  - firstKeptEntryId
  - readFiles/modifiedFiles 数量

这样不改变员工运行、不改 Pi 存储，只补可观测性。

### B. Web / factory_compaction_report 合并两个数据源

把压缩页和报告分成两类：

1. `native`：Pi 原生 compaction 事件，来自员工/主 session JSONL。
2. `shadow`：Pi vs Codex 对比记录，来自 `compaction-shadow.jsonl`。

展示上明确标注：

- “已压缩但未 shadow”
- “已 shadow，有 Codex 对比”
- “shadow 失败”

### C. 当前默认策略

2026-07-07 已按用户要求改为：主 agent 和所有 worker 默认 shadow-only。

```bash
# 默认无需配置：所有可识别 target 都 shadow-only

# 临时关闭
OX_FACTORY_CODEX_COMPACTION_MODE=off

# 可选：只监控部分员工
OX_FACTORY_CODEX_COMPACTION_WORKERS=包包,东子
```

生效需要 reload / 重启 Pi，让后续 worker 子进程加载新逻辑。

## 暂不建议直接做的事

- 已按用户要求把所有员工默认开 shadow；需要持续观察成本、延迟、失败率和隐私边界。
- 不建议直接 apply Codex 压缩到员工真实 session：应该先积累 shadow 质量对比。
- 不建议改 Pi 原生 session 格式：只读索引即可。

## 包包当前建议

包包适合小范围、明确清单式的前端修补，但不适合作为最终验收人。

原因：

- 能真实 edit 文件；
- 但会漏关键状态、验证命令容易写成正文不实际执行；
- session 已经 4MB+，发生过 6 次 compaction，近期表现不稳定。

建议给包包的任务必须：

1. 一次只给 3~5 个明确文件/函数级修改点。
2. 明确禁止“把命令写在正文里冒充执行”。
3. 完成必须包含真实工具结果和测试命令输出。
4. 最终由派派/八村 review。
