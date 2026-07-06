# Ox Factory / 牛马工厂 Pi Extension

Ox Factory is a local Pi extension for managing AI workers as a small software
factory: hiring workers, dispatching jobs, tracking output, monitoring token
usage, evaluating compaction, and maintaining lightweight project views.

This repository is intended to be standalone. It may physically live under a
host project's `.pi/extensions/ox-factory` directory, but ox-factory code and
docs should be managed from this folder.

## Quick Install

For internal Codebase sharing, install this repository as source under a host
Pi project:

```bash
cd <host-project>
mkdir -p .pi/extensions
git clone <codebase-repo-url> .pi/extensions/ox-factory
cd .pi/extensions/ox-factory
npm run install-check
npm run verify
```

Then restart or reload Pi from the host project so it loads
`.pi/extensions/ox-factory/index.ts`.

Full installation, update, Web dashboard, Codex backend, and sharing notes:

- [`INSTALL.md`](./INSTALL.md)

## What It Provides

- Worker registry and lifecycle tools: hire, fire, promote, list.
- Pi/Codex worker backends.
- Job store with events, heartbeat, recovery, and attach/watch flows.
- Authorized worker messaging and permission records.
- Daily report context that reads jobs, queue, worker sessions, and main-session
  management events.
- Token reporting for Pi and Codex workers.
- Pi vs Codex shadow compaction evaluation.
- Local read-first Web dashboard.
- Lightweight Project Entity MVP for project metadata, source-of-truth links,
  todos, worktrees, progress, and members.

## Key Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Pi extension tool registration |
| `registry.ts` | Runtime worker registry and restore logic |
| `spawner.ts` | Worker execution and worktree helpers |
| `jobs.mjs` | Job metadata/events store |
| `projects.mjs` | Lightweight Project Entity data layer |
| `responsibilities.mjs` | Worker responsibility data layer |
| `comm.mjs` / `comm-cli.mjs` | Authorized worker communication |
| `token-report.mjs` | Token aggregation |
| `report-context.mjs` | Daily report source aggregation |
| `compaction.mjs` | Compaction shadow evaluation |
| `web-server.mjs` / `web/` | Local dashboard |
| `docs/` | Product docs, trackers, project templates |

## Verification

```bash
npm run install-check
npm run verify
```

Equivalent explicit commands:

```bash
node install-check.mjs
node --check projects.mjs
node --check web-server.mjs
node validate-tools.mjs
node --test test/ox-factory.test.mjs
```

`install-check` validates the local source layout, basic runtime prerequisites,
and obvious token/secret literals. It is intentionally conservative: Pi runtime
loading still requires a real Pi restart/reload smoke.

## Local Web Dashboard

```bash
cd <host-project>
node .pi/extensions/ox-factory/web-server.mjs --workers-dir .pi/workers --port 8787
```

Open:

```text
http://127.0.0.1:8787
```

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
- `compaction-shadow.jsonl`, `compactions/`

Do not commit those runtime files into this repo unless explicitly requested.

## Security / Internal Sharing Notes

- Do not commit `.env`, session files, rollout files, `.pi/workers`, or local
  credential caches.
- `.env.example` documents optional local environment variables; real values
  stay in local shell configuration or an ignored `.env`.
- `package.json` remains `"private": true` because this is currently a source
  Pi extension, not an npm package.
- Internal Codebase sharing is the supported path today. Public open source
  would need a separate license decision and a stronger docs scrub for internal
  paths, domains, and incident notes.

## Project Entity MVP

Project management is deliberately lightweight. The structured layer stores only
necessary indexes and status in `projects.jsonl`; long-form truth stays in docs
or Feishu links.

See:

- `docs/ox-factory-project-entity-design.md`
- `docs/ox-projects/_template.md`
