# API 参考费用（Codex 第一版）

- 本功能是 Token 按参考单价折算，不是实际扣款或账单。
- 默认价格来源：https://developers.openai.com/api/docs/pricing ，核对日期 2026-09-07。
- 默认采用 Standard、短上下文参考价，单位 USD / 百万 Token。不自动判断实际服务档位、长上下文或区域加价；缓存写入、搜索和图片生成等独立费用不在其中。
- Codex 原始 input 包含 cached input，output 包含 reasoning output：费用为 `(input-cached)*inputRate + cached*cachedRate + output*outputRate`，再除以一百万。禁止用工厂的 totalWithCachedTokens 计价。
- 新收到的 Codex usage 事件标为 codex-inclusive-v1，按当前任务累计值覆盖，而不是累加重复通知。旧任务未确认口径，显示“用量口径未确认”，不按零估算。
- 第一条 usage 保存价格快照到 job.apiPrice；修改价格不重算已有快照。无价格任务可在配置补齐后按配置折算。
- 正在运行的任务详情每三秒读取费用，直到终态或关闭面板；真实频率受后端 usage 通知限制，不虚构逐 token 实时账单。
- 质量统计沿用当前日期/样本范围，费用含失败及运行中任务已记录用量，与“仅已完成任务”的耗时均值口径不同。已计价/未计价数量同时展示，不能将部分金额理解成全工厂总成本。

## 配置

配置文件：`workersDir/config/api-prices.json`。每次读取报告重新加载，不需要 reload 插件。存在时替换默认表，不与默认价隐式合并。非法配置关闭未快照任务计价，不回落到默认价格。

```json
{
  "models": {
    "gpt-6-astra": {
      "input": 10,
      "cachedInput": 1,
      "output": 50,
      "source": "https://developers.openai.com/api/docs/pricing",
      "observedAt": "2026-09-07",
      "basis": "standard-short-context"
    }
  }
}
```

全部价格为非负有限数，允许显式零价。建议原子替换配置。自定义实际渠道单价时同步修改 basis/source；界面仍称参考费用。第一版不提供 Web 价格编辑器。

## 验收

- 单元测试：缓存扣除、推理不重复收费、未知价/口径/坏数据、价格快照、配置热读取与坏配置。
- 临时目录 HTTP 测试：Job 详情、按模型/员工/日期范围统计一致。
- 真正 App Server usage 到 Web 自动刷新的端到端交互还需上线后人工验收；测试不会启动用户的实际 agent。
