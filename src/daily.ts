import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import type { PlanTemplate } from "./settings";

/**
 * Date + daily-note utilities.
 *
 * All note formats strictly follow PRD §2. Task lines use the Tasks format:
 * `- [ ] 内容 #计划/{计划名} 🛫 YYYY-MM-DD 📅 YYYY-MM-DD`
 */

export const CHECK_HEADING = "## ✅ 今日打卡";
export const SUMMARY_HEADING = "## 📝 今日总结";
/** v7.5: 打卡记录独立区（三个可选框的值落在这里，任务行格式零污染）。 */
export const LOG_HEADING = "## ⏱ 打卡记录";

/**
 * Parse a single Tasks-style line (DEV.md §5 踩坑记录 #6).
 * Groups: [1]=checkbox, [2]=content, [3]=plan tag, [4]=🛫 date, [5]=📅 date.
 */
export const TASK_LINE_RE =
	/^- \[([ x])\] (.+?)(?: #计划\/(\S+))?(?: 🛫 (\d{4}-\d{2}-\d{2}))?(?: 📅 (\d{4}-\d{2}-\d{2}))?$/;

/** A check-in item inside the daily note. */
export interface CheckItem {	/** Task content (no `- [ ]` marker, no plan tag). */
	text: string;
	/** Plan tag name (without `#计划/`), or null for temp tasks. */
	plan: string | null;
	checked: boolean;
	/** Due date `📅` (falls back to scheduled date), or null. */
	due: string | null;
	/** v7.19: Scheduled date `🛫`, or null（添加打卡项弹窗的「起止日期」写入）。 */
	start: string | null;
	/** 0-based line index inside the note file. */
	line: number;
	/** The full raw line. */
	raw: string;
	/** The note file this item lives in. */
	file: TFile;
}

/** A temp task coming from the daily note or a week/month note frontmatter. */
export interface TempTask {
	text: string;
	plan: string | null;
	checked: boolean;
	/** Due date `📅` (or `end`), or null. */
	due: string | null;
	/** Scheduled date `🛫` (or `start`), or null. */
	start: string | null;
	/** Where the task was read from. */
	source: "daily" | "week" | "month";
	file: TFile;
	/** Index inside the temp-tasks source (frontmatter array / multiline block). */
	index: number;
	/** Line index in the daily note when source is "daily", otherwise -1. */
	line: number;
	/** Full raw line (empty for object-formatted frontmatter tasks). */
	raw: string;
	/** Whether the checkbox can be toggled (object-formatted tasks cannot). */
	togglable: boolean;
}

/** Parsed daily note content. */
export interface DailyData {
	date: string;
	file: TFile;
	content: string;
	/** Check-in items carrying a `#计划/` tag. */
	checkItems: CheckItem[];
	/** Temp tasks written directly in the daily note (no plan tag). */
	tempItems: TempTask[];
	/** Editable summary text (PRD §2.2). */
	summary: string;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function formatDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function parseDateString(s: string): Date {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
	const r = new Date(d);
	r.setDate(r.getDate() + n);
	return r;
}

export function todayStr(): string {
	return formatDate(new Date());
}

export function weekdayName(dateStr: string): string {
	return WEEKDAYS[parseDateString(dateStr).getDay()];
}

/** ISO-8601 week number of a date (with its ISO year). */
export function getISOWeek(dateStr: string): { year: number; week: number } {
	const d = parseDateString(dateStr);
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const dayNum = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return { year: date.getUTCFullYear(), week };
}

/** Monday-start week range (inclusive) containing the given date. */
export function weekRange(dateStr: string): { start: string; end: string } {
	const d = parseDateString(dateStr);
	const day = d.getDay() || 7; // Mon=1 ... Sun=7
	const start = addDays(d, 1 - day);
	return { start: formatDate(start), end: formatDate(addDays(start, 6)) };
}

export function daysInMonth(year: number, month: number): number {
	return new Date(year, month, 0).getDate(); // month is 1-based
}

/** Number of days in [start, end], inclusive. */
export function dayCount(start: string, end: string): number {
	const s = parseDateString(start);
	const e = parseDateString(end);
	return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
}

// 注：原有的 `countWorkdays()`（工作日计数）已随「复盘按工作日统计」特化一并移除——
// 它服务的是作者本人那个 A股复盘计划（交易日不含周末），不是通用需求。留着等于在
// 公共工具里留一个没人用、却暗示着某种领域口径的入口。

// ---------------------------------------------------------------------------
// Task line parsing
// ---------------------------------------------------------------------------

/** Parse a single task line; returns null when not a Tasks line. */
export function parseTaskLine(line: string): Pick<CheckItem, "text" | "plan" | "checked" | "due"> | null {
	const m = TASK_LINE_RE.exec(line.trim());
	if (!m) return null;
	return {
		text: m[2].trim(),
		plan: m[3] ?? null,
		checked: m[1] === "x",
		due: m[5] ?? m[4] ?? null,
	};
}

/**
 * 打卡项的**身份键**：同一个打卡项的多次出现必须算出同一个 key，才能去重。
 *
 * 为什么这么算（每一处都有踩坑依据）：
 *   · 用 `plan` 优先——`#计划/` 标签是插件写盘时保证存在的稳定锚点（`buildCheckLine`
 *     总会写），比标题可靠；
 *   · 无plan 时退化为「归一后的显示名」——覆盖手写项；
 *   · 显示名先`normalizeCheckName` 归一：剥掉复盘链接尾段与历史时长后缀，
 *     否则 `📈 复盘 → [[...]]`、`📈 复盘 复盘+次日计划 → [[...]]`、
 *     `✍️ 写作` 三种写法会被当成三个不同项（详见 normalizeCheckName 的注释）。
 */
function checkItemKey(text: string, plan: string | null): string {
	if (plan) return `P:${plan}`;
	return `T:${normalizeCheckName(text)}`;
}

/**
 * v1.1.7 解析每日笔记。
 *
 * **去重（防御性）**：同一篇笔记里同一个打卡项可能出现多次——实测真库
 * `2026-10-06.md`里两套完整的 `## ✅ 今日打卡` 区各有一份写作/健康/学习/复盘，
 * 界面因此显示 8 项、进度算成 3/8（用户实际只打了2 个卡）。
 * 根因在库外（同步插件把两端改动拼进同一文件），插件改不了那个文件，
 * 但**可以让它对这种文件自愈**：按`checkItemKey` 合并，界面只显示一条。
 *
 * 合并时的状态口径：**只要有一条是勾的就算已打卡**。
 * 反过来（全是未勾）就不勾——否则用户在 A 端取消打卡、同步到B 端会被顶回来。
 * 保留 `line` 指向**第一条**（行号用于写盘时定位；同 key 多行时改第一条即可，
 * 其余是历史残留，见 dedupe 的注释）。
 */
export function parseDailyContent(file: TFile, content: string, date: string): DailyData {
	const lines = content.split("\n");
	const checkItems: CheckItem[] = [];
	const tempItems: TempTask[] = [];
	let inCheckSection = false;
	// v1.1.7：去重索引——key → 已收录的 checkItem。同一 key 再出现就合并进已有项。
	// tempItem 只需判「有没有见过」，用单独的值占位（它类型不同，塞进同一个 Map 不干净）。
	const seenCheck = new Map<string, CheckItem>();
	const seenTempKeys = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) {
			inCheckSection = line.startsWith(CHECK_HEADING);
			continue;
		}
		if (!inCheckSection) continue;
		const m = TASK_LINE_RE.exec(line);
		if (!m) continue;
		const checked = m[1] === "x";
		const plan = m[3] ?? null;
		const base = {
			text: m[2].trim(),
			plan,
			checked,
			due: m[5] ?? m[4] ?? null,
			start: m[4] ?? null,
			raw: line,
		};
		if (plan) {
			const item: CheckItem = { ...base, line: i, file };
			const key = checkItemKey(item.text, item.plan);
			const prev = seenCheck.get(key);
			if (prev) {
				// 同一项又出现：合并勾选态（任一为 x 即视为已打卡），保留第一条的定位信息
				if (checked) prev.checked = true;
				continue;
			}
			seenCheck.set(key, item);
			checkItems.push(item);
		} else {
			// 临时项同样去重：键用归一名，避免 `✍️ 写作` 与 `✍️ 写作 1小时` 各算一条
			const key = checkItemKey(base.text, null);
			if (seenTempKeys.has(key)) continue;
			seenTempKeys.add(key);
			tempItems.push({
				...base,
				start: m[4] ?? null,
				source: "daily",
				file,
				index: i,
				line: i,
				togglable: true,
			});
		}
	}

	return {
		date,
		file,
		content,
		checkItems,
		tempItems,
		summary: extractSummary(content),
	};
}

