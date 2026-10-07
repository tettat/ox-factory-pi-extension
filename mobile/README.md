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
- Shared project views and task boards, token summaries, attachments, reading mode and in-page nonblocking submission.
- Scoped roles, one-time enrollment, revocation, reconnect and deduplication; optional Web Push.
- No arbitrary shell, file browser, workspace switching or direct model app-server access.

A receipt is not a completed job. In-page navigation can preserve a submission; a closed or OS-suspended browser cannot be guaranteed to finish an unaccepted request. Polling is not a latency guarantee. Business API responses are not cached by the PWA.

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
