# PlanBoard — 开发手册（DEV.md，给编码 agent 的技术约定）

**开工前必读：`PRD.md` 是本插件的需求规格书，所有功能以实现 PRD 为准。本文件是技术约定与踩坑记录。**

## 项目概况

- Obsidian 插件：个人计划总览（每日打卡 + 进度统计 + 目标管理）
- 技术栈：TypeScript + esbuild，Obsidian 官方模板结构
- 数据全部基于 markdown 笔记（Tasks 任务格式 + frontmatter），不做私有存储
- 不依赖任何第三方 Obsidian 插件（自包含）

## 构建与部署

```bash
npm install            # 首次（已完成）
npm run build          # 构建（tsc 检查 + esbuild production）→ main.js
```

**部署**：构建产物 `main.js` + `manifest.json` + `styles.css` 复制到 Obsidian 库：
`E:\文档\workbuddy\Obsidian库\.obsidian\plugins\planboard\`
（开发期间每次 build 后复制；Obsidian 里禁用再启用插件生效，或直接重载）

## 代码结构约定

```
main.ts          — 插件入口（Plugin 类、注册视图/命令/设置）
src/
  PlanBoardView.ts   — ItemView 主视图（tab 切换 + 各面板）
  daily.ts           — 每日笔记读写（打卡任务、总结区）
  stats.ts           — 统计口径（打卡率、完成率）
  settings.ts        — 设置页 + 设置类型
styles.css          — 全部样式（禁止内联 style）
```

## 数据模型速记（详见 PRD §2）

- 每日笔记路径：`{root}/{year}/每日/{YYYY-MM-DD}.md`
- 打卡任务行：`- [ ] 内容 #计划/{计划名} 🛫 YYYY-MM-DD 📅 YYYY-MM-DD`
- 总结区：`## 📝 今日总结` 到下一个 `##` 之间的内容
- 月/周笔记：frontmatter `temp-tasks: |` 多行块存任务
- 统计口径（关键！与用户旧体系一致）：
  - 计划打卡率 = 周期内勾选天数 ÷ 应有天数（写作/健康/学习=总天数，复盘=工作日数）
  - 今日进度 = 今日已勾选 ÷ 今日总数

## ⚠️ Obsidian 1.13.6 API 踩坑记录（血泪教训，必须遵守）

1. **模式切换**：`view.toggleMode()` 可用；`setState({mode:'preview'})` 报 "getFoldInfo is not a function"；`setMode('preview')` 报 "getEphemeralState is not a function"；`openFile(file, {mode:'preview'})` 的 mode 参数**无效**。需要切模式一律用 `toggleMode()`。
2. **链接导航继承阅读模式**：从阅读模式点击链接打开目标文件 → 目标以阅读模式打开。跳转"要编辑"的目标必须用代码：`openFile` 后 `if (view.getMode() === "preview") view.toggleMode()`。
3. **文件写回**：用 `vault.process(file, (data) => ...)` 或 `vault.modify`，**保留文件其余内容**，只改目标行（不要整文件重写）。
4. **实时刷新**：监听 `vault.on("modify")` + 防抖（500ms）刷新视图；`metadataCache` 更新有延迟，勾选写回后自己触发刷新，不要等 metadataCache。
5. **frontmatter 解析**：用 `app.metadataCache.getFileCache(file)?.frontmatter` 读，写时用 `vault.process` + `parseYaml/stringifyYaml`（从 obsidian 导入）。frontmatter 多行块（`temp-tasks: |`）写回时注意 YAML 缩进（2 空格），**替换多行块正则必须保留换行**（曾因 `\n?` 吞掉换行导致 `summary: ""---` 文件损坏）。
6. **任务解析**：Tasks 格式行 `- [ ] 内容 #计划/写作 🛫 2026-08-11 📅 2026-08-11`，用正则逐行解析：`/^- \[( |x)\] (.+?)(?: #计划\/(\S+))?(?: 🛫 (\d{4}-\d{2}-\d{2}))?(?: 📅 (\d{4}-\d{2}-\d{2}))?$/`。
7. **getMode() 语义**：返回 `'source'`（编辑模式，含 live preview）或 `'preview'`（阅读模式）。插件视图是 ItemView，自绘 DOM，与模式无关——**插件内部不要依赖模式配置**。

## 编码规范

- TypeScript 严格模式（strictNullChecks），全部类型标注
- 样式只用 CSS 类 + `styles.css`，跟随 Obsidian CSS 变量（`var(--background-primary)` 等），**深色模式必须适配**
- 文案中文，注释英文
- 所有用户可见错误要友好提示（Notice），不抛裸异常

