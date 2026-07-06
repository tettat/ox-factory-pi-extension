# 牛马工厂项目文档目录

这个目录用于保存项目的人类可读 source of truth。

轻量原则：

- Project 实体只记录必要索引、状态、人员、todo、worktree、进展和权威文档链接。
- 长 checklist、方案、日报、复盘、飞书整理内容放在 Markdown/飞书文档里。
- 后续 LLM 可以根据 Project 实体 + 文档 + jobs/messages/token 生成项目报告。

建议每个项目一个 Markdown 文件：

```text
docs/ox-projects/<project-id>.md
```

模板见：

```text
docs/ox-projects/_template.md
```
