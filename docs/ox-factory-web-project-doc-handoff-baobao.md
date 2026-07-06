# 包包任务：Project 文档链接打开 / 本地 Markdown 渲染

日期：2026-07-05  
负责人：包包  
Review：派派

## 背景

用户确认：项目管理不想做重型结构化系统。Project Entity 只做必要索引和入口，长内容仍然放自由文本：飞书文档、网络地址、本地 Markdown。

Project Entity 当前已经能记录：

- `truth`：single source of truth，例如飞书 URL / 本地 Markdown。
- `links`：项目相关链接，例如 repo、dashboard、doc、md。

页面需要把这些文档入口做顺：

1. 如果是网络地址，点击直接新窗口打开。
2. 如果是本地 `.md`，点击后在 Web 页面内渲染 Markdown。

## 派派已补的插件 / Web 后端能力

新增只读 API：

```http
GET /api/project-doc?project=<projectIdOrAlias>&ref=<encodedRef>
```

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `project` | 是 | 项目 id / name / alias，走 `resolveProject` |
| `ref` | 否 | 要渲染的文档路径。不传时默认使用项目 truth 中的第一个本地 Markdown |

返回：

```json
{
  "generatedAt": "2026-07-05T...Z",
  "project": { "id": "ox-factory-project-entity", "name": "..." },
  "ref": "docs/ox-projects/ox-factory-project-entity.md",
  "path": "/Users/.../.pi/extensions/ox-factory/docs/ox-projects/ox-factory-project-entity.md",
  "size": 1867,
  "truncated": false,
  "content": "# 项目：..."
}
```

安全边界：

- 只读。
- 只渲染项目结构里已经登记的本地 Markdown ref：`project.truth.ref` 或 `project.links[].ref`。
- 网络 URL 不走此接口，前端直接打开。
- 未登记路径返回 403。
- 非 `.md` 返回 400。
- 文件不存在返回 404。
- 路径限制在当前仓库 / ox-factory extension 目录内。

验证命令：

```bash
node --test --test-name-pattern "project markdown" test/ox-factory.test.mjs

node web-server.mjs --workers-dir ../../workers --port 8799
curl -fsS 'http://127.0.0.1:8799/api/project-doc?project=ox-factory-project-entity'
```

## 你的前端任务

### 1. Project 详情页文档入口改造

位置：`web/app.js` 的 Project 详情页 `文档与链接` 区域。

当前问题：

- `truth.ref.startsWith("http")` 时才有 href。
- 本地 md 的 `href` 是 `null`，点击没法渲染。

目标行为：

| ref 类型 | 行为 |
| --- | --- |
| `http://` / `https://` | `<a target="_blank">` 新窗口打开 |
| 本地 `.md` / `type=markdown` | 点击后 fetch `/api/project-doc?...`，在页面内 Markdown 渲染 |
| 其它本地路径 | 暂不渲染，显示“暂不支持预览，可复制路径” |

建议实现：

- 增加 helper：`isHttpRef(ref)`、`isMarkdownRef(link)`、`projectDocUrl(projectId, ref)`。
- Markdown 链接不要用 `href=null`；可以用 `button` 或 `a href="#"` + `onclick preventDefault()`。
- 点击本地 md 后展示加载态。
- 使用现有 `mdNode()` 渲染返回的 `content`，不要新增 Markdown 依赖。

### 2. 渲染位置

二选一即可，推荐 A：

A. 复用现有右侧 drawer / modal：

- 标题：文档 label / ref。
- 内容：`mdNode(content)`。
- 顶部显示 `project.name`、`ref`、`size`、`truncated`。
- 错误时显示 `errorBox`。

B. Project 详情页内联展开：

- 点击后在“文档与链接”下面展开一个 Markdown card。
- 缺点是长文档会把页面撑很长。

### 3. Project 卡片也可做轻入口

如果 Overview / Projects card 上展示 truth：

- 网络 truth：点击新开。
- 本地 Markdown truth：进入 Project 详情页，或直接调用 drawer 渲染。第一版可以只进详情页，降低复杂度。

### 4. README / Smoke 更新

更新 Web README / smoke 列表：

- 新增 `/api/project-doc?project=ox-factory-project-entity`。
- 说明 Project docs：外链直接打开，本地 md 页面内渲染。
- 强调只读，不写 Project 数据。

### 5. 不做事项

- 不做飞书文档内容抓取；飞书 URL 直接新窗口打开。
- 不做本地非 Markdown 文件预览。
- 不做编辑 / 保存 / 同步。
- 不做自动给 Project 补 truth；这由主 agent / 布朗尼通过 `factory_project_upsert` 维护。

## 验收标准

1. `#/projects/ox-factory-project-entity` 的 truth `docs/ox-projects/ox-factory-project-entity.md` 可以点击并在页面内渲染 Markdown。
2. 网络 URL 类型 link 点击新窗口打开。
3. 未登记本地路径不能通过前端拼 URL 读取。
4. 页面错误态清晰：400/403/404 都能展示用户可理解的提示。
5. 不引入 npm 依赖、不生成 lockfile、不增加写接口。
6. 保持现有 Project / Schedules 页面不回退。

## 派派备注

这件事的产品原则是：

> Project Entity 只记录文档入口和少量结构化索引；真实长内容继续在 Markdown / 飞书里自由表达。

所以前端重点不是做一个重型项目管理系统，而是把“项目 -> 文档 -> 可读内容”的路径打通。
