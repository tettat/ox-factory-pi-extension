# Mobile Hub and Connector

The PWA lets an authorized phone or browser operate multiple local Ox Factory installations. Each factory computer runs its own outbound Connector. Adding a computer does not require another Hub, inbound port forwarding, or copying an existing computer's credentials.

```
Phone browser → HTTPS Hub ← outbound Connector ← local factory
```

The local factory remains the source of employees, permissions, jobs, projects and conversations. Enrollment does not migrate those records between computers.

## Connect another factory computer

Requirements: Node.js **22.12+**, a running local factory/Pi control plane, its local Web dashboard, and an owner login to the existing Hub. Configure model credentials locally on the new computer, never through Git.

From the new factory's **host project directory**, clone this repository into `ox-factory` if needed:

```sh
git clone https://github.com/tettat/ox-factory-pi-extension.git ox-factory
pi install ./ox-factory --local --approve
npm ci --ignore-scripts --omit=dev --prefix ox-factory/mobile
```

Start/reload Pi on that new computer and use `/ox-web`. The host's `.pi/workers` directory must exist before enrollment. If the repository is elsewhere, replace the `ox-factory/` code prefix below; point `--workers` at the actual running factory.

1. Open the existing phone page: **Settings → Connect another factory computer → Generate device enrollment code**. The code is one-time and expires after 10 minutes.
2. Save it using a text editor in a private local file, for example `.pi/private/enrollment.txt`. Keep the issuing phone signed in until enrollment completes. Do not put the code into shell arguments, screenshots or Git.
3. Replace the example Hub URL and device name:

```sh
node ox-factory/mobile/cli.mjs enroll --state .pi/mobile-remote --hub https://hub.example.com --code-file .pi/private/enrollment.txt --actor 用户 --name Second-factory --workers .pi/workers --factory http://127.0.0.1:8787
node ox-factory/mobile/cli.mjs connector --state .pi/mobile-remote
```

Leave the second command running. In another terminal in the same host directory:

```sh
node ox-factory/mobile/cli.mjs doctor --state .pi/mobile-remote
```

`ready=true` checks the Hub, local factory and fresh Connector heartbeat. Select the new device on the phone and verify an authorized conversation and result. The explicit `--actor` binds remote actions to a local human identity; it does not grant employee permissions.

For continuous operation use a process manager; see [Windows Connector service](deploy/WINDOWS-SERVICE.md). Closing a foreground terminal stops that Connector. A sleeping or powered-off computer cannot run its employees.

**Do not run `init`/`hub-init` to add a device. Do not copy another computer's configuration or `.pi` directory.** An existing Connector state is not overwritten. If remote enrollment succeeded but the local response was lost, inspect/revoke the incomplete device before creating another code.

## Add a phone or browser

Open the existing Hub HTTPS URL and use its configured login or a fresh owner invitation. A device that only accesses an existing factory does not need a Connector.

## Features and limits

- Device/employee directories, conversations, steering/queued messages, assignments and receipts.
- Shared desktop/mobile read state: employee unread badges and a single history acknowledgement when opening a conversation, using the selected factory's existing read ledger. No read-state labels inside messages or unread counters on the overview.
- Persistent local conversation text, cache-first reopening and an explicit clear-cache control; animated compose options with reduced-motion support.
- Shared project views and task boards, token summaries, attachments, reading mode and in-page nonblocking submission.
- Scoped roles, one-time enrollment, revocation, reconnect and deduplication; optional Web Push.
- No arbitrary shell, file browser, workspace switching or direct model app-server access.

A receipt is not a completed job. In-page navigation can preserve a submission; a closed or OS-suspended browser cannot be guaranteed to finish an unaccepted request. Polling is not a latency guarantee. The service worker caches only the public app shell; conversation text uses a separate local database as described below.

### Read-state synchronization

Update both the Hub and each factory's Connector to enable `read-history-v1`; existing logins and device identities remain unchanged. No desktop core migration is required. Counters follow the connected desktop version (newer desktops emphasize finished unread jobs). Older Connectors continue to serve conversations but need updating for history acknowledgement.

Opening an employee conversation or its full result in the foreground as an owner/operator acknowledges all history captured for that employee, including older rows outside the display window. One small signed receipt covers the batch, not one request per message. Later arrivals remain unread until a fresh active view; background prefetches and cached text alone do not mark unseen newer versions. Desktop reads appear on the next phone refresh; phone reads appear on the next desktop refresh. These are shared factory read markers, not sender delivery receipts or per-phone private read histories.

