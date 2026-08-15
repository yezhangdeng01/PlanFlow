# PlanBoard v1.3 UI 任务：甘特三标签 + 看板双视图（Claude Code）

项目：E:\文档\Hermes\planboard\（Obsidian 插件，TypeScript + esbuild）
先读 PRD.md 和 docs/DEV.md。**拖拽核心逻辑由 Hermes 写（不要实现拖拽！）**，你只做：渲染 + 子标签 + 看板双视图 + 分类修复 + DOM 结构按规格（Hermes 的拖拽代码会依赖这些类名/data 属性）。

## 背景

- 数据层：任务池 `{root}/{year}/任务.md`（PoolTask：text/plan/checked/start/due/line/raw/file）
- 现有：甘特 tab（本月单视图）、看板 tab（按计划分类，只显示有任务的计划）
- 你需要新增：甘特子标签（周/月/年）、看板子标签（分类/状态）、分类视图按年度计划全大类显示

## 任务

### 1. 甘特子标签（周/月/年）

`renderGanttPanel()` 改为：面板顶部渲染子标签栏，然后按当前子标签渲染图表。

**子标签栏**（插在 header 后）：
```ts
const subtabs = panel.createDiv({ cls: "planboard-subtabs" });
const modes: Array<{ key: "week" | "month" | "year"; label: string }> = [
	{ key: "week", label: "本周" },
	{ key: "month", label: "本月" },
	{ key: "year", label: "本年" },
];
for (const m of modes) {
	const btn = subtabs.createEl("button", { cls: "planboard-subtab" + (this.ganttMode === m.key ? " is-active" : ""), text: m.label });
	btn.addEventListener("click", () => { this.ganttMode = m.key; void this.refresh(); });
}
```
类字段：`private ganttMode: "week" | "month" | "year" = "month";`

**图表渲染（三个模式）**——统一结构（Hermes 拖拽依赖）：
```
.planboard-gantt
├── .planboard-gantt-axis            ← 刻度行（flex，每格 width = 100/N%）
│     └── .planboard-gantt-axis-cell（逢 5 标数字 + is-today 高亮，week/month 模式）
├── .planboard-gantt-row（每任务一行）
│     ├── .planboard-gantt-label（flex 0 0 150px，任务名截断）
│     └── .planboard-gantt-track（flex 1，相对定位）
│           ├── .planboard-gantt-today（今天竖线，绝对定位 left%）
│           └── .planboard-gantt-bar（任务条）
│                 ├── .planboard-gantt-handle.is-left（左端手柄）
│                 └── .planboard-gantt-handle.is-right（右端手柄）
```

**axis 模式**：
- week：N=7，标签 周一~周日（显示"一二三四五六日"或周几），今天 is-today
- month：N=当月天数（现有逻辑保留），逢 5 标数字
- year：N=12，标签 "1月"~"12月"，**当前月**的格 is-today（加 .is-today class 到当月格）

**任务筛选与条定位**（每模式）：
- week：任务窗口与本周相交（start/due 落本周或跨周）；dayIndex = 周一=1..周日=7
- month：与本月相交（现有逻辑）；dayIndex = 1..N
- year：与本年相交；**startIndex = 月份（1..12），endIndex = 截止月份**——条跨度按整月（条 left = (startMonth-1)/12×100%，width = (endMonth-startMonth+1)/12×100%）
- 跨窗口 clamp（week/month 模式现有逻辑保留；year 模式：start 早于 1 月 → 1，end 晚于 12 月 → 12）
- 无日期任务 → 底部「🗂️ 未排期任务」卡（现有）

