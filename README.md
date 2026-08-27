# Ox Factory / 牛马工厂 Pi Extension

Ox Factory is a local Pi extension for managing AI workers as a small software
factory: hiring workers, dispatching jobs, tracking output, monitoring token
usage, evaluating compaction, and maintaining lightweight project views.

This repository is intended to be standalone. It may physically live under a
host project's `.pi/extensions/ox-factory` directory, but ox-factory code and
docs should be managed from this folder.

## Quick Install

Recommended one-command setup from the host project where you run Pi:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/tettat/ox-factory-pi-extension/main/scripts/install.sh)"
```

The script will:

1. check whether the `pi` CLI is installed;
2. ask whether to install the extension for the current project or globally;
3. optionally configure the main Pi agent to use the official DeepSeek API
   (`deepseek-v4-pro` by default) if you paste an API key.

Manual source install is still supported:

```bash
cd <host-project>
pi install https://github.com/tettat/ox-factory-pi-extension.git --local --approve
```

Then restart or reload Pi from the host project so it loads
the extension.

Full installation, update, Web dashboard, DeepSeek, Codex backend, and sharing
notes:

- [`INSTALL.md`](./INSTALL.md)

## What It Provides

- Worker registry and lifecycle tools: hire, fire, promote, list.
- Pi/Codex worker backends.
- Job store with events, heartbeat, recovery, and attach/watch flows.
- Authorized worker messaging and permission records.
- A factory-wide task board shared by humans and workers, with free-form Kanban
  states, one-shot scheduling, assignment, child tasks, and execution evidence.
- Daily report context that reads jobs, queue, worker sessions, and main-session
  management events.
- Token reporting for Pi and Codex workers.
- Pi vs Codex shadow compaction evaluation.
- Local Web collaboration dashboard with read-first operations and task-board writes.
- Lightweight Project Entity MVP for project metadata, source-of-truth links,
  todos, worktrees, progress, and members.

## Key Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Pi extension tool registration |
| `registry.ts` | Runtime worker registry and restore logic |
| `spawner.ts` | Worker execution and worktree helpers |
| `jobs.mjs` | Job metadata/events store |
| `task-board.mjs` / `task-dispatcher.mjs` | Global task ledger and idempotent assignment bridge |
| `projects.mjs` | Lightweight Project Entity data layer |
| `responsibilities.mjs` | Worker responsibility data layer |
| `comm.mjs` / `comm-cli.mjs` | Authorized worker communication |
| `token-report.mjs` | Token aggregation |
| `report-context.mjs` | Daily report source aggregation |
| `compaction.mjs` | Compaction shadow evaluation |
| `web-server.mjs` / `web/` | Local dashboard |
| `docs/` | Product docs, trackers, project templates |

## Verification

If you are developing the extension locally:

```bash
pnpm run install-check
pnpm run verify
```

Equivalent explicit commands:

```bash
node install-check.mjs
node --check projects.mjs
node --check web-server.mjs
node --check web/app.js
bash -n scripts/install.sh
node validate-tools.mjs
node --test test/ox-factory.test.mjs
```

`install-check` validates the local source layout, basic runtime prerequisites,
and obvious token/secret literals. It is intentionally conservative: Pi runtime
loading still requires a real Pi restart/reload smoke.

## Local Web Dashboard

Inside Pi, use the extension command:

```text
/ox-web
```

It checks whether the local dashboard is already running, starts
`web-server.mjs` when needed, and opens `http://127.0.0.1:8787`.

Useful variants:

```text
/ox-web --status
/ox-web --no-open
/ox-web 8799
```

Manual fallback:

```bash
cd <host-project>
node .pi/extensions/ox-factory/web-server.mjs --workers-dir .pi/workers --port 8787
```

Open:

```text
http://127.0.0.1:8787
```

### Factory task board

Open `http://127.0.0.1:8787/#/tasks` for the factory-wide Kanban board. It
shows every unarchived task by default; `project`, human-visible `status`,
assignee, priority, execution state, text, and archive visibility are filters
over the same shared ledger. A status is free text, so moving or editing a task
to `设计中`, `待验收`, or another new value creates that visible column without
registering a workflow first.