// ---------------------------------------------------------------------------
// Summary section (PRD §2.2: replace content between the heading and the
// next `##` heading — while preserving trailing callout/tip blocks)
// ---------------------------------------------------------------------------

/** Extract the editable summary text (without the heading). */
export function extractSummary(content: string): string {
	const idx = content.indexOf(SUMMARY_HEADING);
	if (idx === -1) return "";
	const after = content.slice(idx + SUMMARY_HEADING.length);
	let end = after.length;
	const nextHeading = /\n##\s/.exec(after);
	if (nextHeading) end = nextHeading.index;
	let region = after.slice(0, end);
	// Trim trailing callout blocks (e.g. the `> [!tip]` help block in templates).
	const callout = /\n\n>/.exec(region);
	if (callout) region = region.slice(0, callout.index);
	// v1.1.7：损坏文件里可能有第二篇日记紧跟其后（同步拼接，见 parseDailyContent 去重注释），
	// 那篇的 frontmatter / `# 📅` 标题会被当成总结正文吞进文本框，用户的总结框里
	// 就会冒出 `---` / `date: 2026-10-06` 这种东西。
	//
	// 口径：**找到「行首`---` 或行首 `# `」就整体截断**——总结正文里本来就不该出现
	// 这两种结构行（`#` 开头的 Markdown 标题会另起一个语义块，`---` 是 frontmatter/
	// 分隔线），所以遇到就说明后面是另一篇日记的起点。
	// ⚠️ 早先用正则 `\s*$` / 无 `g` 标志各踩一次（前者匹配不到、后者只去掉第一处），
	// 最后一行残留 `date: 2026-10-06`。改成「定位首个结构行的行首、切掉之后全部」，
	// 一行做完、不依赖多次替换。
	const structural = /(^|\n)(?:-{3,}[ \t]*$|#[^#\n])/m.exec(region);
	if (structural) region = region.slice(0, structural.index);
	region = region.replace(/^\n+/, "").trimEnd();
	return region;
}

/**
 * Replace the summary region, keeping everything else intact.
 * DEV.md 踩坑记录 #5: never let a regex swallow the newline that separates
 * the summary from the next heading / callout block.
 */
export function replaceSummary(content: string, summary: string): string {
	const idx = content.indexOf(SUMMARY_HEADING);
	if (idx === -1) return content;
	const head = content.slice(0, idx + SUMMARY_HEADING.length);
	const after = content.slice(idx + SUMMARY_HEADING.length);

	let end = after.length;
	const nextHeading = /\n##\s/.exec(after);
	if (nextHeading) end = nextHeading.index;
	const callout = /\n\n>/.exec(after.slice(0, end));

	let tail = "";
	if (callout) {
		tail = after.slice(callout.index + 2); // keep "> [!tip] ..." block
	} else if (nextHeading) {
		tail = after.slice(nextHeading.index + 1); // keep "## next heading"
	}

	let result = head + "\n" + summary;
	if (tail) result += "\n\n" + tail;
	else result += "\n";
	return result;
}

// ---------------------------------------------------------------------------
// Line-level mutations (checkbox / add / remove / move)
// ---------------------------------------------------------------------------

/**
 * 定位待改动的行号（v2.5 B2 的 fail-safe，各行级操作共用）。
 *
 * 行号处内容与预期不符说明文件被外部改动（行号漂移），按原始行文本重定位；
 * 找不到、或重定位后仍越界，一律返回 -1 让调用方放弃写回——绝不猜测改哪一行。
 *
 * ⚠️ 调用方**必须**先判 `idx === -1` 再去索引 `lines[idx]` / 算偏移：
 * 早先 `moveTaskLine` 先算 `idx + delta` 再判越界，idx=-1 时 delta=1 会得到
 * target=0，恰好骗过 `target >= 0` 检查，随后拿 `lines[0]` 去交换——静默改错数据。
 */
function resolveLineIndex(lines: string[], lineIndex: number, expectedRaw?: string): number {
	let idx = lineIndex;
	if (expectedRaw && lines[idx] !== expectedRaw) {
		idx = lines.findIndex((l) => l === expectedRaw);
	}
	return idx >= 0 && idx < lines.length ? idx : -1;
}

export function toggleTaskLine(content: string, lineIndex: number, checked: boolean, expectedRaw?: string): string {
	const lines = content.split("\n");
	const idx = resolveLineIndex(lines, lineIndex, expectedRaw);
	if (idx === -1) return content;
	const line = lines[idx];
	if (!/^- \[[ x]\]/.test(line)) return content;
	lines[idx] = line.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]");
	return lines.join("\n");
}

