# Authenticated remote desktop (Windows)

The mobile **电脑 → 远程桌面** page displays the currently logged-in primary
desktop, including ordinary Chrome windows and other applications. Existing
Chrome/CDP controls remain separate. This is not a CAPTCHA or website verification
bypass. Lock screens, UAC secure desktops, audio and multi-monitor selection are
not supported by this first user-mode release.

## Connection model

`Phone/noVNC → WSS relay → outbound Desktop Agent → 127.0.0.1 VNC`

- Use the existing Hub session, device scope and Connector identity. Desktop
  tickets have a separate namespace/audience from browser tickets. Short connect
  window, single-connection binding and renewable 30-second authorization leases.
- Explicit **local** desktop grants are also required; pairing a phone does not
  automatically enable desktop sharing on every factory computer.
- The first connection is view-only. “开始控制” obtains a fresh control ticket.
  Local RFB parsing enforces read-only access independently of browser UI flags.
- Only one phone can connect per desktop. Another phone cannot silently take over.
- Local VNC authentication stays on the computer. The phone never receives the
  VNC password. The outer authenticated WSS stream contains an RFB None handshake;
  this does **not** mean the local VNC server is unauthenticated.
- Clipboard, files, desktop resizing and vendor commands are filtered out.
  Pixels/input are not stored in Hub state, relay storage or service-worker cache.
  Relay socket attachments contain temporary authorization metadata, not images.
- TLS protects both network hops. The relay operator is trusted; this transport
  does not claim end-to-end encryption against the relay operator.

## Enable on an owned Windows computer

Install Node 22.12+ and the normal factory Connector first. In `mobile/`, run
`npm ci`. Use the same Hub/relay deployment as the browser feature, with its
updated Worker configuration (`DesktopRelay`, migration `v2`). Self-hosted
`browser-relay-node.mjs` also provides `/desktop`; proxy WebSocket upgrades over
HTTPS. Do not publish a VNC port or permit arbitrary relay destinations.

1. Download portable **UltraVNC 1.8.3.0** from the
   [official release](https://uvnc.com/downloads/ultravnc/172-ultravnc-1-8-3-0.html).
   Verify the publisher's SHA-256 for `UltraVNC_1830.zip`:
   `11163a0b9b86321bf6403eb0cf84b81f7230ce32e6291377e1fe5beb987f7e4f`.
   Extract the x64 `winvnc.exe`, `ddengine64.dll`, `vnchooks.dll`, `logging.dll`
   and `logmessages.dll` into a private local directory. Check the executable's
   Authenticode signature. Vendor binaries are not included in this repository.
2. From the factory source root, replacing the example paths:

   ```powershell
   node mobile/desktop-cli.mjs init --connector-config "PRIVATE_CONNECTOR_CONFIG" --vnc "PRIVATE_VNC_DIRECTORY/winvnc.exe"
   node mobile/desktop-cli.mjs agent
   ```

   Default private state is `.pi/mobile-desktop`; `--state` changes it. `init`
   grants the existing local owner principals desktop control explicitly, creates
   a random local-only VNC password, restricts directory permissions and refuses
   to replace existing authorization. No hard-coded computer paths or credentials
   are required. A normal phone/PC trust is insufficient without this local step.

3. The supervisor launches its own user-mode VNC with an explicit private INI,
   loopback-only port 5907 (`init --port` can change it), no HTTP server, no file
   transfer, no recording and no desktop/wallpaper changes. It verifies all listener
   addresses/ports for its child process before joining the relay. It never stops
   existing factory processes or VNC services. A port conflict fails closed.
4. For persistence use a **current-user, interactive, Limited** Windows scheduled
   task that runs `desktop-cli.mjs agent`, starts at that user's logon and restarts
   on failure. Run background PowerShell wrappers hidden. Do not install this as
   SYSTEM or disable UAC/firewall/security checks. The user must be logged in.
5. On the phone select that computer, then **电脑 → 远程桌面 → 连接桌面**.
   Tap **开始控制** to send input. Portrait fits the screen height with horizontal
   panning; landscape fits the full desktop. Fit/zoom/pan are local viewing operations;
   the PC resolution is unchanged. In 平移 mode drag/pinch the viewport; in
   点击 mode noVNC handles touch input. 键盘 sends text/shortcuts, not clipboard.

## Disable and revoke

```powershell
node mobile/desktop-cli.mjs disable
node mobile/desktop-cli.mjs status
```

Local disable/grant removal disconnects an active desktop within 5 seconds.
Stop only the dedicated desktop scheduled task to stop its supervisor/VNC child.
Hub logout or session/device revocation terminates the renewable relay lease within
30 seconds (plus provider scheduling delays); there is no indefinitely valid ticket.
Closed connections release held keys/buttons and never replay input. A hidden phone
page disconnects. Reconnection is explicit and defaults to view-only.

Do not commit `.pi`, INI/password files, executable downloads, desktop screenshots,
provider configuration or QA authentication state. Disable provider request logging
for this relay and never log WebSocket protocol headers/tickets or binary payloads.

## Tests and client licensing

`npm --prefix mobile test` covers tickets, CSRF/CAS, revocation, cross-audience and
cross-peer isolation, stream filtering, clipboard blocking and read-only input.
`npm --prefix mobile run build:markup` bundles the pinned noVNC 1.7.0 client locally.
Its MPL-2.0 and bundled third-party notices are in `web/vendor/DESKTOP-LICENSES.txt`;
the UI links to the corresponding unmodified upstream source. No external CDN is
needed. Modern mobile browsers with ES2022 modules are required for this feature.
