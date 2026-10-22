# 手机接管电脑 Chrome

需要 Node 22.12+，已接入 Hub 的工厂，以及 Chrome。这个功能只共享**明确登记的调试 Chrome**，不接管普通 Chrome，不共享系统桌面。

## 员工怎么打开浏览器

在安装本项目的目录执行：

```sh
npm ci --prefix mobile
# 管理员首次启用：使用这台工厂已经存在的私密 Connector 配置
node mobile/browser-cli.mjs init --connector-config /path/to/private/connector-config.json
# 由任务计划程序 / systemd 等管理这个独立出站进程
node mobile/browser-cli.mjs agent
```

保持 agent 常驻后，员工随时运行：

```sh
node mobile/browser-cli.mjs launch --name "工作浏览器" --url https://example.com
```

命令返回实例 ID。关闭后要保留该实例的登录状态，或在运行中的同一实例添加标签页：

```sh
node mobile/browser-cli.mjs status
node mobile/browser-cli.mjs launch --id chrome_RETURNED_ID --url https://example.com
```

- 每个新实例使用 `.pi/mobile-browser/profiles/` 下独立、持久化的 profile，**不会读取或复制普通 Chrome 的 profile**。普通 Chrome 已登录的账号不会自动带过来。
- Chrome 136+ 的远程调试需要非默认用户目录；本启动器已处理。参见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。
- `--chrome /path/to/chrome` 可指定可执行文件；自动查找 Windows、macOS、Linux 的常见路径。`--headless true` 仅用于无人值守浏览器。
- 所有命令可加 `--state /path/to/private/browser-state`，必须保持一致。默认是**当前工作目录**下的 `.pi/mobile-browser`，服务工作目录不能随意改变。
- `register --name 名称 --endpoint http://127.0.0.1:9222` 可登记自己已开启调试的 Chrome。只接受字面量 IPv4 回环地址，且绑定浏览器 ID，端口被其他进程复用不会悄悄换成别人的浏览器。外部登记的实例重启后应重新登记。
- `unregister --id chrome_ID` 只移除共享登记，不关闭 Chrome、不删除 profile。不得把调试端口监听到公网、局域网或做端口转发。

## 手机上怎么用

登录原来的牛马工厂手机网页，选择工厂，进入 **电脑**：

1. 竖向查看实例 → 窗口 → 标签页。普通网页和空白页可共享；`chrome://`、扩展、文件页面不开放。
2. 默认 **查看**：单指平移画面；双指缩放。竖屏默认按高度适配，可横向拖到页面右边；横屏默认完整适配。点 **网址**（或顶部地址）即可直接打开其他网页，无需切换操作模式；可输入 `example.com`，自动补全 HTTPS，也可勾选 **在新标签页打开**。
3. 点 **开始操作**：轻点点击，单指滑动滚动网页；双指仍然只平移/缩放画面。通过手机点击打开的新标签页会自动跟随，不需要退回列表寻找；不会跟随无关的电脑标签页。点 **退出操作** 恢复平移查看。
4. 先点电脑输入框，再打开 **键盘**，中文整段提交；只有电脑确认收到后才清空草稿。回车是单独按钮，不会自动提交网页表单。
5. 前进、后退、刷新和打开网址都是独立的明确操作，不依赖新鲜截图；暂停时也能打开新网址并恢复取图。支持显式在电脑激活标签页、画质选择、暂停、适配和放大（更多菜单）。网页加载失败时仍可修改网址。

画面过期或网络中断时禁止点击。连接恢复不重发旧操作，默认恢复为查看模式。后台暂停取图，离开页面关闭通道；画面不写入手机聊天缓存或 Service Worker。

0.6.1 的打开网址/新标签页修复需要同时更新前端、browser agent 和浏览器中继。只更新前端而保留旧中继会拒绝新的导航请求；原工厂 Pi/Web/Connector 不需要重启。

这是低帧率网页远控，不是视频直播或系统远程桌面。浏览器菜单、系统文件选择框、下载管理、音频、剪贴板、拖放文件不支持。每台工厂同时允许一台手机进入电脑页面，避免互相抢控制。标签页列表目前手动刷新。

## 中继部署

图片不经过工厂命令队列，也不写 Hub 的持久存储：

```text
手机 ← HTTPS / WSS → 浏览器中继 ← 出站 WSS → 本机 browser agent → 回环 CDP → Chrome
              原 Hub 继续处理登录、权限、短期通道票据和撤销
```

### Cloudflare Workers + Durable Objects

1. 安装/登录 Wrangler；复制 `browser-relay/wrangler.toml` 到私密部署配置，设置自己的 Worker 名称、`HUB_ORIGIN`、`PHONE_ORIGIN`（精确 HTTPS origin，不带末尾 `/`）。主文件路径指向 `browser-relay/worker.mjs`。
2. `wrangler deploy --config /path/to/private/wrangler.toml`，记录中继 HTTPS origin。日志默认关闭；不要额外开启记录请求头、截图或输入文字的日志。
3. 自托管 Hub：在现有 Hub 配置添加 `browserRelay: "https://your-relay.example.com"`，按自己的维护方式更新 Hub，**不要重新初始化状态**。
4. Netlify 一体式 Hub：代码构建时传入 `browserRelay`，部署到已有站点、已有 Function 和 Blobs store：

