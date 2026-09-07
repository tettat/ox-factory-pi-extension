import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const escSource = source.slice(source.indexOf('  function esc('), source.indexOf('  // ---- 轻量级 markdown'));
const mdSource = source.slice(source.indexOf('  function md('), source.indexOf('  function mdNode('));
const context = vm.createContext({});
vm.runInContext(`${escSource}\n${mdSource}\nglobalThis.render = md;`, context);
test('markdown images render in detail with safe preview and original link', () => {
 const html = context.render('![截图](https://example.com/screen.png)');
 assert.match(html, /<img /);
 assert.match(html, /loading="lazy"/);
 assert.match(html, /referrerpolicy="no-referrer"/);
 assert.match(html, /alt="截图"/);
 assert.match(context.render('![图](/api/talk-attachments/abc/content)'), /<img /);
});
test('markdown images reject unsafe sources and escape attributes', () => {
 for (const url of ['javascript:alert', 'file:///etc/passwd', 'data:image/svg+xml,bad', '//evil.example/x', '/Users/me/x.png']) {
  assert.doesNotMatch(context.render(`![图](${url})`), /<img /);
 }
 assert.doesNotMatch(context.render('![\" onerror=\"bad](https://example.com/x.png)'), /alt="" onerror=/);
 assert.doesNotMatch(context.render('![图](https://example.com/x.png)', {compact:true}), /<img /);
});
test('code examples stay literal and ordinary links still work', () => {
 assert.doesNotMatch(context.render('`![图](https://example.com/x.png)`'), /<img /);
 assert.doesNotMatch(context.render('```\n![图](https://example.com/x.png)\n```'), /<img /);
 assert.match(context.render('[链接](https://example.com)'), /<a href=/);
});
