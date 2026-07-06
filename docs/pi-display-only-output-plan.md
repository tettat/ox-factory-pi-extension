# Pi display-only 输出与 Widget 探针方案

> 日期：2026-07-04  
> 维护人：派派  
> 关联问题：OF-024  
> 目的：探索“控制台能看员工 live 输出，但不写入主 agent LLM 上下文”的低风险路径。

## 1. 背景问题

牛马工厂 `/talk` 和部分展示命令使用 `pi.sendMessage({ customType, content, display: true }, ...)` 把员工输出显示到 Pi 控制台。

实际问题：Pi 的 `custom_message` 会进入 session 文件，并参与后续 LLM 上下文构造。主 agent 之前上下文爆炸就是因为历史 `ox-talk-live` 数量过多，且 compaction 的 token 预算没有正确覆盖这些 custom message。

用户希望：

- 控制台仍能看到员工输出；
- 主 agent 不“感知”这些输出，不污染上下文；
- 先不要急着改主链路；
- 可以先找 Pi UI / Widget 的临时展示方案。

## 2. Pi API 事实

本机 Pi 版本：`0.80.2`。

从本地安装包类型定义确认：

```ts
// dist/core/extensions/types.d.ts
interface ExtensionUIContext {
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setWidget(
    key: string,
    content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
    options?: ExtensionWidgetOptions,
  ): void;
}

type WidgetPlacement = "aboveEditor" | "belowEditor";
```

从 TUI 实现确认：

- `setWidget()` 只更新 `extensionWidgetsAbove` / `extensionWidgetsBelow` 内存 map。
- `content === undefined` 时清理 widget。
- 字符串数组最多展示 `InteractiveMode.MAX_WIDGET_LINES = 10` 行。
- 实现路径是 `interactive-mode.js#setExtensionWidget()`，没有调用 session manager 写入。

因此判断：`ctx.ui.setWidget()` 是当前最接近 display-only 的 Pi 插件能力。

## 3. 可选输出通道对比

| 通道 | 控制台可见 | 写 session | 进入 LLM context | 历史可追溯 | 适用 |
|---|---:|---:|---:|---:|---|
| `pi.sendMessage(custom_message)` | 是 | 是 | 是 | 是 | 不适合 live 大流量 |
| `pi.appendEntry(custom)` | 否或取决于渲染 | 是 | 通常不进 message context | 是 | 适合结构化归档 |
| job events (`events/*.jsonl`) | Web/命令可见 | 写 workers | 不进主 context | 是 | 适合完整 transcript |
| `ctx.ui.setWidget()` | 是 | 否 | 否 | 否 | 适合实时面板 / tail |
| Pi 上游 `sendMessage({ context:false })` | 是 | 可选 | 否 | 可选 | 理想长期方案 |

短期最佳组合：

```text
完整输出：写 job events
控制台实时：ctx.ui.setWidget() 展示最近 N 行
主上下文：只注入 started/finished 短摘要 + job id
显式查看：/attach 或 Web 读取 job events
```

## 4. 安全探针设计

不要直接改 ox-factory `/talk` 主链路。先做一个孤立探针扩展，验证两件事：

1. `ctx.ui.setWidget()` 在当前 Pi TUI 中能正常展示和更新。
2. 执行探针后，当前 session 文件不会新增 `custom_message` 或大段消息。

### 4.1 探针扩展草案

位置建议：`/tmp/ox-widget-probe/index.ts`，不要放入当前项目 `.pi/extensions` 自动加载目录。

```ts
export default function activate(pi: any) {
  pi.registerCommand("widget_probe", {
    description: "临时测试 ctx.ui.setWidget display-only 输出；不写 session。",
    async handler(_args: any, ctx: any) {
      const key = "ox-widget-probe";
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        ctx.ui.setWidget(key, [
          "🐂 ox-widget-probe",
          `tick=${tick}`,
          `time=${new Date().toISOString()}`,
          "这应该只显示在 TUI widget，不应写入 custom_message。",
        ], { placement: "aboveEditor" });
        if (tick >= 5) {
          clearInterval(timer);
          ctx.ui.setWidget(key, undefined);
          ctx.ui.notify("widget_probe finished", "info");
        }
      }, 1000);
    },
  });
}
```

### 4.2 验证方式

1. 在一个临时目录启动 Pi，加载探针扩展。
2. 记录 `/session` 当前 session 文件路径。
3. 执行 `/widget_probe`。
4. 观察 TUI 是否出现 widget 面板并每秒更新。
5. 退出后检查 session jsonl：

```bash
rg -n 'widget_probe|custom_message|ox-widget-probe' <session-file>
```

预期：

- 可以看到用户执行命令的记录；
- 不应该看到 5 次 tick 的 `custom_message`；
- 不应该看到大段 widget 内容作为 LLM message。

## 5. 临时 Pi 验证记录（2026-07-04）

### 5.1 Widget display-only 探针

临时目录：`/tmp/ox-widget-probe-run`  
临时扩展：`/tmp/ox-widget-probe/index.ts`

启动命令：

