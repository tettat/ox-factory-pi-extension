# Conversation prefetch (UI 0.7.3)

The signed-in PWA prepares recent conversation content before an employee is
opened. Directory changes schedule unread, recent/favorite, active or previously
tracked conversations across accessible online factories. Historical activity
alone does not warm every employee on a new installation.

## Shared capacity and foreground priority

- One speculative read per page, with a 15-second cooldown after completion
  (60 seconds after a failure). An open chat or outgoing delivery pauses new
  speculation. Opening an in-flight conversation shares its request.
- The Hub admits only one queued/delivering background read per factory across
  all phones. At the next lease, explicit writes take priority over foreground
  reads/read acknowledgements, which take priority over background reads.
  Already executing operations are not cancelled or replayed.
- Background `worker.detail` requests carry `background: true`; capable
  Connectors also receive `preview: true`. Preview skips read-proof generation,
  does not request whole-history receipts, and bounds running process messages.
  Older Connectors receive ordinary reads without `readHistory` instead.
- Running conversations refresh no faster than once a minute, even when job
  heartbeats change their timestamps. Completion can schedule an earlier catch-up.
  Idle, unchanged foreground conversations reuse fresh in-memory results for up
  to a minute; actual changes still trigger a read.
- Background reads never mark anything read. Only opening a visible conversation
  uses the existing whole-history acknowledgement flow. Preview is not a substitute
  for the foreground receipt.

## Cache and accuracy

IndexedDB accumulates fetched text without automatic expiry. RAM keeps a small
hot set; unchanged persisted revisions avoid duplicate background downloads after
reload. Credentials and read-proof tokens are not saved in that database.
Delayed snapshots cannot turn a terminal job back into a running job. The title
indicator compares actual content with the directory, not just the time a fetch
succeeded: stale process content is not displayed as successfully caught up.
Process messages are labelled neutrally; they do not by themselves mean the
employee is still running.

Logout, cache clearing, session changes and loss of device scope invalidate late
reads. Settings provides explicit local history cleanup. Orphaned Connector
receipts for already-pruned commands are acknowledged so they cannot permanently
occupy the outbox ahead of current results.

## Background limits

While the operating system lets the page run, a hidden page checks the directory
every 30 seconds (60 seconds in saving mode). Foreground return, page restoration
and supported resume events catch up. Existing user-visible Web Push also hints
open clients to refresh; no silent push or artificial keepalive is introduced.

A PWA is not a permanently running native process. Browsers may freeze it even
without an explicit close. Continuous downloads while frozen/terminated are not
promised. The service worker is not an unauthenticated private-message cache.

This uses the existing recent `worker.detail` response windows; it is not a full
server-history export. Attachments are not eagerly downloaded. Network/relay
round trips still take time; this change bounds speculative work rather than
claiming instantaneous delivery. Reload old pages when deploying this update:
old clients cannot adopt the new scheduling rules without loading new code.

## Validation

Run `node --test mobile/prefetch.test.mjs mobile/web-state.test.mjs
mobile/cache.test.mjs mobile/mobile.test.mjs` and the full mobile suite. Cover
multiple phone sessions, write/foreground priority, busy-heartbeat throttling,
no read receipts before opening, stale running content followed by final replies,
persistent-cache reload, offline opening, narrow screens and cache-clear races.
