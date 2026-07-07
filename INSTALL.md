# Ox Factory 安装指南

Ox Factory / 牛马工厂是一个 **源码型 Pi extension**。推荐通过 `pi install`
安装，不需要 npm 发布，也不需要把你的 `.pi/workers` 运行数据放进仓库。

## 最快路径：一键安装

在你平时运行 Pi 的项目目录执行：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/tettat/ox-factory-pi-extension/main/scripts/install.sh)"
```

脚本会做三件事：

1. 检查本机有没有 `pi` 命令；没有就停止并提示你先安装 Pi。
2. 询问安装范围：
   - **当前目录 / 当前 Pi 项目**（推荐）：写入当前项目的 Pi 配置，不影响其它项目；
   - **全局安装**：所有 Pi 项目都能加载这个插件。
3. 询问是否配置 DeepSeek 官方 API：如果你粘贴 API Key，脚本会把主 agent
   默认模型设置成 `deepseek / deepseek-v4-pro / high`。

脚本不会打印 API Key；凭证写入 Pi 本地配置：

```text
~/.pi/agent/auth.json
~/.pi/agent/settings.json
```

非交互环境也可以这样跑：

```bash
OX_FACTORY_INSTALL_SCOPE=local \
DEEPSEEK_API_KEY="你的 DeepSeek API Key" \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/tettat/ox-factory-pi-extension/main/scripts/install.sh)"
```

如需跳过 DeepSeek：

```bash
OX_FACTORY_SKIP_DEEPSEEK=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/tettat/ox-factory-pi-extension/main/scripts/install.sh)"
```

安装结束后，重启或 reload Pi，然后在 Pi 里输入：

```text
/ox-web
```

## 手动安装

当前项目安装：

```bash
cd <host-project>
pi install https://github.com/tettat/ox-factory-pi-extension.git --local --approve
```

全局安装：

```bash
pi install https://github.com/tettat/ox-factory-pi-extension.git --approve
```

如果你是维护者，想直接 clone 源码开发：

```bash
git clone https://github.com/tettat/ox-factory-pi-extension.git
cd ox-factory-pi-extension
npm run install-check
npm run verify
```

开发完再在宿主项目中用 `pi install <本地路径> --local --approve` 或保留源码
extension 目录均可；具体取决于你的 Pi 插件加载方式。

## DeepSeek 官方 API 配置

一键脚本会自动写入 Pi 的标准 agent 配置。如果想手动配置，可以确认这两个文件：

`~/.pi/agent/auth.json`：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "你的 DeepSeek API Key"
  }
}
```

`~/.pi/agent/settings.json`：

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-pro",
  "defaultThinkingLevel": "high"
}
```

如果你的 Pi 版本支持环境变量，也可以临时使用：

```bash
export DEEPSEEK_API_KEY="你的 DeepSeek API Key"
pi
```

但长期使用更推荐写入 Pi 本地配置文件。

## 启动 Web dashboard

Web dashboard 是本地只读页面，默认读取宿主项目的 `.pi/workers` 运行数据。

推荐在 Pi 里直接执行：

```text
/ox-web
```

它会：

1. 检查 `http://127.0.0.1:8787/api/health` 是否已经是 ox-factory dashboard；
2. 如果没启动，后台启动 `web-server.mjs`；
3. 通过系统浏览器打开 `http://127.0.0.1:8787`；
4. 日志写到 `.pi/workers/web-server-8787.log`。

常用变体：

```text
/ox-web --status      # 只检查状态，不启动
/ox-web --no-open     # 启动/复用服务，但不打开浏览器
/ox-web 8799          # 使用其它端口
```

手动兜底方式：

```bash
cd <host-project>
node .pi/extensions/ox-factory/web-server.mjs \
  --workers-dir .pi/workers \
  --port 8787
```

浏览器打开：

```text
http://127.0.0.1:8787
```

常用 smoke：

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/overview
```

## Codex app-server 后端可选配置

只使用 Pi 后端员工时可以忽略本节。

Codex worker 通过本机 Codex app-server websocket 运行。默认地址：

```text
ws://127.0.0.1:48177
```

常用环境变量见 `.env.example`：

```bash
cp .env.example .env
```

```bash
OX_CODEX_APP_SERVER_URL=ws://127.0.0.1:48177
OX_CODEX_APP_SERVER_CMD=codex
OX_CODEX_SANDBOX=danger-full-access
OX_CODEX_APPROVAL_POLICY=never
```

注意：

- `.env` 已被 `.gitignore` 忽略，不要提交真实 token 或个人配置。
- Codex 后端需要可用的 global `WebSocket`。如果
  `npm run install-check -- --codex` 失败，请换 Node 22+ 或使用 Pi/Codex
  提供的运行时。
- Codex 后端员工是可选能力；DeepSeek/Pi 后端不依赖它。

## 运行数据边界

插件源码通常由 Pi 管理；运行数据在宿主项目：

```text
<host-project>/.pi/workers
```

典型运行数据包括：

- `jobs/`, `events/`
- `sessions/`
- `messages.jsonl`, `permissions.json`
- `responsibilities.jsonl`
- `projects.jsonl`
- `compaction-shadow.jsonl`, `compactions/`

这些文件是本地工厂状态，不应该提交进插件仓库。

## 维护者发布前检查

```bash
npm run install-check
npm run verify
git status --short
```

确认：

1. 没有提交 `.pi/workers/`、`.env`、session、rollout、token 数据。
2. 没有真实 `Bearer` / `plat_` / `sk-` / 云厂商 key。
3. README 和本安装文档能说明一键安装、手动安装、reload、Web dashboard、
   DeepSeek 和 Codex 后端的基本路径。

## 常见问题

### `npm run verify` 能证明 Pi 一定加载成功吗？

不能完全证明。`verify` 覆盖本地 JS 模块、工具名校验和测试；Pi 的
TypeScript extension 入口仍需要通过 reload/restart Pi 做一次实际加载验证。

### Web dashboard 是实时的吗？

不是推送式实时。Web API 是请求时读取本地文件；刷新页面、点击页面刷新按钮、
或切换 token 日期/趋势筛选时会重新读 `.pi/workers`。

### 会把我的本地 token 分享出去吗？

正常不会。源码仓库不需要携带 `.env`、session、rollout、`.pi/workers` 等本地数据；这些路径已被忽略或明确要求不提交。分享前仍建议跑 `npm run install-check` 和人工 `git diff --cached`。