**条 DOM（拖拽必需，严格按此）**：
```ts
const bar = track.createDiv({ cls: "planboard-gantt-bar" + (t.checked ? " is-done" : "") });
if (t.plan) bar.setAttribute("data-plan", t.plan);
bar.setAttribute("data-line", String(t.line));          // 任务池行号（写回用）
bar.setAttribute("data-start", t.start ?? "");          // 原 start
bar.setAttribute("data-due", t.due ?? "");              // 原 due
bar.setAttribute("data-axis", this.ganttMode);          // week|month|year（换算粒度）
bar.style.left = ...; bar.style.width = ...;
const hLeft = bar.createDiv({ cls: "planboard-gantt-handle is-left" });
const hRight = bar.createDiv({ cls: "planboard-gantt-handle is-right" });
bar.setAttribute("title", `${t.text}${t.checked ? " ✓" : ""}`);
```
**条上同时绑定点击（编辑）**：bar 点击（非拖拽）→ `this.openTaskModal(t)`——注意拖拽和点击冲突：Hermes 的拖拽代码会处理（pointerdown 记录、移动超过阈值算拖、否则算点击）。你只需把 bar 的 click 绑定 openTaskModal（Hermes 会在 pointerdown 时 preventDefault/stopPropagation 区分）。**安全做法**：只绑定 pointerdown（Hermes 管），不绑 click——由 Hermes 在拖拽代码里统一处理点击=编辑。**你只渲染 DOM，事件全由 Hermes 的 drag.ts 挂载**（你不需要在 view 里绑定任何条事件，只需导出 renderGanttPanel 生成的 task rows 引用或依赖 DOM 查询）。

### 2. 看板子标签（分类 / 状态）

`renderBoardPanel()` 改为：顶部子标签栏 + 按模式渲染。

**子标签栏**（插在 header 后）：
```ts
const subtabs = panel.createDiv({ cls: "planboard-subtabs" });
const modes = [{ key: "category" as const, label: "分类" }, { key: "status" as const, label: "状态" }];
// 同甘特子标签写法，this.boardMode = "category" | "status"
```

**分类视图（修复"不完整"）**：列 = **年度计划全部大类**（`parsePlansFromFrontmatter` 读 plans keys）+ 无计划任务归「其他」列。无任务的计划列显示"暂无任务"（空态，列头计数 0/0）。计划名取 `def.label ? \`${def.label} ${def.name}\` : def.name`（写作显示 ✍️ 写作）。
- 列内任务排序：未完成在前（按 start/due），已完成沉底（现有）

**状态视图（三列）**：列 = 未开始 / 进行中 / 已完成（`.planboard-board-col` 复用 + 列头配色区分：未开始=默认，进行中=accent，已完成=绿色调）。派生规则：
```ts
function taskStatus(t: PoolTask, today: string): "todo" | "doing" | "done" {
	if (t.checked) return "done";
	if (t.start && today >= t.start && (!t.due || today <= t.due)) return "doing";
	return "todo"; // 无日期任务也归 todo
}
```
- 列标题：`📋 未开始` / `🔥 进行中` / `✅ 已完成` + 计数 pill
- 任务行复用 renderTaskItem（勾选/✏️/✕ 全可用）
- 已完成列的任务 is-checked 样式（现有）

### 3. CSS（styles.css 追加）

```css
/* 子标签栏（甘特/看板共用） */
.planboard-subtabs { display: flex; gap: 6px; margin: 4px 0 10px; }
.planboard-subtab { ... pill 按钮，is-active 高亮（参照 .planboard-tab 风格）... }

/* 拖拽手柄 */
.planboard-gantt-handle { position: absolute; top: 0; bottom: 0; width: 10px; cursor: ew-resize; z-index: 3; }
.planboard-gantt-handle.is-left { left: 0; border-left: 2px solid rgba(255,255,255,0.5); }
.planboard-gantt-handle.is-right { right: 0; border-right: 2px solid rgba(255,255,255,0.5); }
/* 拖拽中状态（Hermes 会加 class） */
.planboard-gantt-bar.is-dragging { opacity: 0.75; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }

/* 状态视图列头配色 */
.planboard-board-col-status-doing .planboard-board-col-title { color: var(--text-accent); }
.planboard-board-col-status-done .planboard-board-col-title { color: var(--color-green); }
```

### 4. 数据/类型

- 类字段：`private ganttMode: "week" | "month" | "year" = "month";`、`private boardMode: "category" | "status" = "category";`
- renderGanttPanel / renderBoardPanel 重构为按模式分发（建议拆小函数：renderGanttWeek/Month/Year、renderBoardCategory/Status）
- 其他视图/逻辑不动

## 验证要求

- npm run build 零错误
- 复制 main.js manifest.json styles.css 到 E:\文档\workbuddy\Obsidian库\.obsidian\plugins\planboard\（沙箱拦截则报告，Hermes 手动部署）
- 甘特三标签切换正常渲染（周 7 格/月 31 格/年 12 月格）
- 看板分类视图显示全部计划（含无任务计划"暂无任务"）；状态视图三列正确归类
- 不要改用户数据

## 最终报告

文件清单、构建结果、部署结果（成功/被拦）、遗留问题。
