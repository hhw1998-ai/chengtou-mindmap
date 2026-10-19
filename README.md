# 城投向产投转型：研究前思维导图

把「城投 → 产投」转型的研究框架做成一张可交互的思维导图单页应用。

- **在线访问（GitHub Pages）**：<https://hhw1998-ai.github.io/chengtou-mindmap/>
- 扣子生产站点（原始部署）：<https://hv892cc3j7.coze.site/>
- **数据规模**：1 个根节点 + 6 条主线 + 16 个模块 + 387 个研究问题，共 523 个节点，最深 4 层
- **形态**：原生静态单页（native-static），无构建步骤、无前端依赖，全部资源自包含在一个 `index.html` 中

![界面截图](docs/screenshot.png)

## 功能

- **逐层展开/折叠**：点击节点右侧 `+` 逐层展开，点击节点查看全文与同级问题
- **搜索**：按关键词检索（如「工资总额 / 隐性债务 / 名单 / 退出」）
- **缩放 / 拖动 / 适配**：自由缩放、拖动点景、一键适配全图
- **高亮分类**：右键任一卡片可标高亮（首批 / 第二批 / 第三批 / 重点 / 存疑），可按全部高亮生成「对齐页」
- **标注**：对节点添加标注，按标注列表跳转
- **导出 / 导入备份**：把标注、高亮、对齐页导出为 JSON，或从 JSON 恢复
- **本地持久化**：标注数据保存在浏览器 `localStorage`（含 `STORE_OK` 兜底提示）

## 目录结构

```
.
├── index.html          # 唯一主文件：HTML + 内联 CSS/JS/SVG（约 4,253 行）
├── .coze               # 运行配置：python3 -m http.server ${DEPLOY_RUN_PORT}
├── AGENTS.md           # 项目约定（单文件、无构建、localStorage 存储等）
├── PROVENANCE.md       # 源码来源、文件清单与哈希校验记录
├── styles/main.css     # 模板遗留样式，index.html 未引用
├── scripts/serve.ps1   # Windows 下的静态服务启动脚本（.coze 的 run_win 使用）
├── .gitignore
└── docs/screenshot.png # 界面截图
```

## 本地运行

无需安装依赖、无需构建：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 技术说明

- 单文件结构：`<style>` 内联样式、`<script>` 内联逻辑，修改时直接编辑 `index.html`
- 思维导图数据以内联常量 `ROOT` 的形式写在 `index.html` 中，页面由 JS 递归渲染
- 部署由扣子编程平台托管，模板为 `native-static`；端口由环境变量 `DEPLOY_RUN_PORT` 决定

## 已知限制

- 标注、高亮、对齐页仅保存在**当前浏览器的 localStorage**：换设备、换浏览器或清缓存后丢失，多人之间也不互通
- 如需多人协作/跨设备同步，需改为云端存储方案（如 Supabase 等）

## 源码来源

本仓库源码从扣子编程项目（ID `7696808110719172646`）获取，获取方式、文件清单、SHA-256 校验及与线上版本的差异说明见 [PROVENANCE.md](PROVENANCE.md)。
