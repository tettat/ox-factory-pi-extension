# OF-026：员工通信回调与有记忆指挥模式设计

> 日期：2026-07-04  
> 维护人：派派  
> 状态：最小内核版已落地，待 reload 后真实验证  
> 目标：让“留言”升级为可驱动工作的通信/指挥机制，同时保持上下文隔离和权限边界。

## 1. 背景

当前通信系统已经有：

- `factory_message_send`：授权消息，写 `.pi/workers/messages.jsonl`。
- `factory_inbox` / `comm-cli.mjs inbox`：员工可查看收件箱。
- `factory_queue` / `/talk queue` / `/talk steer`：可以给员工排队或插队式补充任务。

但缺口是：

1. 消息只是留言，不会自动推动员工去看。
2. 员工空闲时没有“收到消息后自动处理”的回调机制。
3. 主 agent 想直接指挥某个员工时，缺少一个明确的“有记忆 subagent”模式：复用员工 session，但隔离主 agent 上下文。

## 2. 推荐架构：消息仍是事实源，job 是执行回调

核心原则：

```text
messages.jsonl = 通信事实源
jobs/events/session = 执行事实源
permissions.json = 谁能发消息 / 谁能派活
```

不要让消息系统直接变成执行器；消息进入后，如果需要处理，就创建一个 job，让员工在自己的 session 里看 inbox 并执行。

## 3. Phase 1：显式唤醒 / 回调任务

新增能力：发送消息时可选择 `wake`。

建议工具参数：

```ts
factory_message_send({
  from,
  to,
  content,
  wake?: boolean,
  wakeMode?: "queue" | "steer",
  project?: string,
})
```

行为：

1. 先按现有权限检查 `message:send` / `message:broadcast`。
2. 写入 `messages.jsonl`。
3. 如果 `wake=true` 且 `to` 是单个员工：
   - 再检查发送者是否有 `work:assign` 到该员工的权限。
   - 创建一个 `kind: inbox` 或 `kind: command` job。
   - 任务内容固定模板：
     - 查看收件箱；
     - 重点处理 message id；
     - 如果只是建议就回复；如果是任务就执行并总结。
   - 如果员工空闲，马上跑；如果忙，排入该员工内存队列。
4. 如果 `to="*"`：第一版不自动唤醒全员，避免广播造成任务风暴；后续可支持 `wakeTargets` 白名单。

优点：

- 和现有权限模型兼容。
- 和现有 per-worker queue 兼容。
- 不需要员工常驻轮询 inbox。
- 用户可以明确选择“只是留言”还是“留言并唤醒处理”。

## 4. Phase 2：有记忆指挥模式

新增一个更明确的主 agent 工具或命令：

```ts
factory_command({
  worker,
  task,
  mode?: "auto" | "queue" | "steer" | "now",
  project?: string,
  attach?: boolean,
})
```

语义：

- `worker` 的历史 session 就是记忆。
- 主 agent 只拿到 job id / 短摘要，不吃完整输出。
- 完整执行过程写 worker session + job events。
- 如果用户要看实时输出，走 widget / drawer / attach，不把大段内容塞进主 agent。

模式：

| mode | 行为 |
|---|---|
| auto | 空闲立即执行，忙则 queue |
| queue | 明确排队 |
| steer | 当前 job 后优先插队；对于支持 active turn 的后端可尝试 steer |
| now | 仅当空闲才立即执行，否则拒绝或提示改 queue |

这就是“有记忆 subagent”：不是新开无记忆子代理，而是唤起指定员工的长期 session 去做事。

## 5. Phase 3：空闲时自动处理 inbox

在 Phase 1 稳定后，可加轻量 dispatcher：

- 在 job 完成、session_start、或手动 `factory_inbox_dispatch` 时触发。
- 查找有未读消息且当前 idle 的员工。
- 根据策略创建 inbox job。

建议默认保守：

- 不自动广播。
- 不重复为同一 message 创建多个 job。
- 每个员工同时最多 1 个 inbox callback job。
- 需要 `work:assign` 权限或由秘书触发。

## 6. 数据结构建议

消息记录保留兼容字段，追加可选元信息：

```json
{
  "type": "message",
  "id": "msg_xxx",
  "from": "派派",
  "to": "步美",
  "content": "...",
  "createdAt": "...",
  "intent": "task|note|review|question",
  "wake": true,
  "wakeJobId": "20260704..."
}
```

如果不想改历史 message 结构，也可以另写 append-only callback 事件：

```json
{"type":"message_wake","messageId":"msg_xxx","jobId":"...","createdAt":"..."}
```

推荐第二种：保持 message immutable，回调状态用事件追加。

## 7. 风险和边界

1. 自动唤醒可能造成任务风暴，所以第一版必须显式 `wake=true`。
2. 广播不自动唤醒全员。
3. 员工忙时必须进入 per-worker queue，不能并发写同一个 worker session。
4. 主 agent 默认只收短摘要；完整内容走 job events / Web / attach。
5. CLI 发送消息暂不自动唤醒，因为 CLI 子进程无法可靠访问当前 Pi 进程的 in-memory worker queue；后续可通过 runner/queue.jsonl 桥接。

## 8. 最小落地路径

1. 新增 `factory_command`：复用现有 `startTalkMessage` / `startWorkerJobQueued`，但输出短摘要。
2. 给 `factory_message_send` 加可选 `wake`，仅单人目标、且有 `work:assign` 权限时创建 inbox job。
3. 新增消息 wake 事件记录，避免重复唤醒。
4. 增加单测：
   - 无 `work:assign` 时 wake 被拒绝或降级为只留言。
   - 有权限时 wake 创建 job。
   - 忙碌员工 wake job 进入队列。
   - 广播 wake 默认拒绝。
5. Web 后续展示 message → wakeJobId 的关系。

## 9. 当前实现状态（2026-07-04）

已完成：

- `factory_command` 已新增。
- `factory_message_send` 已支持 `wake` / `wakeMode` / `project`。
- wake 单人目标会检查 `work:assign` 权限，创建 `kind=inbox` job。
- 广播 wake 默认拒绝，避免任务风暴。
- `factory_talk(background=true)` 和即时 `factory_queue` 已复用统一 `enqueueWorkerCommand()`。

已验证：

- `node validate-tools.mjs`
- `node --test test/ox-factory.test.mjs`
- 临时 Pi extension load smoke：`factory_list` 可调用，说明新增代码未阻断 extension 加载。

待 reload 后验证：

- 主 agent 自然语言是否能稳定选择 `factory_command`。
- `factory_message_send(wake=true)` 在真实员工空闲/忙碌状态下的排队行为。
- wake 创建的 inbox job 是否能引导员工正确读消息并回信。
