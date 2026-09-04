# Web Talk Image Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep image upload independent from inline `@图片N` references while preserving the user-visible relationship between text and uploaded images for Pi and Codex.

**Architecture:** The browser assigns each selected image a readable, stable mention token and sends only tokens that still occur in the message. The server validates those tokens against uploaded attachment IDs and persists them separately as `attachmentMentions`. Codex receives interleaved text and `localImage` inputs; Pi receives images ordered by first mention plus an explicit textual mapping because Pi CLI groups `@file` images outside the prompt text.

**Tech Stack:** Node.js ESM, Pi extension TypeScript-compatible JavaScript, Codex App Server v2 input, vanilla Web UI, Node test runner, pnpm.

---

### Task 1: Define and validate image mention protocol

**Files:**
- Modify: `talk-attachments.mjs`
- Modify: `test/ox-factory.test.mjs`

- [x] Write failing tests for `{ attachmentId, token }` validation, repeated textual references, Codex interleaving, Pi first-reference ordering, and unreferenced-image fallback.
- [x] Run the targeted Node tests and confirm failures are caused by missing mention helpers.
- [x] Implement `normalizeTalkAttachmentMentions`, mention-aware Codex input construction, Pi attachment ordering, and Pi reference mapping.
- [x] Run targeted tests and confirm they pass.

### Task 2: Persist mentions through request, job, queue, and backend dispatch

**Files:**
- Modify: `web-talk.mjs`
- Modify: `web-server.mjs`
- Modify: `jobs.mjs`
- Modify: `index.ts`
- Modify: `spawner.ts`
- Modify: `codex-backend.mjs`
- Modify: `test/ox-factory.test.mjs`

- [x] Write failing tests showing the HTTP request, event-sourced talk request, job serializers, Pi dispatch, Codex start, and Codex steer retain mention metadata.
- [x] Run the targeted tests and confirm the metadata is currently absent.
- [x] Add `attachmentMentions` to request/job/spawn options and validate all referenced IDs belong to the submitted attachments.
- [x] Run targeted tests and confirm they pass.

### Task 3: Add Web `@` selection and positional rendering

**Files:**
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `test/ox-factory.test.mjs`

- [x] Write failing source-contract tests for stable `@图片N` labels, an uploaded-image completion menu, cursor insertion, submission payload, and inline history rendering.
- [x] Run the targeted test and confirm it fails before UI code exists.
- [x] Add the completion menu and clickable preview mention tokens without turning `@` into an upload action.
- [x] Submit mention mappings only for tokens present in the message and render stored tokens as links at their exact text positions.
- [x] Run targeted tests and confirm they pass.

### Task 4: Verify and commit

**Files:**
- Modify: `docs/plans/2026-09-04-web-talk-image-input.md`

- [x] Document upload-versus-mention semantics and the Pi compatibility mapping.
- [x] Run `git diff --check` and `pnpm run verify`; require all tests to pass.
- [x] Review the final diff for accidental main-worktree changes or persisted absolute paths.
- [x] Commit the isolated branch without merging or reloading the active factory.
