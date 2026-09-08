# 牛马手绘工作室：保存稿与动画小样

2026-09-08。基于 main@afec2e7，分支 azhe/handdrawn-design。

## 已保存
- `compaction-concept.png`：用户认可的手绘压缩页设计方向，示例数据，不是线上截图。
- `running-mascots.svg` / `resting-mascots.svg`：新绘制的矢量牛马小样，不是生成图中角色的精确描摹。CSS 仅动画 transform/opacity，无 JS 帧循环、网络请求或依赖。
- `preview.html`：独立预览，可暂停、切换现有配色参考/手绘配色；尊重 reduced-motion。这里不是现有生产组件的皮肤实现。
- `layout.css` 管几何结构，`skins.css` 管颜色/材质；偏好 key 使用 ox-design-preview-skin，不影响现有 Web 设置。

可直接打开 HTML；或在此目录 `python3 -m http.server 8794 --bind 127.0.0.1`。

## 实施约束（已经对齐，尚未接入生产）
1. 排版独立提交：筛选、指标、图表、详情抽屉的 DOM 与交互，不改变默认皮肤。
2. 皮肤独立提交：classic 保留并作为默认，handdrawn 可选，统一 CSS tokens；同一 DOM，不复制两套页面。
3. 手绘仅影响背景、边框、图标与局部标题；正文及数字用常规字体，状态不能只依赖颜色。
4. 动画独立组件：仅真实 running 状态播放，idle/paused 静止、failed 静止并显示错误。不能用跑步掩盖服务掉线。
5. 大列表不逐卡播放，优先只在总状态或当前员工详情放一组；不可见/后台页面暂停，遵守 reduced-motion。
6. 不用整页 PNG 实现皮肤，不引入重型动画库。纸纹用小资源或 CSS；性能排查和接口分页另行实施。

## 验证
JS 语法检查、两份 SVG XML 解析通过。当前为独立小样，尚未证明跨浏览器动画兼容性，不宣称已实现生产主题切换。
