# Ox Factory Project Entity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight Project entity to ox-factory for project metadata, source-of-truth links, todos, worktrees, progress, and personnel.

**Architecture:** Store project state as append-only JSONL events in `.pi/workers/projects.jsonl`. Build current project snapshots by replaying events, similar to responsibilities/messages. Expose MVP through `factory_project_*` tools; Web visualization is out of scope for this implementation.

**Tech Stack:** Node.js ESM modules, Pi extension TypeScript tool registration, `node:test` tests.

---

### Task 1: Project store module

**Files:**
- Create: `.pi/extensions/ox-factory/projects.mjs`
- Test: `.pi/extensions/ox-factory/test/ox-factory.test.mjs`

- [x] Implement append-only event helpers: project upsert, todo set, worktree set, progress add, member set.
- [x] Implement project snapshot replay and markdown formatters.
- [x] Add tests for upsert, alias resolution, todo/worktree/member/progress snapshots.

### Task 2: Pi tools

**Files:**
- Modify: `.pi/extensions/ox-factory/index.ts`
- Test: `.pi/extensions/ox-factory/validate-tools.mjs`

- [x] Import project store helpers.
- [x] Register `factory_project_upsert`, `factory_project_list`, `factory_project_todo_set`, `factory_project_worktree_set`, `factory_project_progress_add`, `factory_project_member_set`.
- [x] Keep tool names provider-safe.

### Task 3: Docs and tracker

**Files:**
- Create: `docs/ox-factory-project-entity-design.md`
- Create: `docs/ox-projects/README.md`
- Create: `docs/ox-projects/_template.md`
- Modify: `docs/ox-factory-improvement-tracker.md`
- Modify: `docs/ox-factory-quality-checklist.md`

- [x] Document lightweight Project entity scope and non-goals.
- [x] Add project doc template for human-readable source of truth.
- [x] Mark OF-002 as in-progress MVP.

### Task 4: Verification

**Commands:**
- `node --check .pi/extensions/ox-factory/projects.mjs`
- `node .pi/extensions/ox-factory/validate-tools.mjs`
- `node --test .pi/extensions/ox-factory/test/ox-factory.test.mjs`

- [x] Verify syntax, tool names, and test suite.
