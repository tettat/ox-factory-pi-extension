# Chat KaTeX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Render inline and display LaTeX in Ox Factory Web message details with a fully local KaTeX runtime.

**Architecture:** A browser helper protects TeX regions before the existing Markdown parser runs, renders each protected region through the locally vendored KaTeX browser API, and restores the generated HTML afterward. Existing mdNode() call sites remain unchanged, so every detailed message surface gets the same behavior.

**Tech Stack:** Vanilla JavaScript, KaTeX browser distribution, Node test runner, pnpm.

---

## File Structure

- Create web/math-support.js: delimiter scanner, code-region protection, KaTeX rendering adapter, browser global API.
- Create web/vendor/katex/: pinned KaTeX JS, CSS, license, and WOFF2 fonts.
- Modify web/index.html: load local KaTeX CSS/JS and the math helper before app.js.
- Modify web/app.js: prepare and restore math around the existing Markdown renderer.
- Modify web/styles.css: constrain display equations inside cards and drawers.
- Create test/web-math-support.test.mjs: behavioral tests for delimiter parsing and graceful failure.
- Modify test/ox-factory.test.mjs: integration assertions for static asset wiring.
- Modify web/README.md: document supported message math syntax and local dependency.

### Task 1: Math parsing contract

**Files:**
- Create: test/web-math-support.test.mjs
- Create: web/math-support.js

- [ ] **Step 1: Write failing tests**

Create tests that evaluate web/math-support.js in a Node VM with a fake katex.renderToString and assert all four delimiters render, fenced and inline code are skipped, and formulas become protected placeholders before Markdown runs.

- [ ] **Step 2: Run the focused test and verify RED**

Run: node --test test/web-math-support.test.mjs

Expected: FAIL because web/math-support.js does not exist.

- [ ] **Step 3: Implement the minimal scanner**

Expose globalThis.OxMath.prepare(text, katexApi). It returns an object with text and restore(html), recognizes the four approved delimiters, skips fenced and inline code, and calls renderToString with displayMode, throwOnError false, strict warn, trust false, and output htmlAndMathml.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: node --test test/web-math-support.test.mjs

Expected: PASS with no warnings.

### Task 2: Local KaTeX assets and page wiring

**Files:**
- Create: web/vendor/katex/katex.min.js
- Create: web/vendor/katex/katex.min.css
- Create: web/vendor/katex/LICENSE
- Create: web/vendor/katex/fonts/*.woff2
- Modify: web/index.html
- Modify: test/ox-factory.test.mjs

- [ ] **Step 1: Add failing integration assertions**

Assert that web/index.html loads local KaTeX CSS, KaTeX JS, and math-support.js before app.js; assert the referenced files and at least one KaTeX WOFF2 font exist.

- [ ] **Step 2: Run the focused integration test and verify RED**

Run: node --test --test-name-pattern="web markdown loads local KaTeX" test/ox-factory.test.mjs

Expected: FAIL because the assets and tags are absent.

- [ ] **Step 3: Vendor pinned KaTeX assets**

Use pnpm pack katex at the resolved version in a temporary directory, copy dist/katex.min.js, dist/katex.min.css, dist/fonts/*.woff2, and LICENSE into web/vendor/katex/, then load CSS, KaTeX JS, math-support.js, and app.js in that order.

- [ ] **Step 4: Run the integration test and verify GREEN**

Run the same focused command and expect PASS.

### Task 3: Markdown integration and layout

**Files:**
- Modify: web/app.js
- Modify: web/styles.css
- Modify: test/web-math-support.test.mjs

- [ ] **Step 1: Add failing integration assertions**

Assert the app prepares math before line parsing and restores formula HTML after Markdown assembly. Assert CSS defines md__math--display with horizontal overflow protection.

- [ ] **Step 2: Run focused tests and verify RED**

Run: node --test test/web-math-support.test.mjs

Expected: FAIL because app.js and styles.css are not wired.

- [ ] **Step 3: Integrate at the single Markdown boundary**

At the beginning of md() prepare math from the original source; parse prepared.text; after joining Markdown output call prepared.restore(html). Wrap KaTeX output with md__math--inline or md__math--display.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused command and expect PASS.

### Task 4: Documentation and complete verification

**Files:**
- Modify: web/README.md

- [ ] **Step 1: Document syntax and fallback**

Record the four delimiters, local asset policy, code-region behavior, and graceful fallback.

- [ ] **Step 2: Run syntax and complete verification**

Run node --check web/math-support.js, node --check web/app.js, and pnpm verify.

Expected: all commands exit 0 and the full test suite reports zero failures.

- [ ] **Step 3: Smoke-test the static runtime**

Start the worktree server on an unused loopback port with a temporary workers directory. Verify index.html, math-support.js, KaTeX JS, CSS, and one font return HTTP 200, then inspect a browser-rendered formula.

- [ ] **Step 4: Commit implementation**

Stage docs/superpowers, web, and test, then commit with message feat(web): render chat formulas with local KaTeX.