```bash
cd /tmp/ox-widget-probe-run
pi --no-skills --no-prompt-templates --no-themes --no-context-files \
  --extension /tmp/ox-widget-probe/index.ts \
  --session-dir /tmp/ox-widget-probe-run/sessions \
  --session-id widget-probe \
  --approve \
  --model minimax/MiniMax-M2.7-highspeed
```

验证结果：

- `/widget_probe` 在真实 Pi TUI 中能显示并刷新 `🐂 ox-widget-probe` 面板。
- 面板 tick 更新正常，结束后 `ctx.ui.setWidget(key, undefined)` 能清理。
- 退出后检查 `/tmp/ox-widget-probe-run`，未发现 session jsonl，也未发现 `custom_message` / `ox-widget-probe` / `tick=` 落盘。

结论：`ctx.ui.setWidget()` 在当前 Pi TUI 上已验证可用，适合作为 `/talk` live 的 display-only 展示通道。

### 5.2 当前 ox-factory `/talk` 旧链路 smoke

临时目录：`/tmp/ox-factory-talk-smoke`  
临时 session：`/tmp/ox-factory-talk-smoke/sessions/2026-07-04T06-54-05-162Z_main-smoke.jsonl`  
临时 worker runtime：`/tmp/ox-factory-talk-smoke/.pi/workers`

验证步骤：

1. 用 Minimax 后端在临时 Pi 中通过 `factory_hire` 招募 `临时包包`。
2. 在同一临时 session 中执行：

   ```text
   /talk 临时包包 请只回复三行，每行以 LIVE-SMOKE 开头，别调用工具。
   ```

验证结果：

- `/talk` 正常启动 in-process job：`20260704065456-_-gdglz1`。
- TUI 正常展示：
  - `ox-talk-started`
  - `ox-talk-live`
  - `ox-talk-finished`
- job 完成，`.pi/workers/jobs/20260704065456-_-gdglz1.json` 状态为 `done`。
- worker events 写入 9 条，包含 `thinking`、`text`、`done`。
- worker session 写入 `/tmp/ox-factory-talk-smoke/.pi/workers/sessions/临时包包.jsonl`。

关键发现：

- 旧 `/talk` live 功能链路“可用”：能招人、能跑 Minimax worker、能 streaming、能写 job/events/session。
- 但旧链路仍会向主 session 写 `custom_message`：
  - `ox-talk-started`: 1 条
  - `ox-talk-live`: 1 条
  - `ox-talk-finished`: 1 条
- 因此它对“上下文安全”仍不稳：只要员工长输出或多轮输出，`ox-talk-live` 仍会继续污染主 agent session。

本次 smoke 还暴露一个交互事实：在当前 talk 态里直接输入 `/exit` 并不会被 Pi 当作命令拦截，而是作为普通用户消息交给当前模型处理。后续若做 talk UX，应该明确提供 `/talk off` / `/talk exit` 的命令级退出路径，并避免 talk 态吞掉全局命令。

## 6. 后续接入 ox-factory 的方案

### Phase 1：不改主链路，仅加旁路能力

- 新增一个内部 `talkLiveSink` 抽象：
  - `events` sink：永远写 job events；
  - `message` sink：当前 `pi.sendMessage`；
  - `widget` sink：`ctx.ui.setWidget`。
- 默认仍用现状或短摘要，先不开 widget 替代。
- 写单测保证 `widget` sink 不调用 `pi.sendMessage`。

### Phase 2：灰度 `/talk` live widget

- `/talk` 启动后设置 widget key：`ox-talk-live:<worker>`。
- 每次 stream event 只更新最近 8-10 行 tail。
- job 完成后清理 widget，并用 `pi.sendMessage` 发一条短摘要：worker、job id、summary、查看方式。
- 完整 transcript 仍在 `.pi/workers/events/*.jsonl` 和 Web Job 详情页。

### Phase 3：上游 Pi issue / MR

- 给 `sendMessage` 增加 `context:false` / `displayOnly`，或者提供明确 UI-only message channel。
- 修 compaction 预算：把 `custom_message` 纳入 token 估算，避免“压缩成功但仍超窗”。
- 增加 compaction 后二次估算 fallback。

## 7. 当前结论

`ctx.ui.setWidget()` 已在真实临时 Pi TUI 中跑通，且未观察到 widget 内容落入 session/custom_message。当前 ox-factory `/talk` 旧链路在临时 Minimax worker 上也能跑通，但它依然用 `pi.sendMessage(custom_message)` 承载 live 输出，会污染主上下文。

建议下一步：

1. 不再验证“旧 live 能不能跑”——它功能上能跑，但上下文安全不达标。
2. 实现最小 `talkLiveSink`：
   - 完整输出继续写 job events；
   - live tail 用 `ctx.ui.setWidget()`；
   - `ox-talk-started` / `ox-talk-finished` 只保留短摘要；
   - 默认不再发送 `ox-talk-live` custom_message。
3. 用同样的 `/tmp/ox-factory-talk-smoke` 路径再做一轮回归：要求 TUI 能看到 widget live，主 session 不出现 `ox-talk-live`。