export function removeLine(content: string, lineIndex: number, expectedRaw?: string): string {
	const lines = content.split("\n");
	const idx = resolveLineIndex(lines, lineIndex, expectedRaw);
	if (idx === -1) return content;
	lines.splice(idx, 1);
	return lines.join("\n");
}

/**
 * v1.0.5.2: 编辑打卡项——把指定行整体替换为 newRaw（重建的完整行）。
 * newRaw 由调用方重建（保留 checkbox 状态与 #计划/ 标签、更新名称/窗口），
 * 这里只负责按 expectedRaw 定位原行并替换；定位失败原样返回（fail-safe 同族口径）。
 */
export function replaceLine(content: string, lineIndex: number, expectedRaw: string, newRaw: string): string {
	const lines = content.split("\n");
	const idx = resolveLineIndex(lines, lineIndex, expectedRaw);
	if (idx === -1) return content;
	lines[idx] = newRaw;
	return lines.join("\n");
}

/**
 * v1.0.5: 撤销删除——把一行插回指定下标。
 * lineIndex 是删除前那行的下标；若期间文件又变了，下标可能略偏，
 * 所以夹到 [0, lines.length] 内兜底（打卡项都在打卡区内，位置基本稳定）。
 * 与 removeLine 成对使用：`insertLine(removeLine(data, i, raw), i, raw)` 逐字节还原。
 */
