# Ox Factory Agent Context

This repository contains the standalone Pi extension for 牛马工厂 / ox-factory.
It is independent from the surrounding `alpha_mind` repository. Treat this
folder as the project root when working on ox-factory.

## Shape

- Main Pi extension entry: `index.ts`
- Runtime worker registry: `registry.ts`
- Worker spawning / worktrees: `spawner.ts`
- Job persistence: `jobs.mjs`
- Communication / permissions: `comm.mjs`, `comm-cli.mjs`
- Token reporting: `token-report.mjs`, `token-report-cli.mjs`
- Daily report context: `report-context.mjs`, `report-sources.mjs`
- Compaction shadow evaluation: `compaction.mjs`, `compaction-report.mjs`
- Project Entity MVP: `projects.mjs`
- Local Web dashboard: `web-server.mjs`, `web/`
- Tests: `test/ox-factory.test.mjs`
- Product/project docs: `docs/`

## Runtime Data Boundary

Do not commit local runtime data from `.pi/workers` unless explicitly requested.
The standalone repo tracks plugin code and product docs. Runtime state such as
jobs, sessions, messages, token logs, compactions, and `projects.jsonl` lives in
the host project's `.pi/workers` directory.

## Common Checks

```bash
node --check projects.mjs
node --check web-server.mjs
node validate-tools.mjs
node --test test/ox-factory.test.mjs
```

`index.ts` is loaded by the Pi runtime; plain Node 18 does not syntax-check `.ts`
files directly. Use `validate-tools.mjs` plus the test suite for routine checks.

## Design Principles

- Keep the plugin lightweight and local-first.
- Prefer append-only JSONL for runtime state that must survive reload.
- Keep long-form truth in Markdown or Feishu docs; store only links and compact
  indexes in structured files.
- Preserve compatibility with old `project: string` jobs and existing worker
  sessions.
- Web dashboard Phase 1 is read-first; avoid adding write operations to the page
  without explicit approval.
