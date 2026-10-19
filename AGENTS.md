# AGENTS.md

## 项目概览
- 类型：原生静态单页（native-static 模板）+ Supabase 云端协作，无构建步骤。
- 内容：《城投向产投转型：研究前思维导图》单页应用，基础页面全部自包含在 `index.html`（HTML + 内联 CSS/JS/SVG）。
- 多人协作能力由 `js/cloud-sync.js` 提供：云端保存、实时同步、按人区分标注/高亮、匿名昵称身份、权限隔离、旧数据迁移。
- 入口：`index.html`。

## 构建与运行
- 无需安装依赖、无需构建。
- 本地运行：`python3 -m http.server 8000`，打开 <http://localhost:8000>。
- 扣子/部署运行：`python3 -m http.server ${DEPLOY_RUN_PORT} --bind 0.0.0.0`（已在 `.coze` 中配置，端口由环境变量决定，禁止硬编码）。
- 页面需要联网访问 Supabase 才能读写云端数据；断网时仅能浏览本机缓存。

## 代码风格与维护
- 基础页面：`<style>` 内联样式、`<script>` 内联逻辑，修改时直接编辑 `index.html`。
- 多人协作：改动集中在 `js/cloud-sync.js`（通过覆盖/包装原页面函数接入云端，不改动原有渲染主逻辑），样式在 `styles/sync.css`。
- 后端：Supabase 项目，表结构与权限见 `supabase/schema.sql`；前端配置在 `js/mm-config.js`（URL + anon key 为公开信息）。
- **安全红线**：`service_role` key、数据库密码等敏感信息绝不写入仓库；前端只允许出现 anon key。
- 数据模型：`ANNO`/`HL`/`PAGES` 仍是页面渲染用的聚合状态，云端记录通过 `rebuild()` 聚合得到；写入走 `MMCloud.saveAnno / saveMark / updatePage` 等。
- 实时订阅注意：postgres_changes 不要在同一频道上挂无 filter 的 `mm_members` 订阅（实测会导致整频道静默失效）；DELETE 事件的 `old` 只含主键 `id`，需按 id 反查。
- 已清理来源文件中沉浸式翻译插件注入的节点（`immersive-translate-*`）及浏览器保存注释，勿重新引入。

## 验证
- 冒烟：`curl -s http://localhost:8000/index.html | grep 城投向产投转型`（HTTP 200 + 标题正确）。
- 多人协作验收：两个浏览器上下文各注册不同昵称 → 一方标注/高亮/建对齐页，另一方应在 1-3 秒内实时出现；非作者不可编辑他人数据；访客可选只读浏览。
- 交付前检查浏览器控制台无报错，Supabase 表数据无测试残留。
