# Web Talk 图片输入设计与实现计划

## 目标

让员工 Web 对话框支持粘贴和选择图片，并将图片可靠地送入 Pi、Codex 员工会话。第一版不支持 Claude、Kimi 图片输入；若目标员工使用不支持的后端，发送前返回明确错误。

## 交互

- 输入框旁提供“添加图片”按钮，支持多选。
- 在输入框粘贴图片时自动加入附件。
- 发送前展示缩略图、名称和删除按钮。
- 允许纯图片消息。
- 每条消息最多 6 张，每张最多 10 MiB；仅接受 PNG、JPEG、WebP、GIF，不接受 SVG。
- talk 请求和 job 历史展示附件缩略图。

## 数据与安全

- 浏览器逐张向 `POST /api/talk-attachments` 发送原始二进制，避免 Base64 膨胀 JSONL。
- 服务端通过声明 MIME 和文件魔数双重校验；使用随机 ID 命名，原始文件名只作展示。
- 文件存入 `workersDir/attachments/web-talk/`，元数据写入同目录 sidecar JSON。
- talk 请求只接受已存在的附件 ID，服务端解析为可信元数据；不接受客户端文件路径。
- `GET /api/talk-attachments/:id/content` 用于本地 Web 缩略图。
- 未绑定请求的上传在 24 小时后可被机会式清理；已绑定附件随聊天历史保留。

## 调度链路

1. Web 上传图片并获得附件 ID。
2. `POST /api/talk/:worker` 提交 `message + attachmentIds + mode`。
3. `web-talk-requests.jsonl` 持久化附件元数据。
4. Pi 主进程接管请求，创建带 `attachments` 的 talk job。
5. `SpawnOptions` 向执行后端传递附件：
   - Pi：以 `@绝对路径` CLI file argument 传入，Pi 原生转换为 `ImageContent`。
   - Codex：在 `turn/start` / `turn/steer` 的 input 中加入 `localImage`。
6. Claude/Kimi 目标存在图片时拒绝派发，并说明第一版后端限制。

## 测试顺序

1. 附件存储：格式、魔数、大小、ID/路径安全、绑定状态。
2. web-talk：纯图片请求、附件持久化、非法附件拒绝。
3. Web API：二进制上传、读取、非图片/超限拒绝、后端能力校验。
4. Pi/Codex 参数构造：`@path` 与 `localImage`，含 steer。
5. 前端静态契约：选择、粘贴、缩略图、纯图片发送、历史展示。
6. 全量 `pnpm run verify`。

## 非目标

- 不改当前主工作树，不 reload 或重启正在运行的工厂。
- 第一版不做 Claude/Kimi 原生多模态。
- 第一版不支持在已排队请求中增删图片；编辑文字时附件保持不变。
