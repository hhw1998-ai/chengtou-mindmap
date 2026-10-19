# 源码来源说明（扣子编程项目 7696808110719172646）

## 项目
- 名称：网站部署工具 / 《城投向产投转型：研究前思维导图》
- 类型：native-static 原生静态单页，无构建步骤、无前端依赖
- 扣子项目页：https://code.coze.cn/p/7696808110719172646/preview
- 生产站点：https://hv892cc3j7.coze.site/

## 获取方式（2026-10-19）
1. 登录扣子账号后进入项目预览页。
2. 预览 iframe 指向项目的开发沙箱站点（`*.dev.coze.site` 域名，python http.server
   直接服务项目根目录，且开启了目录列表）
3. 从该站点下载项目自带的源码包：
   - `/public/mindmap-project.tar.gz`（63,715 字节）
   - `/public/mindmap-project.b64.txt`（同一文件的 base64 版，86,074 字节）
4. 解压得到以下文件，即项目当前源码：

| 文件 | 大小 | 说明 |
|---|---|---|
| `index.html` | 252,044 B / 4,253 行 | 唯一主文件：HTML + 内联 CSS + 内联 JS + SVG，全部自包含 |
| `.coze` | 615 B | 运行配置（python3 -m http.server） |
| `AGENTS.md` | 1,131 B | 项目约定说明 |
| `.gitignore` | 780 B | Git 忽略规则 |
| `styles/main.css` | 2,714 B | 模板遗留样式，index.html 未引用 |
| `scripts/serve.ps1` | 226 B | Windows 下启动静态服务的脚本 |

## 校验结果
- 源码包内 `index.html` 的 SHA-256：
  `9bc6464dc98e2d2c5881c735bd973146b6d023c51c74b07c287295cb58042826`
- 开发沙箱 `/index.html` 去掉扣子注入的 3 个预览脚本后，SHA-256 与上面完全一致 → 源码包就是当前源码。
- 生产站点页面 258,575 B，与源码差异仅两处：
  1. 生产页额外注入了 Coze Coding Analytics 分析脚本；
  2. HTML 序列化格式微调（`<br>` → `<br/>` 等）。
  内容主体一致（相似度 98.1%）。

## 提示
- `public/mindmap-project.tar.gz` 和 `.b64.txt` 是源码打包文件，若发布上线会随站点公开可下载，建议部署前移除或放到非发布目录。
- 数据：1 个根节点 + 6 条主线 + 16 个模块 + 387 个研究问题，共 523 个节点，最大层级 4 层。

## 本仓库
- 仓库：`hhw1998-ai/chengtou-mindmap`（公开，用于 GitHub Pages 免费托管）
- 线上地址：<https://hhw1998-ai.github.io/chengtou-mindmap/>
- 内容：上述源码快照（6 个原始文件）+ `README.md` + `docs/screenshot.png`（线上界面截图）

## 2026-10-19 多人协作改造（在 GitHub 仓库内进行）

在保留原单页应用的基础上，新增 Supabase 云端协作层（未改动原渲染主逻辑）：

- 新增文件：
  - `js/cloud-sync.js`：身份、云端读写、实时订阅、在线人数、旧数据迁移、UI 增量覆盖
  - `js/mm-config.js`：Supabase 项目 URL 与 anon public key（公开信息）
  - `vendor/supabase.js`：supabase-js v2 UMD 包（自托管）
  - `styles/sync.css`：新增 UI 样式
  - `supabase/schema.sql`：建表 / 索引 / 触发器 / RLS / Realtime 配置
- 修改文件：`index.html`（引入 SDK、配置、同步层与样式）、`README.md`、`AGENTS.md`、`docs/screenshot.png`
- 后端：Supabase 项目 `chengtou-mindmap`
  - ref：`pbxxiyqvypcdffdcsaoa`
  - 区域：`ap-southeast-1`（免费版）
  - 表：`mm_members`、`mm_annotations`、`mm_highlights`、`mm_pages`
  - 认证：启用 Anonymous sign-ins；匿名登录限流调至 600/小时
  - 权限：RLS —— 所有人可读，只能增删改自己名下的记录
  - 实时：三张数据表加入 `supabase_realtime` 发布，`replica identity full`
- 数据迁移：首次登录时若本机 localStorage 存在旧标注，弹窗确认后上传并归属到当前用户。
