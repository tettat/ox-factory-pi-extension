# 八村交接：员工质量趋势可视化（Worker Quality Trends）

时间：2026-07-07  
交接人：派派  
负责人：八村  
范围：牛马工厂 Web dashboard 前端展示优化；派派不写 UI 代码，本文件作为页面需求和验收标准。

## 背景

用户现在已经能在后端拿到员工质量观测数据，但当前页面只给了整体表格和最近 turn，缺少“同一个员工随时间变化”的趋势图。用户明确希望能看到：

> 同一个员工在上下文变长、压缩次数变多之后，回复长度、耗时、工具调用、情绪评分等是否发生变化。

所以你需要把 Web 上的质量观测从“全局表格”优化成“员工维度趋势分析”。

## 数据源

现有接口：

```text
GET /api/quality-metrics?date=all&limit=all
GET /api/quality-metrics?date=YYYY-MM-DD&limit=120
```

重要字段：

- `workers[]`
  - `worker`
  - `session.userTurns`
  - `session.estimatedContextTokens`
  - `session.compactionCount`
  - `jobs.count`
  - `jobs.avgInputChars`
  - `jobs.avgOutputChars`
  - `jobs.avgResponseMs`
  - `jobs.toolCalls`
  - `jobs.avgEmotionScore`
- `turns[]`
  - `jobId`
  - `worker`
  - `createdAt`
  - `inputChars`
  - `outputChars`
  - `responseMs`
  - `toolCalls`
  - `sessionContextTokens`
  - `sessionCompactions`
  - `sessionUserTurns`
  - `emotionScore`
  - `taskPreview`
  - `outputPreview`
- `dates[]`
  - 全局按天汇总，可作为全厂概览，但员工趋势主要用 `turns[]` 自己按 worker/date 聚合。
- `history.dropReasons`
  - 展示数据清洗情况。

## 目标页面/位置

优先放在现有 `#/compactions?qdate=all` 的质量观测区域里，不要新建太多路由。

建议结构：

1. 顶部仍保留“全部历史 / 指定日期”切换。
2. 在质量观测区域新增一个 **员工趋势面板**。
3. 面板中有员工选择器：
   - 默认选择 turn 数最多的员工，或者第一个活跃员工。
   - 支持搜索/下拉选择员工。
4. 选择员工后展示该员工的趋势图和明细。

## 必做图表

### 1. 上下文趋势图

展示同一个员工随时间变化：

- X 轴：turn 时间，或按天聚合后的日期。
- Y 轴主指标：`sessionContextTokens`。
- 同图叠加压缩次数 `sessionCompactions`，可以用点/阶梯线/右轴。
- 当发生 compaction 增长时，要有明显标记，例如竖线或小 badge。

目的：让用户直观看到“上下文是不是越跑越大，压缩发生在哪些点”。

### 2. 回复表现趋势图

同一个员工随时间变化：

- `inputChars`
- `outputChars`
- `responseMs`
- `toolCalls`

推荐展示方式：

- 输入/输出长度：双线图或面积图。
- 响应耗时：折线图，单位秒。
- 工具调用：柱状图或点状图。

不要把所有线塞进一张图导致看不懂。可以用 tab：

- 长度
- 耗时
- 工具

也可以用小 multiples：三张小图并排。

### 3. 情绪评分趋势图（如果有数据）

- `emotionScore` 范围 1~5。
- 无数据时展示空状态：`情绪评分旁路尚未开启，暂无评分数据`。
- 有数据时展示折线/点图，低分用暖色提示。

注意：情绪分不是绩效结论，只是用户反馈信号。文案要克制。

## 必做交互

1. Hover tooltip：
   - 时间
   - jobId
   - 输入/输出长度
   - responseMs
   - toolCalls
   - contextTokens
   - compactions
   - emotionScore（如有）
   - taskPreview

2. 点击某个点：
   - 跳转到 `#/jobs/<jobId>` 或打开现有 job drawer。

3. 时间粒度：
   - turn 数少时按 turn 展示。
   - turn 数多时可按天聚合，或保留最近 N 个点 + 提示“已按天聚合”。
   - 不要一次渲染几百个 DOM 节点导致页面卡。

4. 员工选择器旁边展示 mini summary：
   - 样本数
   - 当前上下文估算
   - 压缩次数
   - 平均输出长度
   - 平均耗时
   - 工具调用总数
   - 平均情绪（如有）

## 视觉要求

用户反馈派派 UI 水平差，所以这里你需要负责把页面做得像现代 dashboard：

- 用现有设计 token，不要乱加 raw color。
- 图表要有清晰图例、坐标单位和 hover 状态。
- 不要只靠颜色表达含义，低分/高分要有文字或 icon 标识。
- 加载全历史时要有 skeleton/loading，不要白屏。
- 空状态要有解释，而不是空表。
- 响应式：窄屏下图表纵向堆叠。
- 交互控件最小点击区 44px 左右。

## 性能要求

- 前端不要频繁重复请求 `date=all&limit=all`。
- 页面内切员工时，应复用已经拉到的数据，在前端过滤聚合。
- 如数据点太多，前端先做简单 downsample/按天聚合。
- 页面切换/刷新才重新拉接口即可。

## 验收标准

1. 打开：

```text
http://127.0.0.1:8787/#/compactions?qdate=all
```

能看到质量观测 + 员工趋势面板。

2. 切换员工后，图表会变化，且不会重新请求接口很多次。

3. 至少能看到：
   - 上下文 token 趋势
   - 压缩次数标记
   - 输入/输出长度趋势
   - 响应耗时趋势
   - 工具调用趋势
   - 情绪趋势空状态或真实点位

4. 点击趋势图上的点能定位到对应 job。

5. 页面不应该一片灰、不应该遮罩卡死、不应该 console 报错。

6. 跑基础检查：

```bash
cd .pi/extensions/ox-factory
node --check web/app.js
npm test
```

如果你改了 CSS/HTML，也要人工打开页面确认视觉。

## 非目标

- 不需要你改后端 API。
- 不需要你回溯情绪分。
- 不需要你做复杂统计建模或因果判断。
- 不要把这个做成沉重 BI 系统；先让用户能肉眼观察趋势即可。
