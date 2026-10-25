# Conversation prefetch (UI 0.7.2)

The signed-in PWA now warms conversation history before the user opens an
employee. Every successful directory refresh schedules changed conversations
across the accessible online factories. The open chat and unread conversations
come first, followed by recent/favorite, active and historical conversations.

- At most two speculative reads run together. Explicit sends have priority over
  starting more speculative reads. Opening an in-flight read shares the request.
- Revisions use conversation activity, replies, unread counts, jobs and requests;
  directory heartbeats and token counters do not trigger full downloads.
- Unchanged stored revisions survive a page reload. Busy conversations receive
  bounded refreshes; failures back off rather than generating retry storms.
- IndexedDB accumulates fetched history without automatic expiry. RAM retains a
  small hot set. Credentials and read-proof tokens are not persisted there.
- Prefetch is not read acknowledgement. Only a visible, opened conversation
  follows the existing history-acknowledgement rules.
- Logout, cache clearing, session changes and loss of device scope invalidate
  late reads. Settings still provides explicit local history cleanup.

## Background limits

While the operating system lets the page run, a hidden page checks the directory
every 30 seconds (60 seconds in saving mode) and prefetches changed conversations.
Foreground return, page restoration and supported resume events catch up without
requiring a user to open each employee. An existing, user-visible Web Push also
hints open clients to refresh; no silent push, artificial keepalive or new
notification permission is introduced.

A PWA is not a permanently running native process. The browser may freeze even
an app that the user has not explicitly closed. This change does not promise
continuous downloads while frozen or terminated, and does not use the service
worker as an unauthenticated private-message cache.

This uses the existing `worker.detail` response limits; it is not a new full
server-history export, and attachments are not eagerly downloaded.

## Validation

Run `node --test mobile/prefetch.test.mjs mobile/web-state.test.mjs
mobile/cache.test.mjs` and the full mobile suite. Browser validation should cover
unopened conversations receiving a new revision, no read receipts before opening,
persistent-cache reload, offline opening, narrow screens and cache-clear races.
