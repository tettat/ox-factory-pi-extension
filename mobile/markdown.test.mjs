import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { markdown, markdownPreview } from './web/ui.js';
import { WEB_ASSETS } from './web-assets.mjs';
const formulas = html => (html.match(/class="katex"/g) || []).length;

test('excessive math stays readable and unclosed delimiters have a bounded scan budget', () => {
  const many = markdown('$x$ '.repeat(105));
  assert.equal(formulas(many), 100); assert.equal((many.match(/class="math-fallback/g) || []).length, 5);
  const malformed = markdown('before ' + '\\('.repeat(20000) + ' after');
  assert.match(malformed, /before/); assert.match(malformed, /after/); assert.equal(formulas(malformed), 0);
  assert.equal(formulas(markdown('$z+1$')), 1); // Budget is per message, not global.
});

test('Markdown preserves heading levels, nested lists, quotes, emphasis and tables', () => {
  const r = markdown('# 一级\n## 二级\n### 三级\n\n1. 第一项\n   - 子项\n     - 孙项\n2. 第二项\n\n> 引用\n>\n> **粗体**、*斜体*、~~删除~~\n\n---\n\n| 名称 | 公式 |\n|:---|---:|\n| 平方 | $x^2$ |');
  for (const pattern of [/<h1>一级/, /<h2>二级/, /<h3>三级/, /<ol>/, /<ul>[\s\S]*<ul>/, /<blockquote>/, /<em>斜体/, /<s>删除/, /<hr>/, /class="md-table"/, /<th style="text-align:right">/]) assert.match(r, pattern);
  assert.equal(formulas(r), 1);
});

test('task checkboxes are read-only display, not factory task controls', () => {
  const r = markdown('- [x] 完成\n- [ ] 待办\n  - [X] 子项');
  assert.equal((r.match(/class="md-task-check"/g) || []).length, 3);
  assert.match(r, /aria-label="已勾选"/); assert.match(r, /aria-label="未勾选"/);
  assert.doesNotMatch(r, /<input|<form|data-task/);
});

test('all four common LaTeX delimiters and explicit math fences render accessible equations', () => {
  const r = markdown(String.raw`行内 $x^2+y^2$ 与 \(\frac{a}{b}\)。

$$
\begin{aligned} E &= mc^2 \\ \int_0^1 x^2\,dx &= \frac{1}{3} \end{aligned}
$$

\[
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\]` + '\n\n```math\n\\sqrt{x}\n```');
  assert.equal(formulas(r), 5); assert.match(r, /<math /); assert.match(r, /encoding="application\/x-tex"/); assert.doesNotMatch(r, /math-fallback/);
});

test('quotes and nested lists can contain block math', () => {
  for (const input of [String.raw`> $$
> \frac{1}{2}
> $$`, String.raw`- 公式

  \[
  x^2 + y^2
  \]`]) assert.equal(formulas(markdown(input)), 1);
});

test('code, escaped dollar signs, money and unfinished streamed formulas stay literal', () => {
  const input = '价格 $20 和 $30。\\$not_math$\n\n`$x$` 和 ``\\(x\\)``\n\n~~~latex\n$$x^2$$\n~~~\n\n    $code$\n\n尚未完整 $a+b';
  const r = markdown(input); assert.equal(formulas(r), 0); assert.match(r, /价格 \$20 和 \$30/); assert.match(r, /<code>\$x\$<\/code>/); assert.match(r, /data-copy-code/); assert.match(r, /\$\$x\^2\$\$/);
});

test('bad formulas and macro loops fail locally without breaking the rest of a message', () => {
  const r = markdown(String.raw`$\notARealCommand{x}$ 后面的文字仍然可读。

$$\def\loop{\loop}\loop$$

正常公式 $x+1$`);
  assert.equal(formulas(r), 1); assert.equal((r.match(/class="math-fallback/g) || []).length, 2); assert.match(r, /后面的文字仍然可读/);
  assert.equal(formulas(markdown('$' + 'x'.repeat(8001) + '$')), 0);
});

test('macro definitions are not shared between messages or formulas', () => {
  markdown(String.raw`$\gdef\evil{owned}\evil$`);
  assert.match(markdown(String.raw`$\evil$`), /math-fallback/);
});

test('Markdown HTML and dangerous links cannot create active elements or remote image requests', () => {
  const r = markdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<iframe src=https://evil.example></iframe>\n[bad](javascript:alert(1))\n![pixel](https://images.example/pixel.png)\nhttps://user:password@example.com\nhttps://example.com/docs');
  assert.doesNotMatch(r, /<script|<img|<iframe|href="javascript:|href="https:\/\/user/);
  assert.match(r, /&lt;script/); assert.match(r, /class="md-image-link"/); assert.match(r, /href="https:\/\/example.com\/docs"/);
});

test('untrusted LaTeX cannot load external resources or inject HTML and styles', () => {
  for (const tex of [String.raw`\href{javascript:alert(1)}{click}`, String.raw`\includegraphics{https://evil.example/pixel.png}`, String.raw`\htmlStyle{background:url(https://evil.example)}{x}`, String.raw`\htmlClass{evil}{x}`]) {
    const r = markdown('$' + tex + '$'); assert.doesNotMatch(r, /<a |<img|style="background|class="evil/);
  }
  assert.doesNotMatch(markdown('$\\bad{<img src=x onerror=alert(1)>}$'), /<img/);
});

test('previews keep a complete formula or fence instead of cutting LaTeX at character 500', () => {
  const input = '开始。\n\n$$\n' + String.raw`\underbrace{a+a+\cdots+a}_{n\text{ terms}}` + ' '.repeat(800) + '\n$$\n\n后面不需要预览';
  const r = markdownPreview(input); assert.equal(formulas(r), 1); assert.doesNotMatch(r, /后面不需要预览/);
  const code = markdownPreview('```js\n' + 'const value = 1;\n'.repeat(70) + '```\n\n后面段落');
  assert.match(code, /<\/code><\/pre>/); assert.doesNotMatch(code, /后面段落/);
});

test('the asset allowlist includes every KaTeX font and every precached rendering dependency', () => {
  const css = readFileSync(new URL('./web/vendor/katex.css', import.meta.url), 'utf8');
  for (const [, font] of css.matchAll(/url\(["']?(fonts\/[^)'"\s]+)["']?\)/g)) assert.ok(WEB_ASSETS.includes('vendor/' + font), font);
  for (const file of WEB_ASSETS) assert.ok(existsSync(new URL('./web/' + file, import.meta.url)), file);
  const c = { self: {} }; vm.runInNewContext(readFileSync(new URL('./web/vendor/precache.js', import.meta.url), 'utf8'), c);
  for (const file of c.self.OX_MARKUP_ASSETS) assert.ok(WEB_ASSETS.includes(file.slice(1)), file);
  assert.ok(WEB_ASSETS.includes('vendor/fonts/KaTeX_Size4-Regular.woff2'));
  assert.doesNotMatch(css, /https?:|\.ttf|\.woff\)/);
});
