import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const mathSource = readFileSync(new URL("../web/math-support.js", import.meta.url), "utf8");

function loadMath() {
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(mathSource, context, { filename: "web/math-support.js" });
  return context.OxMath;
}

function prepare(input, { failOn = null } = {}) {
  const calls = [];
  const katex = {
    renderToString(tex, options) {
      calls.push({ tex, options });
      if (tex === failOn) throw new Error("bad formula");
      return '<span class="katex" data-tex="' + tex + '" data-display="' + String(options.displayMode) + '"></span>';
    },
  };
  const result = loadMath().prepare(input, katex);
  return { calls, result, html: result.restore(result.text) };
}

test("math support renders inline dollar and parenthesis delimiters", () => {
  const { calls, result, html } = prepare("before $a_i$ and \\(b^2\\) after");

  assert.deepEqual(calls.map((call) => call.tex), ["a_i", "b^2"]);
  assert.deepEqual(calls.map((call) => call.options.displayMode), [false, false]);
  assert.match(result.text, /OXMATH/);
  assert.doesNotMatch(result.text, /a_i|b\^2/);
  assert.match(html, /md__math--inline/);
  assert.match(html, /data-tex="a_i"/);
  assert.match(html, /data-tex="b\^2"/);
});

test("math support renders multiline display delimiters", () => {
  const source = ["$$", "\\\\int_0^1 x^2 dx", "$$", "\\[y = mx + b\\]"].join("\n");
  const { calls, html } = prepare(source);

  assert.deepEqual(calls.map((call) => call.tex), ["\\\\int_0^1 x^2 dx", "y = mx + b"]);
  assert.deepEqual(calls.map((call) => call.options.displayMode), [true, true]);
  assert.equal(calls.every((call) => call.options.throwOnError === false), true);
  assert.equal(calls.every((call) => call.options.trust === false), true);
  assert.equal(calls.every((call) => call.options.output === "htmlAndMathml"), true);
  assert.match(html, /md__math--display/);
});

test("math support leaves fenced and inline code untouched", () => {
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const source = [tick + "$inline$" + tick, fence + "tex", "$$fenced$$", fence, "$real$"].join("\n");
  const { calls, html } = prepare(source);

  assert.deepEqual(calls.map((call) => call.tex), ["real"]);
  assert.match(html, /\$inline\$/);
  assert.match(html, /\$\$fenced\$\$/);
  assert.match(html, /data-tex="real"/);
});

test("math support preserves a failing formula without aborting other math", () => {
  const { calls, html } = prepare("$bad$ and $good$", { failOn: "bad" });

  assert.deepEqual(calls.map((call) => call.tex), ["bad", "good"]);
  assert.match(html, /md__math-error/);
  assert.match(html, /\$bad\$/);
  assert.match(html, /data-tex="good"/);
});

test("math support is an identity fallback when KaTeX is unavailable", () => {
  const math = loadMath();
  const result = math.prepare("$a_i$", null);

  assert.equal(result.text, "$a_i$");
  assert.equal(result.restore("<p>$a_i$</p>"), "<p>$a_i$</p>");
});

test("dashboard markdown routes detailed content through math protection", () => {
  const appSource = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const styleSource = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /globalThis\.OxMath\.prepare\(source,\s*globalThis\.katex\)/);
  assert.match(appSource, /math\.restore\(out\.join\("\\n"\)\)/);
  assert.match(styleSource, /\.md__math--display\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(styleSource, /\.md__math-error\s*\{/);
});

test("vendored KaTeX emits HTML and MathML through the math bridge", () => {
  const context = { console };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  const katexSource = readFileSync(new URL("../web/vendor/katex/katex.min.js", import.meta.url), "utf8");
  vm.runInNewContext(katexSource, context, { filename: "web/vendor/katex/katex.min.js" });
  vm.runInNewContext(mathSource, context, { filename: "web/math-support.js" });

  const prepared = context.OxMath.prepare("$e^{i\\pi}+1=0$", context.katex);
  const html = prepared.restore(prepared.text);

  assert.equal(context.katex.version, "0.18.5");
  assert.match(html, /class="katex-mathml"/);
  assert.match(html, /class="katex-html"/);
  assert.match(html, /md__math--inline/);
});
