# API 参考费用

- 本功能是 Token 按参考单价折算，不是实际扣款或账单。
- 默认价格核对日期：2026-09-08。
- 默认补齐当前工厂可公开计价的 Codex/OpenAI、MiniMax、DeepSeek、GLM 相关模型；Claude Code 后端、豆包 `model_api/*`、未知内部模型继续不计价。
- 默认输出单位仍为 USD。MiniMax / DeepSeek 官方价格为人民币时，按 `7 CNY/USD` 做参考换算；这只是为了 Web 页统一显示，不代表实际结算汇率。
- Codex 原始 input 包含 cached input，output 包含 reasoning output：费用为 `(input-cached)*inputRate + cached*cachedRate + output*outputRate`，再除以一百万。禁止用工厂的 totalWithCachedTokens 计价。
- Pi/relay provider usage 的 `inputTokens` 通常不包含缓存命中 token；可计价模型会显式标记为 `inputTokenMode=exclusive`，费用为 `input*inputRate + cached*cachedRate + output*outputRate`。
- 新收到的 Codex usage 事件标为 codex-inclusive-v1，按当前任务累计值覆盖，而不是累加重复通知。旧 Codex 任务如果带有 codex thread/turn id，会按历史 Codex 字段保守估算；普通未知口径仍显示“用量口径未确认”。
- 第一条 usage 保存价格快照到 job.apiPrice；修改价格不重算已有快照。无价格任务可在配置补齐后按配置折算。
- 正在运行的任务详情每三秒读取费用，直到终态或关闭面板；真实频率受后端 usage 通知限制，不虚构逐 token 实时账单。
- 质量统计沿用当前日期/样本范围，费用含失败及运行中任务已记录用量，与“仅已完成任务”的耗时均值口径不同。已计价/未计价数量同时展示，不能将部分金额理解成全工厂总成本。

## 默认价格覆盖

| 模型/别名 | 来源 | 规则 |
|---|---|---|
| `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | OpenAI pricing | Standard short context；>272K input 自动应用长上下文倍率 |
| `gpt-5.5`, `gpt-5.4` | OpenAI model docs | Standard short context；>272K input 自动应用长上下文倍率 |
| `gpt-5.5-2026-04-24`, `modelhub/gpt-5.5-2026-04-24` | OpenAI 价格，内部 provider alias | Provider exclusive input 口径 |
| `MiniMax-M3` | MiniMax 按量计费 | 标准价；>512K input 自动切长上下文档；CNY 转 USD 展示 |
| `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2.1-highspeed`, `MiniMax-M2` | MiniMax 按量计费 | CNY 转 USD 展示 |
| `deepseek-v4-flash`, `deepseek-v4-pro` | DeepSeek 模型价格 | 按北京时间工作日 9:00-12:00、14:00-18:00 判断 peak，其余 off-peak；CNY 转 USD 展示 |
| `opensource/glm5.2`, `super-relay/opensource/glm5.2` | Z.AI pricing | GLM-5.2 USD 价格 |

## 配置

配置文件：`workersDir/config/api-prices.json`。每次读取报告重新加载，不需要 reload 插件。存在时替换默认表，不与默认价隐式合并。非法配置关闭未快照任务计价，不回落到默认价格。

```json
{
  "models": {
    "gpt-6-astra": {
      "input": 10,
      "cachedInput": 1,
      "output": 50,
      "currency": "USD",
      "source": "https://developers.openai.com/api/docs/pricing",
      "observedAt": "2026-09-08",
      "basis": "openai-standard-short-context",
      "inputTokenMode": "inclusive"
    }
  }
}
```

全部价格为非负有限数，允许显式零价。建议原子替换配置。自定义实际渠道单价时同步修改 `basis/source/currency/inputTokenMode`；界面仍称参考费用。第一版不提供 Web 价格编辑器。

自定义 CNY 价格时可带：

```json
{
  "models": {
    "example-cny-model": {
      "input": 2.1,
      "cachedInput": 0.42,
      "output": 8.4,
      "currency": "CNY",
      "cnyPerUsd": 7,
      "inputTokenMode": "exclusive",
      "allowSchemaLessUsage": true
    }
  }
}
```

## 验收

- 单元测试：缓存扣除、推理不重复收费、未知价/口径/坏数据、价格快照、配置热读取与坏配置、Pi exclusive input、OpenAI 长上下文、MiniMax 长上下文、DeepSeek 峰谷价。
- 临时目录 HTTP 测试：Job 详情、按模型/员工/日期范围统计一致。
- 真正 App Server usage 到 Web 自动刷新的端到端交互还需上线后人工验收；测试不会启动用户的实际 agent。