export function insertLine(content: string, lineIndex: number, raw: string): string {
	const lines = content.split("\n");
	const at = Math.max(0, Math.min(lineIndex, lines.length));
	lines.splice(at, 0, raw);
	return lines.join("\n");
}

export function moveTaskLine(content: string, lineIndex: number, delta: number, expectedRaw?: string): string {
	const lines = content.split("\n");
	const idx = resolveLineIndex(lines, lineIndex, expectedRaw);
	if (idx === -1) return content;
	const target = idx + delta;
	if (target < 0 || target >= lines.length) return content;
	if (!/^- \[[ x]\]/.test(lines[idx]) || !/^- \[[ x]\]/.test(lines[target])) return content;
	const tmp = lines[idx];
	lines[idx] = lines[target];
	lines[target] = tmp;
	return lines.join("\n");
}

/** Append a task line inside the `## ✅ 今日打卡` section (after the last task). */
export function appendCheckItem(content: string, line: string): string {
 	const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith(CHECK_HEADING));
  if (headingIdx === -1) {
		return content.replace(/\s*$/, "\n\n" + CHECK_HEADING + "\n" + line + "\n");
	}
	let insertIdx = headingIdx + 1;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) break;
		if (/^- \[[ x]\]/.test(lines[i])) insertIdx = i + 1;
	}
	lines.splice(insertIdx, 0, line);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// v7.22 补卡（backfill）：在**目标日期**那篇日记里定位 / 勾选 / 追加打卡行
//
// 为什么需要这一组（补卡踩坑第 2 坑）：
//   补卡写的是**另一篇**文件，行号完全不同（今天第 2 行 ≠ 昨天第 2 行），
//   所以 `toggleTaskLine(content, item.line, ...)` 那种「按行号改」在这里一律不能用
//   —— 拿今天的行号去改昨天，会改错行（项目里 toggleTaskLine 的兜底是「按 raw 文本
//   找」，找不到就原样返回；跨文件时 raw 也不一样，于是静默不动，用户只看到
//   「补卡没反应」）。
//
//   唯一可靠的锚点是**打卡项名**（界面上显示的那串，如 `✍️ 写作`）。它由
//   `checkDisplayText` 产出，两侧同源，所以能在目标文件里唯一定位。
// ---------------------------------------------------------------------------

