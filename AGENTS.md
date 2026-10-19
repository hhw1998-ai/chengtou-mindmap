# AGENTS.md

## 项目概览
- 类型：原生静态单页（native-static 模板），无构建步骤、无前端依赖。
- 内容：《城投向产投转型：研究前思维导图》单页应用，HTML + 内联 CSS/JS/SVG，全部资源自包含。
- 入口：`index.html`（项目根目录，唯一主文件）。

## 构建与运行
- 无需安装依赖、无需构建。
- 本地/部署运行：`python3 -m http.server ${DEPLOY_RUN_PORT} --bind 0.0.0.0`（已在 `.coze` 中配置，端口由环境变量 `DEPLOY_RUN_PORT` 决定，禁止硬编码）。

## 代码风格与维护
- 单文件结构：`<style>` 内联样式、`<script>` 内联逻辑，修改时直接编辑 `index.html`。
- 页面通过 JS 渲染思维导图数据（`renderPage` 等），数据存储使用 localStorage（含 STORE_OK 兜底提示）。
- 已清理来源文件中沉浸式翻译插件注入的节点（`immersive-translate-*`）及浏览器保存注释，勿重新引入。

## 验证
- 交付前使用 `test_run` 执行 curl 冒烟：确认 `/index.html` 返回 HTTP 200 且标题为「城投向产投转型：研究前思维导图」。
