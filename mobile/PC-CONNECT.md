# PC 接入同一个 Cloudflare / HTTPS Hub

适用于**已有本机工厂**、要连接管理员现有 Hub 的另一台电脑。无需部署第二个 Hub、开放公网端口、复制员工会话或复制另一台设备的凭据。Hub 必须支持可信设备目录与 peer-command；本文配套版本已经包含该协议。

## 1. 更新源码，确认本机工厂

更新实际使用的源码副本，不要覆盖有未提交修改的目录，也不要用 `reset --hard`。

```sh
git pull --ff-only
npm ci --ignore-scripts --omit=dev --prefix mobile
```

Node 需要 **22.12+**。运行目录、模型认证、`.pi/workers` 属于宿主项目，不在公开仓库内。`mobile/` 位于**源码根目录**，不是宿主目录下随意新建的同名文件夹。

若旧 Web 已在运行，保存配置不等于自动加载新 JS 模块。由设备管理员按安全维护流程加载新版 **Web**；无需重启 Pi/员工。`/api/device-peer/status` 为 404 表示仍是旧 Web。不要为更新整体停止工厂。

## 2. 在已登录的所有者页面生成接入码

打开管理员提供的 **同一个 Hub 地址** → **设置 / 连接与偏好** → **连接另一台工厂电脑** → **生成设备接入码**。

接入码 10 分钟有效、一次性使用，保存到新电脑的私有文本文件。不要写进命令行、Git、聊天记录或日志；这是设备接入码，**不是人工登录密码或“添加另一台手机”的配对码**。在接入完成前不要退出生成它的所有者会话。

## 3. 在新电脑注册自己的设备身份

下面在**源码根目录**执行。把尖括号参数替换成真实值；宿主 workers 目录必须已经存在。选择新的私密状态目录，不覆盖原 Netlify/其他 Hub 身份。

```sh
node mobile/cli.mjs enroll --hub "https://YOUR-HUB.example.com" --state "<HOST>/.pi/mobile-cf" --workers "<HOST>/.pi/workers" --factory "http://127.0.0.1:8787" --actor "用户" --name "另一台电脑" --code-file "<PRIVATE>/device-code.txt"
node mobile/pc-cli.mjs use --workers "<HOST>/.pi/workers" --config "<HOST>/.pi/mobile-cf/connector-config.json"
node mobile/cli.mjs connector --state "<HOST>/.pi/mobile-cf"
```

`--actor` 必须是该工厂已有且获准的本机人类身份；若不是“用户”，请改为实际身份。此操作不会新增员工通信/派活授权。若该电脑已经以**自己的身份**接入此 Hub，不重复 enroll，只选择已有配置并确保唯一 Connector 在运行。

Windows 私密目录须用账户 ACL 保护；仅 `0600` 标记不能代替 ACL。初次验收可以保留 Connector 终端，随后用该电脑既有的任务计划程序/systemd 等正式托管。每个身份只运行一个 Connector；不要在已有常驻实例旁再开一个。接入码成功消费后删除临时码文件。

如果服务使用 `--runtime-state`，PC 必须选择同一目录：

```sh
node mobile/pc-cli.mjs use --workers "<HOST>/.pi/workers" --config "<CONFIG>/connector-config.json" --runtime-state "<RUNTIME>"
```

## 4. 分别授权两个方向

两台设备均在 Hub 在线后，在所有者页面 **可信工厂设备** 设置：

- 本机 → 另一台：查看，或查看/对话/派活。
- 另一台 → 本机：同样单独确认。

授权是单向的；未授权时目录不会泄露其他工厂员工。接入和所有者登录不等于设备之间自动互信。目标工厂仍检查原员工 `message:send` / `work:assign` 权限。

## 5. 验收

```sh
node mobile/pc-cli.mjs status --workers "<HOST>/.pi/workers"
```

应看到正确 `hub`、`directoryFresh:true`，双向授权后两边均能看到 `local:false` 的设备。此命令是只读诊断，不输出凭据。

在本机 Web 打开 `/api/device-peer/status` 核对正在运行的服务；再检查 `/api/device-peer/directory` 能拿到 Hub 实时目录。它们只接受本机浏览器/终端，不应暴露公网。员工页将聚合有来源设备标签的远端员工，详情可读取对话、发送文本、派活。先只读验收，再由用户做一条真实任务的接收和结果回流验证。

当前不等于“远端工厂全部页面统一切换”，也**没有**员工自动 `@设备/员工` 跨机协作工具；附件和任意远程 shell 不在此功能内。回执完成表示投递完成，不等于模型工作完成；超时不要换新 ID 重发。

## 切换、失效与回退

- PC 在宿主 `.pi/mobile-pc.json` 保存**配置文件路径**和 Hub 地址，不复制密码、device credential 或模型账号。
- 一次显式 `pc-cli use` 同时选择目录和调用出口。目录超过 30 秒、Hub/设备身份不符、配置损坏时，不偷偷切回 Netlify 或旧局域网 Hub。
- 没有显式选择时，兼容自动识别 `.pi/mobile-cloudflare`，再识别旧 `.pi/mobile-netlify`；自定义状态目录必须显式选择。
- 撤销某方向授权后，不再允许新操作；已被目标员工接收的任务不会被强行停止。回退只重新选择该电脑自己的旧 Connector，不覆盖旧身份或重放旧队列。
- 本文不绑定作者的真实域名、电脑路径或密码。接入现有 Hub 时，不运行 `init` / `hub-init` 创建第二套所有者。