/**
 * v7.22 补卡：在打卡区内**按计划名**找那一行，返回行号；找不到返回 -1。
 *
 * ## 为什么用「计划名」而不是「显示名」——单测实测出来的结论（重要）
 *
 * 第一版按界面显示名（`✍️ 写作`）匹配，单测直接挂了：真库里 `2026-10-01.md`
 * 那种老行写的是 `✍️ 写作 1小时`、复盘行是 `📈 复盘 复盘+次日计划 → [[... 复盘]]`，
 * 而界面名已经把这些剥干净了。两侧形态不同，而 `stripLegacyDuration` 的闸门
 * （「剥完必须正好等于计划标准名」）在**拿不到 plan 上下文时根本不触发** ——
 * 也就是说，按显示名匹配注定对不上历史行。
 *
 * 改用计划名（`#计划/写作`）后：
 *   · 它写在任务行的 `#计划/` 标签里，**不参与任何显示层剥离**，两侧逐字相同；
 *   · 复盘项、写作项、健康项都能对上，包括带 `1小时` 后缀的老行；
 *   · 唯一前提是**同一计划在同一天只有一个打卡项** —— 这正是插件的数据模型
 *     （打卡项由「计划」推导，见 buildDefaultCheckItems；重复计划打卡项
 *     本来就会让统计口径失真）。
 *   · 边界回退：没有 `#计划/` 标签的手写行 → 退回按归一名匹配，尽量找到。
 *
 * @param plan 计划名（对应 `#计划/{plan}`），主锚点
 * @param displayName 界面显示名，仅用于无计划标签时的回退匹配
 */
export function findCheckLineByPlan(content: string, plan: string | null, displayName: string): number {
	const lines = content.split("\n");
	let inCheckSection = false;
	let fallback = -1;
	const wantName = normalizeCheckName(displayName);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) {
			inCheckSection = line.startsWith(CHECK_HEADING);
			continue;
		}
		if (!inCheckSection) continue;
		const m = TASK_LINE_RE.exec(line);
		if (!m) continue;
		// 主锚点：计划名逐字比对（两侧形态一致，不受显示层剥离影响）
		if (plan && m[3] === plan) return i;
		// 回退：手写行没有 #计划/ 标签时，按归一名匹配。
		// ⚠️ 判「无标签」必须用 == null 而不是 === null —— 正则的可选组没参与匹配时
		//   捕获组是 **undefined**（不是 null）。单测实测：写 `=== null` 回退路径永不触发。
		if (fallback === -1 && m[3] == null && normalizeCheckName(m[2]) === wantName) fallback = i;
	}
	return fallback;
}

