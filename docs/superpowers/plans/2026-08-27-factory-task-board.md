# Factory-wide Task Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable factory-wide Kanban board that humans and workers can edit, and dispatch immediate or scheduled assignments through the existing Pi worker-job path without cron.

**Architecture:** `task-board.mjs` owns append-only task events, projections, per-task locks, free-form display statuses, revisions, and execution evidence. `task-dispatcher.mjs` idempotently bridges due tasks into existing worker task requests; Web owns delayed/batched due scans, while Pi continues to own permission checks and actual worker jobs. The existing dependency-free Web UI turns `#/tasks` into a responsive board and keeps `/api/task-requests` as the low-level audit trail.

**Tech Stack:** Node.js ESM/TypeScript Pi extension, append-only JSONL, native HTTP server, dependency-free HTML/CSS/JavaScript, Node test runner.

---

### Task 1: Durable task domain

**Files:**
- Create: `task-board.mjs`
- Create: `test/factory-task-board.test.mjs`

- [ ] Write failing tests for creation, free-form status updates, revision conflicts, filters, splitting, archive/restore, event history, and stale dispatch lease recovery.
- [ ] Run `node --test --test-name-pattern="factory task board" test/ox-factory.test.mjs` and confirm failure because `task-board.mjs` does not exist.
- [ ] Implement JSONL projection, validation, per-task atomic locks, CRUD/split/archive APIs, status derivation, and execution transitions.
- [ ] Re-run the targeted tests and confirm they pass.
- [ ] Commit `task-board.mjs` and tests as `feat: add durable factory task board store`.

### Task 2: Idempotent dispatch bridge

**Files:**
- Create: `task-dispatcher.mjs`
- Modify: `task-requests.mjs`
- Modify: `test/factory-task-board.test.mjs`

- [ ] Write failing tests showing one due task creates exactly one request per `executionKey`, repeated scans are no-ops, expired leases recover, future tasks remain scheduled, and request records preserve `factoryTaskId`.
- [ ] Run the targeted task-dispatch tests and confirm expected failures.
- [ ] Extend worker task request metadata without changing existing request semantics; implement due selection and idempotent request creation.
- [ ] Re-run task-board/task-dispatch tests and all task-request tests.
- [ ] Commit as `feat: dispatch due board tasks through worker requests`.

### Task 3: Pi job lifecycle and Agent tools

**Files:**
- Modify: `index.ts`
- Modify: `factory-handbook.mjs`
- Modify: `package.json`
- Modify: `test/factory-task-board.test.mjs`
- Modify: `test/ox-factory.test.mjs`

- [ ] Write failing source/behavior tests for task tools, assignment compatibility, permission checks, board task ID in worker prompts, accepted job linkage, and terminal execution evidence.
- [ ] Run targeted tests and confirm they fail for missing registrations/integration.
- [ ] Register create/list/get/update/split/archive/run tools; adapt `factory_task_assign` to create a board task and dispatch it; write request/job lifecycle back to the task store.
- [ ] Document task-board CLI/tool usage in the worker handbook and add new modules to `pnpm run check`.
- [ ] Run targeted tests and `pnpm run check`.
- [ ] Commit as `feat: expose task board to factory workers`.

### Task 4: Web API and scheduler

**Files:**
- Modify: `web-server.mjs`
- Modify: `test/factory-task-board.test.mjs`

- [ ] Write failing HTTP/store tests for list/detail/create/update/split/archive/run endpoints, 409 revision conflicts, server-side filters, and delayed/batched scheduler behavior.
- [ ] Run targeted Web API tests and confirm expected failures.
- [ ] Add `/api/factory-tasks` routes and handlers, trusted-local validation, worker existence/assignment permission checks, and an exported scheduler controller with grace, jitter, interval, and batch limits.
- [ ] Start the scheduler only from `main()`, unref timers, and stop timers during graceful shutdown so imports/tests remain side-effect free.
- [ ] Run targeted Web tests and `node --check web-server.mjs`.
- [ ] Commit as `feat: add task board web api and scheduler`.

### Task 5: Kanban Web UI

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `test/factory-task-board.test.mjs`
- Modify: `test/ox-factory.test.mjs`

- [ ] Write failing static contract tests for visible board navigation, free-form status columns, project/status/assignee/archive filters, drag/drop revision update, create/edit/run/split/archive actions, keyboard-accessible status editing, and responsive styles.
- [ ] Run targeted UI tests and confirm expected failures.
- [ ] Replace `renderTaskRequests` at `#/tasks` with global board rendering; preserve low-level request drawer under `#/task-requests/:id`.
- [ ] Implement task detail/create forms in the existing drawer, explicit loading/error feedback, drag/drop with revision conflicts, and accessible filter controls.
- [ ] Add responsive Kanban styling using existing design tokens, visible focus states, reduced-motion handling, and mobile column layout.
- [ ] Run `node --check web/app.js` and targeted UI tests.
- [ ] Commit as `feat(web): add factory task kanban board`.

### Task 6: Recovery, performance, and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `test/factory-task-board.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-27-factory-task-board-design.md` only if implementation facts require clarification

- [ ] Add a temporary-directory integration test covering create → scheduled dispatch scan → worker request link → simulated accepted/running/terminal evidence, including a repeated scan assertion.
- [ ] Document board URLs, agent tools, storage file, scheduler environment variables, one-shot scheduling, and the separation between display/execution status.
- [ ] Run `git diff --check`, `pnpm run check`, and `pnpm test` and fix every failure.
- [ ] Start `web-server.mjs` against a fresh temp workers directory and use HTTP requests to smoke-test board create/list/update/split/archive without touching the real factory directory.
- [ ] Review the spec requirement-by-requirement and record any residual limitations in the final report.
- [ ] Commit as `docs: document factory task board operations`.

## Self-review

- **Spec coverage:** storage, free-form statuses, global/project-filtered board, CRUD/split/archive, assignment, scheduled dispatch, lease/idempotency, request/job evidence, Web UX, compatibility, and clean verification all map to explicit tasks.
- **No placeholders:** each implementation task names concrete files, target behavior, test command, and commit boundary.
- **Type consistency:** the plan consistently uses `status` for the human field, `execution.state` for machine state, `factoryTaskId` for cross-record linkage, `executionKey` for idempotency, and `revision` for concurrency.
