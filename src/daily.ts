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

/**
 * Parse a single Tasks-style line (DEV.md §5 踩坑记录 #6).
 * Groups: [1]=checkbox, [2]=content, [3]=plan tag, [4]=🛫 date, [5]=📅 date.
 */
export const TASK_LINE_RE =
	/^- \[([ x])\] (.+?)(?: #计划\/(\S+))?(?: 🛫 (\d{4}-\d{2}-\d{2}))?(?: 📅 (\d{4}-\d{2}-\d{2}))?$/;

/** A check-in item inside the daily note. */
export interface CheckItem {
	/** Task content (no `- [ ]` marker, no plan tag). */
	text: string;
	/** Plan tag name (without `#计划/`), or null for temp tasks. */
	plan: string | null;
	checked: boolean;
	/** Due date `📅` (falls back to scheduled date), or null. */
	due: string | null;
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

/** Number of weekdays (Mon-Fri) in [start, end], inclusive. */
export function countWorkdays(start: string, end: string): number {
	const s = parseDateString(start);
	const e = parseDateString(end);
	let count = 0;
	const cur = new Date(s);
	while (cur <= e) {
		const day = cur.getDay();
		if (day !== 0 && day !== 6) count++;
		cur.setDate(cur.getDate() + 1);
	}
	return count;
}

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

/** Parse a daily note's content into structured data. */
export function parseDailyContent(file: TFile, content: string, date: string): DailyData {
	const lines = content.split("\n");
	const checkItems: CheckItem[] = [];
	const tempItems: TempTask[] = [];
	let inCheckSection = false;

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
			raw: line,
		};
		if (plan) {
			checkItems.push({ ...base, line: i, file });
		} else {
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
	return region.replace(/^\n+/, "").trimEnd();
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

export function toggleTaskLine(content: string, lineIndex: number, checked: boolean): string {
	const lines = content.split("\n");
	const line = lines[lineIndex];
	if (line === undefined || !/^- \[[ x]\]/.test(line)) return content;
	lines[lineIndex] = line.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]");
	return lines.join("\n");
}

export function removeLine(content: string, lineIndex: number): string {
	const lines = content.split("\n");
	if (lineIndex < 0 || lineIndex >= lines.length) return content;
	lines.splice(lineIndex, 1);
	return lines.join("\n");
}

export function moveTaskLine(content: string, lineIndex: number, delta: number): string {
	const lines = content.split("\n");
	const target = lineIndex + delta;
	if (lineIndex < 0 || lineIndex >= lines.length) return content;
	if (target < 0 || target >= lines.length) return content;
	if (!/^- \[[ x]\]/.test(lines[lineIndex]) || !/^- \[[ x]\]/.test(lines[target])) return content;
	const tmp = lines[lineIndex];
	lines[lineIndex] = lines[target];
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
// Note templates
// ---------------------------------------------------------------------------

export interface BuildCheckLineParams {
	name: string;
	duration: string;
	plan: string;
	includeReview: boolean;
	date: string;
}

/** Build a task line, e.g. `- [ ] ✍️ 写作 1小时 #计划/写作 🛫 2026-08-11 📅 2026-08-11`. */
export function buildCheckLine({ name, duration, plan, includeReview, date }: BuildCheckLineParams): string {
	let content = name;
	if (duration && duration.trim()) content += " " + duration.trim();
	if (includeReview) content += ` → [[${date} 复盘]]`;
	return `- [ ] ${content} #计划/${plan} 🛫 ${date} 📅 ${date}`;
}

/** Template for a new daily note (PRD §2.2). */
export function buildDailyTemplate(date: string, templates: PlanTemplate[]): string {
	const tasks = templates.map((t) =>
		buildCheckLine({
			name: t.name,
			duration: t.duration,
			plan: t.plan,
			includeReview: t.includeReview,
			date,
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

/** Template for a review note (matches the user's existing review format). */
export function buildReviewTemplate(date: string): string {
	return `---
type: review
date: ${date}
tags: [复盘]
---
# 📈 A股复盘与交易计划（${date}）

## 一、大盘环境（过滤开关）
- 指数表现：上证＿＿ 深成＿＿ 创业板＿＿ | 两市量能＿＿
- 环境判断：□ 进攻　□ 防守　□ 观望
- 判断理由：
- 情绪温度：涨停＿＿ 跌停＿＿ 连板高度＿＿

## 二、市场主线
- 今日强势板块（行业轮动位置）：
- 主线/题材：
- 板块截图：![[${date} 板块截图.png]]

## 三、持仓与今日操作
| 标的 | 方向 | 成本 | 现价 | 仓位 | 今日操作 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

## 四、纪律检查
- 今日：□ 有信号按计划执行　□ 无信号管住手　□ 违反纪律＿＿
- 冲动交易次数：＿＿
- 盘中情绪：＿＿

## 五、次日交易计划
- 持仓处理：
- 观察池：
  | 标的 | 触发条件 | 计划仓位 |
  | --- | --- | --- |
  |  |  |  |
- 环境预案：高开＿＿ 低开＿＿ 平开＿＿

## 六、今日感想（可选）
`;
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
	let data: any;
	try {
		data = parseYaml(fmMatch[1]);
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
	let data: any;
	try {
		data = parseYaml(fmMatch[1]);
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
			data["temp-tasks"] = lines.join("\n");
			changed = true;
		}
	} else if (Array.isArray(tt)) {
		const el = tt[taskIndex];
		if (typeof el === "string" && /^- \[[ x]\]/.test(el)) {
			tt[taskIndex] = el.replace(/^- \[[ x]\]/, marker);
			changed = true;
		}
	}

	if (!changed) return content;
	const newFm = stringifyYaml(data).trimEnd();
	return content.replace(fmMatch[0], `---\n${newFm}\n---`);
}