/** 勾/取消某行（按行号）。找不到或行型不对时原样返回，fail-safe。 */
export function setCheckLineChecked(content: string, lineIndex: number, checked: boolean): string {
	const lines = content.split("\n");
	const line = lines[lineIndex];
	if (line === undefined || !/^- \[[ x]\]/.test(line)) return content;
	lines[lineIndex] = line.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// v7.5: 打卡记录区（`## ⏱ 打卡记录`）
//
// 为什么单开一区而不是写进任务行：任务行是 Tasks 格式（PRD §2），多加字段会污染
// 解析器与其它插件（Tasks/Dataview）；而「本次完成 / 用时 / 日期」是打卡的**过程量**，
// 和任务本身的完成状态不是一回事，分开存最安全。
// ---------------------------------------------------------------------------

/** 记录行锚点：`- {日期} · {打卡项} ·`——同一「日期 + 打卡项」只保留一条。 */
function logAnchor(date: string, key: string): string {
	return `- ${date} · ${key} ·`;
}

/**
 * 记录行是否属于「某日期 + 某打卡项」。
 *
 * v7.7：打卡项名（key）里不再带复盘链接尾段，但**历史上已经写进笔记的记录行**带过
 * （`- 2026-10-01 · 📈 复盘 → [[2026-10-01 复盘]] · 用时 30 分钟`）。若只比一种写法，
 * 再点一次打卡会**认不出旧行** → 同一天记两条。所以两种写法都认。
 */
function logLineMatches(line: string, date: string, key: string): boolean {
	if (line.startsWith(logAnchor(date, key))) return true;
	// 旧写法：项名后面紧跟复盘链接，`·` 在链接之后
	return key.includes("→ [[") === false && line.startsWith(`- ${date} · ${key} → [[`);
}

/** 记录区在文中的插入位置：优先 `## 📝 今日总结` 之前，没有就落到文末。 */
function insertLogBlock(lines: string[], block: string[]): string[] {
	const anchor = lines.findIndex((l) => l.startsWith(SUMMARY_HEADING));
	if (anchor !== -1) {
		lines.splice(anchor, 0, ...block);
		return lines;
	}
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	lines.push("", ...block);
	return lines;
}

/**
 * 写入 / 更新一条打卡记录（v7.5）。
 * 已存在同「日期 + 打卡项」的行则整行替换（重复打卡不刷屏），否则追加到记录区末尾。
 */
export function upsertCheckLog(content: string, date: string, key: string, detail: string): string {
	const lines = content.split("\n");
	const line = `${logAnchor(date, key)} ${detail}`.trimEnd();
	const headIdx = lines.findIndex((l) => l.startsWith(LOG_HEADING));
	if (headIdx === -1) {
		return insertLogBlock(lines, [LOG_HEADING, "", line, ""]).join("\n");
	}
	// 记录区右边界 = 下一个 `##` 标题（或文末）
	let end = lines.length;
	for (let i = headIdx + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	for (let i = headIdx + 1; i < end; i++) {
		if (logLineMatches(lines[i], date, key)) {
			lines[i] = line;
			return lines.join("\n");
		}
	}
	// 追加到区内最后一条记录之后（跳过尾部空行，保住与下个标题之间的空行）
	let insert = end;
	while (insert - 1 > headIdx && lines[insert - 1].trim() === "") insert--;
	lines.splice(insert, 0, line);
	return lines.join("\n");
}

/**
 * 删除一条打卡记录（取消打卡时调用）；行不存在则原样返回。
 *
 * v7.5 真机补修：删完记录行后若区内「一条记录都不剩」，连 `## ⏱ 打卡记录` 标题一起撤掉。
 * 为什么必须撤：这条路径是**取消打卡**，用完即弃；留着空标题等于在用户笔记里
 * 留一个空壳（实测留成 `## ⏱ 打卡记录` + 两行空白），且每取消一次就多一层空白。
 * 注意不能一刀切：区内还可能留着别的日期（今天补打卡昨天），那时只删这一行。
 */
export function removeCheckLog(content: string, date: string, key: string): string {
	const lines = content.split("\n");
	const headIdx = lines.findIndex((l) => l.startsWith(LOG_HEADING));
	if (headIdx === -1) return content;
	const blockEnd = (from: number): number => {
		for (let i = from + 1; i < lines.length; i++) {
			if (/^##\s/.test(lines[i])) return i;
		}
		return lines.length;
	};

	for (let i = headIdx + 1, end = blockEnd(headIdx); i < end; i++) {
		if (!logLineMatches(lines[i], date, key)) continue;
		lines.splice(i, 1);

		const end2 = blockEnd(headIdx);
		const hasRecord = lines.slice(headIdx + 1, end2).some((l) => l.trim().startsWith("- "));
		if (hasRecord) return lines.join("\n");

		// 空壳：标题 + 区内残留行一起移除
		lines.splice(headIdx, end2 - headIdx);
		if (headIdx > 0 && headIdx < lines.length && lines[headIdx - 1].trim() === "" && lines[headIdx].trim() === "") {
			lines.splice(headIdx, 1); // 标题前后各留一个空行 → 收掉一个，别留下双空行
		} else if (headIdx >= lines.length) {
			while (lines.length > 1 && lines[lines.length - 1].trim() === "" && lines[lines.length - 2].trim() === "") {
				lines.pop(); // 区在文末：收掉多余的尾随空行
			}
		}
		return lines.join("\n");
	}
	return content;
}

// ---------------------------------------------------------------------------
// Note templates
// ---------------------------------------------------------------------------

export interface BuildCheckLineParams {
	name: string;
	plan: string;
	includeReview: boolean;
	date: string;
	/** v7.19: 🛫 起始日期；缺省回落到 date（当天）。 */
	start?: string;
	/** v7.19: 📅 截止日期；缺省回落到 date（当天）。 */
	due?: string;
}

/**
 * Build a task line, e.g. `- [ ] ✍️ 写作 #计划/写作 🛫 2026-08-11 📅 2026-08-11`.
 *
 * v7.6：不再拼 `action`（原「1小时」后缀）。用户口径——打卡记的是**当天行动内容 + 用时**，
 * 那是打卡那一刻才填的（行内「用时」框），不该由计划定义预先写死进标题。
 * v7.19：🛫/📅 支持自定义（添加打卡项弹窗的「起止日期」）——量化目标分解到日的人工补充；
 * 不传则维持原行为（起止都是当天）。
 */
export function buildCheckLine({ name, plan, includeReview, date, start, due }: BuildCheckLineParams): string {
	let content = name;
	if (includeReview) content += ` → [[${date} 复盘]]`;
	return `- [ ] ${content} #计划/${plan} 🛫 ${start || date} 📅 ${due || date}`;
}

/** `→ [[2026-10-01 复盘]]` 这种复盘链接尾段（由 includeReview 生成，不算标题本体）。 */
const REVIEW_LINK_RE = / → \[\[[^\]]*\]\]$/;

/**
 * v7.7：剥掉复盘链接尾段——**界面标题专用**。
 *
 * 为什么只剥不改原文：`→ [[{date} 复盘]]` 是 note 行里的真 wikilink（用户在 Obsidian 里
 * 点是能跳转的），而且是设置项「含复盘链接」的产物；所以笔记原文一字不动，
 * 只是**打卡卡上不再渲染这一截**（用户 113001 截图：「复盘后面的后缀也没必要」）。
 *
 * ⚠️ 打卡记录行的项名（key）走的也是这个值，两处必须一致，否则取消打卡找不到记录行。
 */
export function stripReviewLink(text: string): string {
	return text.replace(REVIEW_LINK_RE, "");
}
/** 兜底：只认「数字 + 时长单位」结尾，避免误伤正常标题。 */
const DURATION_TAIL_RE = / ([\d.]+)\s*(小时|分钟|分|h|H|min|mins)$/;

/**
 * v7.6：剥掉历史遗留的「时长后缀」——老笔记任务行写着 `✍️ 写作 1小时`（action 由计划定义预写）。
 * 纯显示层剥离，**不改笔记原文**。
 *
 * 判定顺序：
 *   ① 与计划定义里的 `action` 精确匹配 —— 能吃掉「复盘+次日计划」这类非时长词；
 *   ② 末尾是「数字 + 时长单位」时，**只有当剥完正好等于该计划的标准打卡项名**
 *      （`{label} {计划名}`，如 `📖 学习`）才剥。
 *      这条闸门是必须的：没有它，「阅读 30 分钟」会被削成「阅读」——
 *      而「名称里自带时长」是合法写法（添加打卡项弹窗的示例就是它）。
 *
 * 另一个坑：复盘项的行文是 `📈 复盘 {action} → [[{date} 复盘]]`，action **不在末尾**，
 * 中间隔着复盘链接。所以先把链接尾段摘下来单独放回，再对剩余部分做剥离。
 */
export function stripLegacyDuration(text: string, action?: string, canonicalName?: string): string {
	const t = text.trimEnd();
	const linkMatch = REVIEW_LINK_RE.exec(t);
	const link = linkMatch ? linkMatch[0] : "";
	let head = linkMatch ? t.slice(0, linkMatch.index).trimEnd() : t;

	const a = (action ?? "").trim();
	if (a && head.endsWith(" " + a)) {
		head = head.slice(0, -(a.length + 1)).trimEnd();
		return head + link;
	}

	const m = DURATION_TAIL_RE.exec(head);
	if (m) {
		const rest = head.slice(0, m.index).trimEnd();
		const canon = (canonicalName ?? "").trim();
		if (canon && rest === canon) head = rest;
	}
	return head + link;
}

/**
 * v7.22 补卡：把打卡项名归一到「可比形态」，用于**回退**匹配（无 `#计划/` 标签的行）。
 *
 * 剥两层：复盘链接尾段（`→ [[2026-10-02 复盘]]`）+ 时长后缀（`1小时`）——
 * 这两类都是显示层早于笔记原文剥掉的，界面侧看不到、笔记里还在。
 *
 * ⚠️ 单测实测结论：**它只能当回退，不能当主锚点**。
 *   `stripLegacyDuration` 的闸门（②）要求「剥完正好等于计划标准名」才剥，
 *   而这里没有 plan 上下文、传不了 canonicalName → 对 `✍️ 写作 1小时` 不触发。
 *   所以带历史后缀的老行**归一后仍与界面名不等** —— 主锚点必须是计划名。
 *   见 findCheckLineByPlan 的说明。
 */
export function normalizeCheckName(text: string): string {
	return stripLegacyDuration(stripReviewLink(text)).replace(/\s+/g, " ").trim();
}

/** Template for a new daily note (PRD §2.2). */
export function buildDailyTemplate(date: string, templates: PlanTemplate[]): string {
	const tasks = templates.map((t) =>
		buildCheckLine({
			name: t.name,
			plan: t.plan,
			includeReview: t.includeReview,
			date,
			// v7.21: 量化到每日打卡的自定义项带自己的窗口（🛫/📅）；普通项不传 = 当天（原行为）
			start: t.start,
			due: t.due,
		})
	);
	return [
		"---",
		`date: ${date}`,
		"type: daily",
		"---",
		`# 📅 ${date} ${weekdayName(date)}`,
		"",
		CHECK_HEADING,
		tasks.join("\n"),
		"",
		SUMMARY_HEADING,
		// v1.7.4: 删除默认总结 bullet（用户已删过这些文本，新建笔记不应再写入）
		"",
	].join("\n");
}

/**
 * Build a review note from the user-configured template.
 * `{date}` placeholders are replaced with the given date.
 * (v1.8: template moved to settings.reviewTemplate — before that it was hard-coded,
 *  which meant every vault got the author's personal review format.)
 */
export function buildReviewTemplate(date: string, template: string): string {
	return template.replace(/\{date\}/g, date);
}

// ---------------------------------------------------------------------------
// Temp tasks from week/month frontmatter (PRD §2.3)
// ---------------------------------------------------------------------------

/**
 * Parse `temp-tasks` from a week/month note's frontmatter.
 * Supports the multiline block (`temp-tasks: |`) and array-of-strings forms;
 * array-of-objects ({name, start, end}) is surfaced as read-only info.
 */
export function parseTempTasksFromFrontmatter(
	content: string,
	file: TFile,
	source: "week" | "month"
): TempTask[] {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return [];
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return [];
	}
	const raw = data?.["temp-tasks"];
	if (raw === undefined || raw === null) return [];

	const tasks: TempTask[] = [];
	if (typeof raw === "string") {
		raw.split("\n").forEach((line, i) => {
			const t = parseTaskLine(line);
			if (!t) return;
			tasks.push({
				text: t.text,
				plan: t.plan,
				checked: t.checked,
				due: t.due,
				start: null,
				source,
				file,
				index: i,
				line: -1,
				raw: line.trim(),
				togglable: true,
			});
		});
	} else if (Array.isArray(raw)) {
		raw.forEach((el, i) => {
			if (typeof el === "string") {
				const t = parseTaskLine(el);
				if (!t) return;
				tasks.push({
					text: t.text,
					plan: t.plan,
					checked: t.checked,
					due: t.due,
					start: null,
					source,
					file,
					index: i,
					line: -1,
					raw: el.trim(),
					togglable: true,
				});
			} else if (el && typeof el === "object") {
				const obj = el as Record<string, unknown>;
				const start = typeof obj.start === "string" ? obj.start : null;
				const end = typeof obj.end === "string" ? obj.end : null;
				tasks.push({
					text: typeof obj.name === "string" ? obj.name : JSON.stringify(obj),
					plan: null,
					checked: false,
					due: end ?? start ?? null,
					start,
					source,
					file,
					index: i,
					line: -1,
					raw: "",
					togglable: false,
				});
			}
		});
	}
	return tasks;
}

/** Whether a temp task is due or active on the given date. */
export function isActiveToday(task: TempTask, today: string): boolean {
	if (task.due === today) return true;
	if (!task.due && task.start === today) return true;
	if (task.start && task.due && task.start <= today && today <= task.due) return true;
	return false;
}

/** Toggle a temp task in its source file. */
export async function toggleTempTask(app: App, task: TempTask, checked: boolean): Promise<string> {
	if (task.source === "daily") {
		return app.vault.process(task.file, (data) => toggleTaskLine(data, task.line, checked));
	}
	return app.vault.process(task.file, (data) =>
		setTempTaskCheckedInFrontmatter(data, task.index, checked)
	);
}

/**
 * Toggle the Nth task inside a week/month note's frontmatter `temp-tasks`.
 * Re-serializes the frontmatter with parseYaml/stringifyYaml (DEV.md #5) —
 * preserves all other keys and the note body.
 */
export function setTempTaskCheckedInFrontmatter(
	content: string,
	taskIndex: number,
	checked: boolean
): string {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return content;
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return content;
	}
	const tt = data?.["temp-tasks"];
	const marker = checked ? "- [x]" : "- [ ]";
	let changed = false;

	if (typeof tt === "string") {
		const lines = tt.split("\n");
		if (taskIndex >= 0 && taskIndex < lines.length && /^- \[[ x]\]/.test(lines[taskIndex])) {
			lines[taskIndex] = lines[taskIndex].replace(/^- \[[ x]\]/, marker);
			if (data) data["temp-tasks"] = lines.join("\n");
			changed = true;
		}
	} else if (Array.isArray(tt)) {
		const el: unknown = tt[taskIndex];
		if (typeof el === "string" && /^- \[[ x]\]/.test(el)) {
			tt[taskIndex] = el.replace(/^- \[[ x]\]/, marker);
			changed = true;
		}
	}

	if (!changed) return content;
	const newFm = stringifyYaml(data).trimEnd();
	return content.replace(fmMatch[0], `---\n${newFm}\n---`);
}