The Web API is rooted at `/api/factory-tasks`:

- `GET /api/factory-tasks` and `GET /api/factory-tasks/:id`
- `POST /api/factory-tasks` and `PATCH /api/factory-tasks/:id`
- `POST /api/factory-tasks/:id/split`
- `POST /api/factory-tasks/:id/archive` or `/restore`
- `POST /api/factory-tasks/:id/run`

Humans can create, edit, drag, split, run/stop, archive, and restore tasks in Web.
On a new card, selecting an assignee enables immediate dispatch by default;
uncheck it to record ownership only, or set `triggerAt` for delayed dispatch.
Workers receive the matching `factory_task_create`, `factory_task_list`,
`factory_task_get`, `factory_task_update`, `factory_task_split`,
`factory_task_archive`, and `factory_task_run` tools. Assignments still require
the existing `work:assign` permission. The older `factory_task_assign` tool is
compatible and now creates a board record before dispatching.

`status` is the human workflow state and is never overwritten by job completion.
`execution.state` is the fixed dispatcher state (`idle`, `scheduled`,
`dispatching`, `queued`, `running`, `succeeded`, `failed`, or `cancelled`).
Request ID, job ID, summary/error, revisions, and events are retained as
evidence. The low-level worker request audit remains available at
`#/task-requests`.

One-shot `triggerAt` tasks are checked by the local Web process and dispatched
through the same Pi worker-task request/job path as immediate assignment—there
is no OS cron or alternate execution environment. Startup recovery is delayed
and batched to avoid a task storm. These controls can be tuned with:

- `OX_FACTORY_TASK_SCHEDULER_GRACE_MS` (default `15000`)
- `OX_FACTORY_TASK_SCHEDULER_JITTER_MS` (default `15000`)
- `OX_FACTORY_TASK_SCHEDULER_INTERVAL_MS` (default `5000`)
- `OX_FACTORY_TASK_SCHEDULER_BATCH_SIZE` (default `5`)

Task events are appended to `<workers-dir>/factory-tasks.jsonl`; per-task locks
live under `<workers-dir>/.locks/factory-tasks/`. Keep the Web process running
for on-time triggers. If it is stopped, overdue work is recovered after the next
start's grace and jitter window. Repeating schedules continue to use the
existing schedule feature.

## Model Backends

- **Pi backend / DeepSeek**: the one-click installer can write
  `~/.pi/agent/auth.json` and `~/.pi/agent/settings.json` so the main Pi agent
  uses the official DeepSeek API. It preserves existing provider settings.
- **Codex app-server backend**: optional worker backend for Codex-powered
  employees. See [`INSTALL.md`](./INSTALL.md#codex-app-server-后端可选配置).

## Runtime Data

Runtime files are intentionally outside this standalone repository, usually in
the host project:

```text
<host-project>/.pi/workers/
```

Examples:

- `jobs/`, `events/`
- `sessions/`
- `messages.jsonl`, `permissions.json`
- `responsibilities.jsonl`
- `projects.jsonl`
- `factory-tasks.jsonl`, `.locks/factory-tasks/`
- `compaction-shadow.jsonl`, `compactions/`

Do not commit those runtime files into this repo unless explicitly requested.

## Security / Sharing Notes

- Do not commit `.env`, session files, rollout files, `.pi/workers`, or local
  credential caches.
- `.env.example` documents optional local environment variables; real values
  stay in local shell configuration or an ignored `.env`.
- `package.json` remains `"private": true` because this is currently a source
  Pi extension, not an npm package.
- The installer never prints your API key. It stores DeepSeek credentials in
  Pi's normal local agent config (`~/.pi/agent/auth.json`).

## Project Entity MVP

Project management is deliberately lightweight. The structured layer stores only
necessary indexes and status in `projects.jsonl`; long-form truth stays in docs
or Feishu links.

See:

- `docs/ox-factory-project-entity-design.md`
- `docs/ox-projects/_template.md`
