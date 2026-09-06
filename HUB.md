# Device Hub

独立的牛马工厂设备/员工目录。Hub 本身不提供第二套仪表盘；原牛马工厂页面会聚合 Hub 中其他设备的员工。不会同步员工 session 或工作目录。

```powershell
.\start-hub.ps1
.\status-hub.ps1
.\stop-hub.ps1
```

生成接入链接：

```powershell
.\new-hub-join-link.ps1
```

把链接发到另一台已经启动牛马工厂的设备上并打开，确认后即可注册。也可以把链接交给该设备上的 agent，让它按链接中的 Hub 配置完成接入。链接包含访问凭证，只能通过可信渠道发送。

agent/终端接入方式：

```powershell
node join-hub.mjs "<接入链接>" "设备显示名"
```

目标设备必须运行包含本功能的最新版牛马工厂。接入链接中的
`127.0.0.1:8787` 指向目标设备自己的工厂页面，因此需要在目标设备上打开。

默认设备名是 Windows 计算机名，可先设置 `$env:OX_FACTORY_DEVICE_NAME='书房电脑'`。Hub 按当前需求监听 `0.0.0.0:8790`，所有目录 API 都需要 `.pi/hub/token` 中的 Bearer Token。

更安全的 Tailscale 方式是让 Hub 改为监听 `127.0.0.1`，再运行 `tailscale serve --bg http://127.0.0.1:8790`。不要使用会公开到互联网的 `tailscale funnel`。即使使用 Tailscale，也保留 Hub 应用层令牌。

当前完成设备注册、心跳、离线判断、员工汇总、接入链接，以及原工厂页面中的跨设备员工展示。跨设备任务队列、逐设备一次性配对凭证和权限角色是下一阶段。
