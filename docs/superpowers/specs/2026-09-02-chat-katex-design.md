# 聊天详情 KaTeX 渲染设计

## 目标

牛马工厂 Web 中所有复用 Markdown 渲染器的消息正文支持本地 LaTeX 排版，不依赖公网，不影响既有 Markdown、代码块或普通文本。

## 范围

支持以下分隔符：

- 行内：$...$、\(...\)
- 块级：$$...$$、\[...\]

代码围栏与行内代码中的分隔符保持原样。KaTeX 无法加载时退化为既有文本展示；单个公式解析失败时保留公式源码，不阻断整条消息。

## 架构

KaTeX 浏览器发行文件与 WOFF2 字体放在 web/vendor/katex/，由现有静态服务器同源提供。新增 web/math-support.js，在 Markdown 处理前扫描文本，把代码区以外的公式替换为不可被 Markdown 规则改写的占位符，调用 katex.renderToString 生成安全 HTML，最后恢复占位符。

web/app.js 的既有 md() 是唯一接入点，因此聊天详情、消息详情、Job 时间线、外包输出等所有使用 mdNode() 的正文都获得一致行为。紧凑预览继续以纯文本为主，不依赖公式布局。

## 安全与可用性

KaTeX 使用 trust: false、throwOnError: false 和 output: htmlAndMathml。原始 HTML 仍由现有 Markdown 渲染器转义；公式渲染只接收 TeX 字符串。块级公式允许横向滚动，避免撑破详情面板。

## 验证

自动化测试覆盖四种分隔符、代码区跳过、公式占位避免 Markdown 斜体误解析、解析异常隔离、静态资源接线和字体资源存在性。完成后运行 pnpm verify，并用独立端口启动 Web 服务检查 KaTeX 静态资源及浏览器渲染。
