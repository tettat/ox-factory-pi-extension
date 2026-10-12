import { MarkdownIt, katex } from './vendor/markdown-engine.js';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false, maxNesting: 30 });
const escape = md.utils.escapeHtml;
const safeLink = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
md.validateLink = value => Boolean(safeLink(value));
md.linkify.set({ fuzzyEmail: false, fuzzyLink: false });
const linkMatches = md.linkify.match.bind(md.linkify);
md.linkify.match = source => {
  const matches = linkMatches(source);
  return matches?.filter(m => {
    // Linkify may stop at ":" in a credential-bearing URL. Validate the whole
    // visible URL, not the misleading "https://username" prefix it found.
    const raw = source.slice(m.index).match(/^https?:\/\/[^\s<>()[\]]+/i)?.[0];
    return !raw || Boolean(safeLink(raw));
  }) || null;
};
const linkAtStart = md.linkify.matchAtStart.bind(md.linkify);
md.linkify.matchAtStart = source => {
  const raw = source.match(/^https?:\/\/[^\s<>()[\]]+/i)?.[0];
  return raw && !safeLink(raw) ? null : linkAtStart(source);
};
md.renderer.rules.link_open = (tokens, i, options, env, renderer) => {
  tokens[i].attrSet('target', '_blank'); tokens[i].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, i, options);
};
// Remote Markdown images remain explicit links, not invisible tracking requests.
md.renderer.rules.image = (tokens, i) => {
  const t = tokens[i], href = safeLink(t.attrGet('src')), label = escape(t.content || '查看图片');
  return href ? `<a class="md-image-link" href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : label;
};
md.renderer.rules.table_open = () => '<div class="md-table" role="region" aria-label="表格，可横向滚动" tabindex="0"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
function codeBlock(content, language = '') {
  return `<div class="code-block"><div class="code-head"><span>${escape(language || '代码')}</span><button type="button" data-copy-code>复制代码</button></div><pre tabindex="0"><code>${escape(content)}</code></pre></div>\n`;
}
md.renderer.rules.fence = (tokens, i, options, env) => tokens[i].info.trim() === 'math'
  ? math(tokens[i].content, true, env)
  : codeBlock(tokens[i].content, tokens[i].info.trim().split(/\s+/)[0].slice(0, 40));
md.renderer.rules.code_block = (tokens, i) => codeBlock(tokens[i].content);

function math(tex, display, env = {}, raw = display ? `\\[${tex}\\]` : `\\(${tex}\\)`) {
  const fallback = () => `<span class="math-fallback ${display ? 'math-block' : ''}" title="暂不能排版，保留公式原文">${escape(raw)}</span>`;
  env.formulas = (env.formulas || 0) + 1;
  if (tex.length > 8000 || env.formulas > 100) return fallback();
  try {
    const result = katex.renderToString(tex, { displayMode: display, output: 'htmlAndMathml', throwOnError: true, strict: 'ignore', trust: false, maxExpand: 500, maxSize: 12, macros: {} });
    return `<span class="math-formula ${display ? 'math-block' : 'math-inline'}">${result}</span>`;
  } catch { return fallback(); } // Neither errors nor formula input are HTML.
}
function escaped(source, pos) { let n = 0; while (pos > 0 && source[--pos] === '\\') n++; return n % 2 === 1; }
function closing(source, from, delimiter, multiline, env) {
  const limit = Math.min(source.length, from + 32000);
  // Repeated unclosed delimiters must not trigger quadratic rescans on a phone.
  env.mathScanned ||= 0;
  for (let i = from; i < limit; i++) {
    if (++env.mathScanned > 1_000_000) return -1;
    if (!multiline && source[i] === '\n') return -1;
    if (!source.startsWith(delimiter, i) || escaped(source, i)) continue;
    if (delimiter === '$' && (source[i-1] === '$' || source[i+1] === '$' || /\s/.test(source[i-1] || '') || /\d/.test(source[i+1] || ''))) return -1;
    return i;
  }
  return -1;
}
md.inline.ruler.before('escape', 'ox_math', (state, silent) => {
  const source = state.src, pos = state.pos;
  let open, close, display = false;
  if (source.startsWith('$$', pos)) { open = close = '$$'; display = true; }
  else if (source.startsWith('\\[', pos)) { open = '\\['; close = '\\]'; display = true; }
  else if (source.startsWith('\\(', pos)) { open = '\\('; close = '\\)'; }
  else if (source[pos] === '$' && source[pos-1] !== '$' && !/\s/.test(source[pos+1] || '') && !/^\$\d[\d,.]*[。，；！？]/.test(source.slice(pos))) open = close = '$';
  if (!open) return false;
  const end = closing(source, pos + open.length, close, display, state.env);
  if (end === -1 || !source.slice(pos + open.length, end).trim()) return false;
  if (!silent) { const token = state.push('ox_math', '', 0); token.content = source.slice(pos + open.length, end); token.meta = { display, raw: source.slice(pos, end + close.length) }; }
  state.pos = end + close.length; return true;
});
md.renderer.rules.ox_math = (tokens, i, options, env) => math(tokens[i].content, tokens[i].meta.display, env, tokens[i].meta.raw);
md.block.ruler.before('fence', 'ox_math_block', (state, start, end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  const open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : '';
  if (!open) return false;
  const close = open === '$$' ? '$$' : '\\]', lines = [];
  for (let line = start; line < Math.min(end, start + 200); line++) {
    if (line > start && state.sCount[line] < state.blkIndent) return false;
    const text = line === start ? first.slice(open.length) : state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    const stop = closing(text, 0, close, true, state.env);
    if (stop >= 0) {
      if (text.slice(stop + close.length).trim()) return false;
      lines.push(text.slice(0, stop)); if (!lines.join('\n').trim()) return false;
      if (silent) return true;
      const token = state.push('ox_math_block', '', 0); token.block = true; token.map = [start, line + 1]; token.content = lines.join('\n').trim();
      state.line = line + 1; return true;
    }
    lines.push(text);
  }
  return false;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.ox_math_block = (tokens, i, options, env) => math(tokens[i].content, true, env) + '\n';
md.core.ruler.after('inline', 'ox_task_lists', state => {
  state.tokens.forEach((t, i, ts) => {
    if (t.type !== 'inline' || ts[i-1]?.type !== 'paragraph_open' || ts[i-2]?.type !== 'list_item_open') return;
    const first = t.children?.[0], match = first?.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) return;
    const checked = match[1] !== ' '; first.content = first.content.slice(match[0].length);
    const token = new state.Token('html_inline', '', 0);
    token.content = `<span class="md-task-check" role="img" aria-label="${checked ? '已勾选' : '未勾选'}">${checked ? '☑' : '☐'}</span> `;
    t.children.unshift(token); ts[i-2].attrJoin('class', 'md-task-item');
  });
});

const cache = new Map(); let cachedChars = 0;
export function renderMarkdown(input, preview = false) {
  const source = String(input || '').replace(/\r\n?/g, '\n').slice(0, 200000), key = (preview ? 'p:' : 'f:') + source;
  if (cache.has(key)) return cache.get(key);
  let html;
  try {
    const env = {}, tokens = md.parse(source, env);
    let end = tokens.length;
    if (preview) {
      // Stop at a complete block, never in the middle of a formula or fence.
      const offsets = [0]; for (const line of source.split('\n')) offsets.push(offsets.at(-1) + line.length + 1);
      let depth = 0, lineEnd = 0;
      for (let i = 0; i < tokens.length; i++) {
        depth += tokens[i].nesting; lineEnd = Math.max(lineEnd, tokens[i].map?.[1] || 0);
        if (depth === 0 && offsets[lineEnd] >= 700) { end = i + 1; break; }
      }
    }
    html = md.renderer.render(tokens.slice(0, end), md.options, env);
  } catch { html = `<pre class="prose">${escape(source)}</pre>`; }
  while (cache.size && (cache.size >= 50 || cachedChars + key.length + html.length > 2_000_000)) { const old = cache.keys().next().value; cachedChars -= old.length + cache.get(old).length; cache.delete(old); }
  if (key.length + html.length <= 2_000_000) { cache.set(key, html); cachedChars += key.length + html.length; }
  return html;
}
