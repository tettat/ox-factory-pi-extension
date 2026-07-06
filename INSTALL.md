# Ox Factory 内网安装指南

本文面向“把牛马工厂插件通过内网 Codebase 分享给朋友”的场景。它不是 npm 包发布流程；当前推荐以 **源码插件** 的方式安装到宿主项目的 `.pi/extensions/ox-factory` 目录。

## 适用范围

- ✅ 内网 Codebase 私有仓库分享。
- ✅ 本地 Pi extension 安装。
- ✅ 本地只读 Web dashboard。
- ✅ Pi 后端员工。
- ✅ 可选 Codex app-server 后端员工。
- ❌ 暂不承诺公开互联网开源所需的彻底脱敏、License、商标和包发布流程。

## 前置条件

| 项目 | 要求 |
| --- | --- |
| Pi CLI | 宿主项目能正常启动 Pi，并能加载 `.pi/extensions/*` |
| Node.js | Node 18+ 可运行本地脚本和 Web dashboard |
| Codex 后端 | 可选；需要 Node 22+ 或运行时提供 global `WebSocket` |
| Git | 用于从 Codebase clone/pull 插件源码 |

> 如果只使用 Pi 后端员工和 Web dashboard，不需要 Codex app-server。

## 全新安装

在你的宿主项目根目录执行：

```bash
cd <host-project>
mkdir -p .pi/extensions
git clone <codebase-repo-url> .pi/extensions/ox-factory
cd .pi/extensions/ox-factory
npm run install-check
npm run verify
```

然后回到宿主项目，重启或 reload Pi：

```bash
cd <host-project>
# 使用你平时启动 Pi 的方式；重点是让 Pi 重新加载 .pi/extensions/ox-factory
pi
```

## 更新已有安装

```bash
cd <host-project>/.pi/extensions/ox-factory
git pull --ff-only
npm run install-check
npm run verify
```

更新后需要重启或 reload Pi，新的工具注册和 TypeScript 入口才会被 Pi 进程加载。

## 启动 Web dashboard

Web dashboard 是本地只读页面，默认读取宿主项目的 `.pi/workers` 运行数据：

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

## Codex 后端可选配置

Codex worker 通过本机 Codex app-server websocket 运行。默认地址：

```text
ws://127.0.0.1:48177
```

可选环境变量见 `.env.example`：

```bash
cp .env.example .env
```

常用变量：

```bash
OX_CODEX_APP_SERVER_URL=ws://127.0.0.1:48177
OX_CODEX_APP_SERVER_CMD=codex
OX_CODEX_SANDBOX=danger-full-access
OX_CODEX_APPROVAL_POLICY=never
```

注意：

- `.env` 已被 `.gitignore` 忽略，不要提交真实 token 或个人配置。
- Codex 后端需要可用的 global `WebSocket`。如果 `npm run install-check -- --codex` 失败，请换 Node 22+ 或使用 Pi/Codex 提供的运行时。
- 只使用 Pi 后端时可以忽略本节。

## 运行数据边界

插件源码在：

```text
<host-project>/.pi/extensions/ox-factory
```

运行数据在：

```text
<host-project>/.pi/workers
```

典型运行数据包括：

- `jobs/`, `events/`
- `sessions/`
- `messages.jsonl`, `permissions.json`
- `responsibilities.jsonl`, `projects.jsonl`
- `compaction-shadow.jsonl`, `compactions/`

这些文件是本地工厂状态，不应该提交进插件仓库。

## 内网分享前检查

维护者在推 Codebase 前建议跑：

```bash
cd <host-project>/.pi/extensions/ox-factory
npm run install-check
npm run verify
git status --short
```

确认：

1. 没有提交 `.pi/workers/`、`.env`、session、rollout、token 数据。
2. 没有真实 `Bearer` / `plat_` / `sk-` / 云厂商 key。
3. README 和本安装文档能说明 clone、verify、reload、web dashboard 的基本路径。
4. 如果只是内网 Codebase 分享，可以保留部分产品讨论文档；如果要公开互联网开源，需要进一步清理内部路径、公司域名、排障细节和真实项目叙事。

## 常见问题

### clone 到别的位置可以吗？

可以作为源码阅读，但 Pi 自动加载通常依赖：

```text
<host-project>/.pi/extensions/ox-factory
```

如果 clone 到别处，请在 `.pi/extensions/ox-factory` 建 symlink，或者复制过去。

### `npm run verify` 能证明 Pi 一定加载成功吗？

不能完全证明。`verify` 覆盖本地 JS 模块、工具名校验和测试；Pi 的 TypeScript extension 入口仍需要通过 reload/restart Pi 做一次实际加载验证。

### Web dashboard 是实时的吗？

不是推送式实时。Web API 是请求时读取本地文件；刷新页面或点击页面刷新按钮后会重新读 `.pi/workers`。

### 会把我的本地 token 分享出去吗？

正常不会。源码仓库不需要携带 `.env`、session、rollout、`.pi/workers` 等本地数据；这些路径已被忽略或明确要求不提交。分享前仍建议跑 `npm run install-check` 和人工 `git diff --cached`。