Read synchronization runs quietly in the background, does not create tasks/activity receipts, and does not block navigation or message submission. Errors retry with backoff without adding read/sync labels to message details. Read-only viewers see the employee counters but cannot change them. Offline or suspended pages do not acknowledge automatically.

### Local conversation storage

Already loaded conversation text accumulates in IndexedDB, scoped by Hub principal, device and employee. Reopening first displays the saved text while fetching fresh content; a smaller recent server window does not delete older saved rows. The UI shows recent messages first and pages through older local rows. This is not a full download of all server archives or tool logs; images and authentication/read tokens are excluded.

The app applies no time-based expiry. **Settings → Local data → Clear chat cache** removes this browser's stored text without deleting factory messages or changing read markers. Logging out retains this text for the same account; clear it before leaving a shared device. Browser storage can still be evicted by the OS, private mode or the user's browser cleanup. Restricted/full storage reports a warning rather than claiming persistence.

### Project documents

The project overview and **Documents and links** tab expose registered resources prominently. HTTP(S) links open normally; registered Markdown references can be read through the existing desktop `/api/project-doc` allowlist when the Connector advertises `project.doc`. Arbitrary file paths and unregistered references are rejected. Other document formats still require the desktop or their registered web link. Project metadata and documents remain read-only.

### Markdown and formulas

Conversations, full results and project documents share Markdown rendering: headings, nested lists, read-only task lists, tables, quotes, emphasis, links and fenced code. Wide tables, code and formulas scroll within the message instead of widening the screen. Code blocks have a copy button; copying the whole message preserves its original Markdown/LaTeX text. Long-message previews end at a complete block rather than cutting a formula or fence in half.

Use `$...$` or `\(...\)` for inline math, and `$$...$$`, `\[...\]` or a fenced `math` block for display math. KaTeX supports common fractions, integrals, matrices and aligned equations, not arbitrary LaTeX documents/packages. Unsupported, excessive or unfinished expressions remain readable source text; code blocks and escaped dollar signs stay literal. Formula rendering and fonts are bundled on the same origin and precached with the public app shell, without a CDN. No Connector upgrade is needed for this presentation-only feature.

Browser assets are committed, so ordinary installs need no frontend build. To rebuild after an intentional dependency update, use `npm ci --ignore-scripts --prefix mobile` and `npm run build:markup --prefix mobile`; commit the generated assets, font allowlist and preserved dependency licenses together. Run `npm run check --prefix mobile` and `npm test --prefix mobile` before publishing.

## Run a separate Hub

Skip this when joining an existing Hub. For a new self-hosted Hub behind trusted HTTPS:

```sh
npm ci --ignore-scripts --omit=dev --prefix mobile
node mobile/cli.mjs hub-init --state /var/lib/ox-mobile --origin https://hub.example.com --name Main-factory
node mobile/cli.mjs hub --state /var/lib/ox-mobile
```

Adapt the [systemd](deploy/ox-mobile-hub.service) and [Caddy](deploy/Caddyfile.example) examples. The Node Hub listens on loopback. Never expose the raw factory Web dashboard or model app-server. Do not overwrite state or stop unrelated services to free a port.

Initialization produces private management, bootstrap and pairing files. Transfer the first device's bootstrap privately, then use `connector-import --bootstrap-file <private-file> --state <new-state> --actor <local-human> --workers <workers-dir>`. Keep all identity and configuration files out of Git. Subsequent computers use enrollment above. See [security boundaries](SECURITY.md) and [Netlify modes](NETLIFY.md).

## Develop and package

From the repository root:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix mobile
npm run verify
node mobile/release.mjs output/mobile-release
```

Tests use temporary synthetic factories. DOM tests use the declared root `jsdom` dev dependency, not another project checkout. Two POSIX executable-fixture tests are explicitly skipped on Windows.

The release command creates a code-only Hub/Connector bundle with a SHA-256 manifest, **not** a replacement for installing the full factory. It uses this repository's module layout and excludes runtime identities, private operating notes and local QA scripts.

## 手机接管电脑 Chrome（0.6）

已授权的手机可以查看登记过的 Chrome 实例、窗口与标签页，缩放/平移画面，并点击、滚动、输入中文。只处理独立 profile 的调试 Chrome，不接管普通浏览器。安装、员工启动命令、Cloudflare/自托管中继及安全边界见 [BROWSER.md](BROWSER.md)。

## 手机远程桌面

手机版新增 **电脑 → 远程桌面**，使用现有 Hub 认证控制本机正常桌面。
独立启用、不影响原工厂或 Chrome；部署、授权、撤销与限制见 [DESKTOP.md](DESKTOP.md)。
