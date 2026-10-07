# Windows Connector service

Run one Connector per enrolled state directory, under the normal account allowed to access that factory. A remote Hub needs no local Hub or inbound port forwarding.

First enroll and verify the foreground process using [the Connector guide](../README.md). Locate Node with `Get-Command node` and confirm 22.12+. Stop only your foreground Connector before handing the same state to a scheduled task. Never delete a live lock or stop another factory process.

## Task Scheduler example

Create a uniquely named task; do not overwrite an existing task. Adapt these example paths:

| Setting | Example |
| --- | --- |
| Program | Absolute path to your `node.exe` |
| Arguments | `"C:\Factory\ox-factory\mobile\cli.mjs" connector --state "C:\Factory\.pi\mobile-remote"` |
| Working directory | `C:\Factory` |
| Identity | Authorized local factory account, ordinary privileges |
| Multiple instances | Do not start a new instance |
| Runtime limit | No maximum execution duration |
| Recovery | Restart after failure, with bounded retries |

Choose triggers for your account and policy. An interactive-only task does not guarantee operation after logout or before login. Enter any password required for a noninteractive task only in the native Windows interface, not source, command arguments or chat. Protect the state directory with Windows ACLs; POSIX `0600` alone does not configure them.

After the deployment terminal closes, run `doctor` on the same state and verify from the phone. Arrange logout/reboot tests separately: a Connector cannot compensate for a stopped factory/Pi control plane. Do not reboot or restart unrelated employees to install it.

Linux/macOS can use their normal process manager with the same absolute-path command, local account, private state and single-instance rules.