## M2 规格（任务系统 + 首页重组，v1.1）

### 任务池（新增文件）
`{root}/{year}/任务.md`（如 `raw/计划/2026/任务.md`），Tasks 格式逐行：
```
- [ ] 完成《霍去病》文章 #计划/写作 🛫 2026-08-10 📅 2026-08-16
- [x] 整理 AI 画图工作流 #计划/学习 🛫 2026-08-12 📅 2026-08-14
```
- 所有任务统一存这里（不要散落到周/月笔记）
- 周视图过滤：任务窗口与本周 [start,end] 有交集（🛫 或 📅 落在周内）
- 月视图过滤：同理按月
- 数量型计划进度 = 该计划标签下已完成任务数（自动推进，无需手动）

### 首页（今日 tab）布局（v1.1）
从上到下：
1. **年度目标卡**：每个计划一行 = 名称 + target 描述 + 进度条（数量型 n/12，打卡型打卡率%）
2. **本月任务卡**：本月任务完成数/总数 + 进度条
3. **本周任务卡**：本周任务完成数/总数 + 进度条 + 任务预览列表
4. **今日打卡**（行动）+ 今日总结 + 复盘入口（现有）

### 周/月/年度视图（v1.1）
- **周视图**：本周任务明细列表（勾选完成/编辑/删除/新建）+ 本周打卡统计
- **月视图**：本月任务明细列表（同上）
- **年度视图**：计划详情（目标描述 + 进度 + 该计划任务列表）

### 看板视图（v1.1）
任务池任务按状态分列：待办（未完成）/ 进行中（未完成且已到 🛫）/ 完成（[x]），可拖拽或按钮切换状态

### 甘特图（v1.1，轻量）
任务池任务按 🛫~📅 渲染时间条（月为跨度），只读展示，点击任务跳转详情

### 任务 CRUD 交互
- 新建：弹窗（内容、关联计划下拉、🛫、📅）→ 写回任务池
- 编辑：点击任务 → 弹窗修改（内容/计划/日期）
- 删除：✕ 按钮
- 勾选：- [ ] ↔ - [x] 写回

### 数据迁移（保留用户已有数据）
- 周笔记 `2026-W33.md` 正文的"本周任务/本周重点"空模板行**保留不动**（用户以后手动填写作为备注），任务系统只读任务池
- 年度计划 frontmatter `plans` 结构不变，只读取 target 描述

### 自动分解（数量型计划，v1.2）
- 规则：有 targetCount 的数量型计划 → 自动生成周配额任务
- 算法：周配额累积法——`weekN_quota = ceil(N × (weekIndex+1) / totalWeeks)`，每周生成 `quota_n - quota_{n-1}` 个任务（0/1/2 个）
- 周期：从年度计划 start 到 end 的 ISO 周序列；本周若 start 未到跳过
- 任务名：`✍️ 写作（第 N 篇）`（label + 计数），可被用户编辑改名
- 幂等：任务池中若已存在"本周 + 该计划 + 名称匹配 自动任务"则不重复生成
- 识别：自动任务命名含计划 label + （第 N 篇）模式；手动任务不干扰
- 生成时机：PlanBoard 视图刷新时检查（无需 cron）
- 进度统计：自动任务与手动任务都计入计划完成数

## M1 验收（写完必须自查）

1. 命令 `PlanBoard: 打开计划总览` 可用，视图打开显示今日
2. 今日打卡列表正确显示（读取用户真实库：`E:\文档\workbuddy\Obsidian库\raw\计划\2026\每日\2026-08-11.md`）
3. 勾选打卡 → 文件写回 → 进度条更新（无需手动刷新）
4. 总结 textarea 编辑 → 失焦保存 → 文件写回正确
5. 复盘按钮 → 打开/创建当日复盘笔记
6. 今日到期临时任务显示（来自月/周笔记 temp-tasks）

## 测试用真实数据

用户 Obsidian 库：`E:\文档\workbuddy\Obsidian库\`
- 每日笔记示例：`raw/计划/2026/每日/2026-08-11.md`（已有 4 项打卡 + 空总结）
- 周笔记：`raw/计划/2026/周/2026-W33.md`
- 月笔记：`raw/计划/2026/月/2026-08.md`
- 年度计划：`raw/计划/年度计划.md`

开发时可以直接读写这些文件验证（不要破坏已有数据；测试写回后要还原）。