```js
import { prepareNetlifyHub } from './mobile/netlify-hub.mjs';
prepareNetlifyHub({
  output: 'output/mobile-browser-release',
  origin: 'https://your-owned-site.netlify.app',
  siteId: 'YOUR-EXISTING-SITE-UUID',
  browserRelay: 'https://your-relay.example.com',
});
```

构建器同时添加精确 WSS CSP 白名单。若前端单独部署，调用 `prepareNetlify({output,hubOrigin,browserRelay})`，手机 origin 必须匹配中继的 `PHONE_ORIGIN`。现有非 Netlify 反向代理也需允许新增的 `/connector/browser-*` 和 `/api/browser-ticket` 路由。

### 换到自己的服务器

可直接使用同协议 Node 中继，不需要改手机交互或 CDP driver：

```sh
OX_BROWSER_HUB=https://hub.example.com OX_BROWSER_PHONE_ORIGIN=https://phone.example.com node mobile/browser-relay-node.mjs
```

默认只监听 `127.0.0.1:8793`。用你自己的 HTTPS 反向代理转发 `/connect` 的 WebSocket upgrade，`/health` 做健康检查；不要记录 `Sec-WebSocket-Protocol`。更新 Hub 的 `browserRelay` 和前端 CSP 后重新构建/部署。切换会断开旧浏览器通道，但不会重发点击，也不影响普通工厂命令队列。

## 常驻与授权

- browser agent 是**独立组件**，不需要重启原 Pi、Web、Codex、Connector。不要只靠临时终端承诺常驻。
- Windows 可建一个独立的当前用户计划任务：运行 Node 绝对路径 + `mobile/browser-cli.mjs agent --state ...`；工作目录为项目目录，登录触发、重复实例 IgnoreNew、运行不限时、失败重试。交互登录模式只保证该用户已登录时可用；不要为此重启电脑验收。
- Linux 可用独立 user systemd service，配置 `WorkingDirectory`、`ExecStart`、`Restart=on-failure`。不要用 root 开启带个人登录态的 Chrome。
- `.pi/mobile-browser/health.json` 仅用于本机诊断；检查最近心跳和 `connected`，不能只看进程存在。
- `init` 仅为原 Connector 的 owner 生成显式 `control` 本地授权。其他账号没有自动浏览器权限。需要只读/操作账号时，由电脑管理员编辑私密 `config.json` 的 `grants`：`principal_id: "view"` 或 `"control"`。仍同时受 Connector 原 grant、Hub 手机角色和设备范围限制；viewer 永远不能操作。
- 停用：将本地浏览器配置 `enabled` 改为 `false` 后立即拒绝后续浏览器请求，再通过你创建的服务管理器停止**这个 browser agent**；不要杀所有 Node 或 Chrome。
- `.pi/`、浏览器 profile、Connector 配置、tickets、Cookie、账号登录态都不可提交到 GitHub或部署前端。限制状态目录为当前获准本机账号访问。

## 安全与性能边界

- 手机不持有设备密钥，不开放原始 CDP、`Runtime.evaluate`、文件读写或 Cookie 导出 API。
- 票据 60 秒内连接、绑定一个连接，最长 15 分钟；使用 WebSocket 子协议传递，不放 URL。
- 中继每约 20 秒向原 Hub 检查角色/设备/会话，最长 30 秒租约，到期拒绝转发；撤销不是瞬时取消已经执行的点击。Hub 暂不可用时 fail closed。
- TLS 在中继终止，**不是端到端加密**。中继是受信基础设施；截图与输入只在内存转发，不写应用持久存储。
- 原网页的内容、账号登录态和网页内敏感操作都会对获授权远控者开放。只在共享 Chrome 中登录适合远控的账号。
- 默认按需 JPEG 取图，不堆积帧；网络慢时自动降低实际帧率。画质太大降到省流，暂停/后台不传新画面。实际延迟取决于 Chrome、电脑上行、中继线路和手机网络，不能承诺视频级流畅。
- 为避免后台标签页截屏卡住，观看期间临时启用低分辨率本地 screencast 帮助 Chrome 渲染；该流不上传，空闲 5 秒停止，实际上传仍是受限截图。

## 验收

```sh
npm run check --prefix mobile
npm test --prefix mobile
```

使用隔离 Chrome/测试网页验证：实例与标签页、横竖屏、缩放/平移、点击/中文/滚动、只读、断线不重发、跨设备/跨源拒绝、撤销与票据过期。最后还需用实际手机蜂窝网络测试所在地到中继的线路；桌面模拟视口不是实机网络验收。
