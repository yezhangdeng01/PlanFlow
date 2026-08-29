import { App, Notice, TFile, TFolder } from "obsidian";
import { TASK_LINE_RE, parseDateString, removeLine, toggleTaskLine, weekRange } from "./daily";

/**
 * Task pool (`{root}/{year}/任务.md`) — PRD §0, DEV.md M2.
 *
 * All plan-decomposed tasks live here in Tasks format:
 *   `- [ ] 完成《霍去病》文章 #计划/写作 🛫 2026-08-10 📅 2026-08-16`
 *
 * Every mutation goes through `vault.process` so unrelated content in the
 * pool file is preserved.
 */

/** A task inside the pool file. */
export interface PoolTask {
	/** Task content (no `- [ ]` marker, no plan tag). */
	text: string;
	/** Plan tag name (without `#计划/`), or null. */
	plan: string | null;
	checked: boolean;
	/** Scheduled date `🛫`, or null. */
	start: string | null;
	/** Due date `📅`, or null. */
	due: string | null;
	/** 0-based line index inside the pool file. */
	line: number;
	/** Full raw line. */
	raw: string;
	/** The pool file this task lives in. */
	file: TFile;
}

/** Input for creating / editing a task (checked state is preserved on edit). */
export interface NewTaskInput {
	text: string;
	plan: string | null;
	start: string | null;
	due: string | null;
}

/** Path of the task pool file for a given year. */
export function poolPath(rootPath: string, year: string): string {
	const root = rootPath.replace(/\/+$/, "");
	return `${root}/${year}/任务.md`;
}

/** Parse a task pool file's content into tasks. */
export function parseTaskPool(file: TFile, content: string): PoolTask[] {
	const tasks: PoolTask[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = TASK_LINE_RE.exec(lines[i]);
		if (!m) continue;
		tasks.push({
			text: m[2].trim(),
			plan: m[3] ?? null,
			checked: m[1] === "x",
			start: m[4] ?? null,
			due: m[5] ?? null,
			line: i,
			raw: lines[i],
			file,
		});
	}
	return tasks;
}

/** Read all tasks from the pool; returns an empty array when the file doesn't exist. */
export async function listTasks(app: App, rootPath: string, year: string): Promise<PoolTask[]> {
	const f = app.vault.getAbstractFileByPath(poolPath(rootPath, year));
	if (!(f instanceof TFile)) return [];
	const content = await app.vault.cachedRead(f);
	return parseTaskPool(f, content);
}

/** Build a Tasks-format line for the pool. */
export function buildPoolLine({ text, plan, start, due }: NewTaskInput): string {
	let line = `- [ ] ${text.trim()}`;
	if (plan && plan.trim()) line += ` #计划/${plan.trim()}`;
	if (start) line += ` 🛫 ${start}`;
	if (due) line += ` 📅 ${due}`;
	return line;
}

/** Add a task to the pool (creates the pool file / folders if missing). */
export async function addTask(app: App, rootPath: string, year: string, input: NewTaskInput): Promise<void> {
	const path = poolPath(rootPath, year);
	const line = buildPoolLine(input);
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (folder) await ensureFolder(app, folder);

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.process(existing, (data) => appendLine(data, line));
		return;
	}
	await app.vault.create(path, line + "\n");
}

/** Toggle a task's checkbox and write it back. */
export async function toggleTask(app: App, task: PoolTask, checked: boolean): Promise<void> {
	await app.vault.process(task.file, (data) => {
		const idx = locateTaskLine(data, task);
		if (idx === -1) {
			new Notice("任务已变动，勾选未执行（请刷新视图后重试）");
			return data;
		}
		return toggleTaskLine(data, idx, checked);
	});
}

/** Replace a task's content / plan / dates, keeping its checked state. */
export async function editTask(app: App, task: PoolTask, input: NewTaskInput): Promise<void> {
	await app.vault.process(task.file, (data) => {
		const idx = locateTaskLine(data, task);
		if (idx === -1) {
			new Notice("任务已变动，修改未保存（请刷新视图后重试）");
			return data;
		}
		const lines = data.split("\n");
		// v2.5 (B1): 字段级编辑——只替换插件认识的字段，保留行内其他手动内容（禁止整行重建）
		lines[idx] = editTaskLine(lines[idx], input, task.checked);
		return lines.join("\n");
	});
}

/** Delete a task line from the pool. */
export async function deleteTask(app: App, task: PoolTask): Promise<void> {
	await app.vault.process(task.file, (data) => {
		const idx = locateTaskLine(data, task);
		if (idx === -1) {
			new Notice("任务已变动，删除未执行（请刷新视图后重试）");
			return data;
		}
		return removeLine(data, idx);
	});
}

/**
 * v2.5 (B2): 内容定位（替代解析时行号快照）——文件被外部修改后行号会漂移，
 * 盲按行号写回会作用到错误行。先按 raw 精确匹配，再按 text 前缀兜底，都找不到则 -1（fail-safe）。
 */
function locateTaskLine(data: string, task: PoolTask): number {
	const lines = data.split("\n");
	const byRaw = lines.findIndex((l) => l === task.raw);
	if (byRaw !== -1) return byRaw;
	const prefix = `- [${task.checked ? "x" : " "}] ${task.text}`;
	return lines.findIndex((l) => l.startsWith(prefix));
}

/**
 * v2.5 (B1): 字段级编辑任务行——只替换前缀/文本/计划标签/起止日期，
 * 原行中其他手动内容（备注、额外标签等）原样保留。
 */
function editTaskLine(line: string, input: NewTaskInput, checked: boolean): string {
	let l = line;
	// 1. 前缀（保留勾选状态）
	l = l.replace(/^- \[[ x]\]/, checked ? "- [x]" : "- [ ]");
	// 2. 文本区：行首到第一个字段标记（# / 🛫 / 📅）之间替换为新文本（u flag：emoji 是代理对）
	l = l.replace(/^[^#🛫📅]+/u, `${input.text.trim()} `);
	// 3. 计划标签：删旧 → 加新（无则不加）
	l = l.replace(/#计划\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
	if (input.plan && input.plan.trim()) l += ` #计划/${input.plan.trim()}`;
	// 4. 开始日期
	l = l.replace(/🛫\s*\S+/g, "").replace(/\s{2,}/g, " ").trim();
	if (input.start) l += ` 🛫 ${input.start}`;
	// 5. 截止日期
	l = l.replace(/📅\s*\S+/g, "").replace(/\s{2,}/g, " ").trim();
	if (input.due) l += ` 📅 ${input.due}`;
	return l;
}

/** Append a line to content, always terminating it with a single newline. */
function appendLine(content: string, line: string): string {
	if (!content.trim()) return line + "\n";
	return content.replace(/\s+$/, "") + "\n" + line + "\n";
}

/** Create folders along a vault path (no-op for existing ones). */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = folderPath.split("/").filter(Boolean);
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(cur);
		if (existing instanceof TFolder) continue;
		if (existing) {
			new Notice(`路径冲突：${cur}`);
			return;
		}
		await app.vault.createFolder(cur);
	}
}

// ---------------------------------------------------------------------------
// v1.2: automatic weekly decomposition for quantity-type plans (DEV.md v1.2)
// ---------------------------------------------------------------------------

/** A quantified goal under a plan (v1.2: plans are categories, goals carry counts). */
export interface AutoGoal {
	/** Goal name shown on tasks: 「{name}（第 N {unit}）」. */
	name: string;
	/** Target quantity. */
	count: number;
	/** Counter noun (篇/本/条/个/…). */
	unit: string;
	/** Optional custom window (defaults to the plan period). */
	start?: string;
	end?: string;
}

/** A quantity-type plan eligible for auto task generation. */
export interface AutoTaskPlan {
	/** Plan name / label, e.g. "写作". */
	name: string;
	/** Target description, e.g. "12 篇公众号文章" (legacy unit fallback). */
	target: string;
	/** Numeric target, e.g. 12. */
	targetCount: number;
	/** Quantified goals (v1.2). Empty → legacy plan-level decomposition. */
	goals: AutoGoal[];
}

export const DAY_MS = 86400000;

/** Counter nouns accepted in auto task names («label（第 N 篇）»). */
const AUTO_UNIT_RE = /（第\s*(\d+)\s*(?:篇|本|条|个|部|期|集|次|份|张|幅|门|天)）$/;

/** ISO-week context for auto-task quotas. */
export interface AutoWeekContext {
	/** 1-based index of the current week within the plan's week sequence. */
	weekIndex: number;
	/** Total number of ISO weeks in the plan period. */
	totalWeeks: number;
	/** This week's Monday (ISO date). */
	weekStart: string;
	/** This week's Sunday (ISO date). */
	weekEnd: string;
}

/**
 * Extract the counter noun from a plan target (篇/本/…/天), defaulting to 篇.
 * Used for auto task names and progress numbers (e.g. "0/144 天").
 */
export function planCounterUnit(target: string): string {
	const m = /(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天)/.exec(target);
	return m ? m[2] : "篇";
}

/** Whether a pool task looks like an auto-generated task («（第 N 篇）」suffix). */
export function isAutoTask(task: PoolTask): boolean {
	return AUTO_UNIT_RE.test(task.text.trim());
}

/**
 * Compute the ISO-week context for auto-task quotas.
 * Returns null when `today` is outside the plan's week range (before start
 * or after the final week — nothing to generate then).
 */
export function autoWeekContext(planStart: string, planEnd: string, today: string): AutoWeekContext | null {
	// Strict date-level guard: the plan period hasn't started yet (or is over).
	if (today < planStart || today > planEnd) return null;

	const startMon = weekRange(planStart).start;
	const endMon = weekRange(planEnd).start;
	const thisMon = weekRange(today).start;
	if (thisMon < startMon || thisMon > endMon) return null;

	const totalWeeks = Math.round((parseDateString(endMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
	const rawIndex = Math.round((parseDateString(thisMon).getTime() - parseDateString(startMon).getTime()) / (DAY_MS * 7)) + 1;
	const weekIndex = Math.max(1, Math.min(rawIndex, Math.max(totalWeeks, 1)));
	return { weekIndex, totalWeeks, weekStart: thisMon, weekEnd: weekRange(today).end };
}

/**
 * Cumulative quota through week N (DEV.md v1.2):
 * `quota_n = ceil(targetCount × n / totalWeeks)`; each week generates
 * `quota_n - quota_{n-1}` tasks (0/1/2).
 */
export function autoQuota(targetCount: number, weekIndex: number, totalWeeks: number): number {
	if (targetCount <= 0 || totalWeeks <= 0) return 0;
	return Math.ceil((targetCount * weekIndex) / totalWeeks);
}

/**
 * Generate this week's auto tasks for quantity-type plans (DEV.md v1.2).
 *
 * Idempotent: a task whose name already matches an existing auto task for the
 * plan is never duplicated (checked or not). Manual tasks — names not matching
 * the auto pattern — are ignored and don't affect the count.
 *
 * Task naming: `{label}（第 N 篇）`, N continuing from the highest existing
 * auto-task number. New tasks are dated to this week's window (🛫 Mon 📅 Sun).
 */
/**
 * Compute the N values of the auto tasks to create this week.
 * Continues from the highest existing auto-task number (avoids re-using a
 * number when a middle task was deleted) and skips names that already exist.
 */
export function autoTaskNumbers(
	existingAuto: PoolTask[],
	need: number,
	targetCount: number,
	label: string,
	unit: string
): number[] {
	let maxN = 0;
	for (const t of existingAuto) {
		const m = AUTO_UNIT_RE.exec(t.text.trim());
		if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
	}
	const nums: number[] = [];
	let n = maxN + 1;
	while (nums.length < need && n <= targetCount) {
		const name = `${label}（第 ${n} ${unit}）`;
		if (!existingAuto.some((t) => t.text.trim() === name)) nums.push(n);
		n++;
	}
	return nums;
}

export async function ensureAutoTasks(
	app: App,
	rootPath: string,
	year: string,
	today: string,
	plans: AutoTaskPlan[],
	planStart: string,
	planEnd: string
): Promise<void> {
	if (plans.length === 0) return;
	const ctx = autoWeekContext(planStart, planEnd, today);
	if (!ctx) return;

	const tasks = await listTasks(app, rootPath, year);

	for (const plan of plans) {
		// v1.2: 全量分解——count 个任务一次生成，日期均匀分布在 goal 窗口内
		for (const goal of plan.goals) {
			if (goal.count <= 0) continue;
			const gStart = goal.start ?? planStart;
			const gEnd = goal.end ?? planEnd;
			// v1.5: 未来窗口也全量生成（提前可见规划）；仅跳过已结束窗口
			if (today > gEnd) continue;
			const totalDays = Math.max(1, Math.round((parseDateString(gEnd).getTime() - parseDateString(gStart).getTime()) / DAY_MS) + 1);
			const prefix = `${goal.name}（`;
			const existing = tasks.filter((t) => t.plan === plan.name && t.text.trim().startsWith(prefix));
			const need = goal.count - existing.length;
			if (need <= 0) continue;

			const nums = autoTaskNumbers(existing, need, goal.count, goal.name, goal.unit);
			for (const n of nums) {
				const name = `${goal.name}（第 ${n} ${goal.unit}）`;
				// v1.5 跨度任务：任务 n 从分配日到下一个任务分配日前一天（最后一个到窗口末）
				const startDate = addDaysStr(gStart, Math.floor(((n - 1) * totalDays) / goal.count));
				let dueDate: string;
				if (n < goal.count) {
					dueDate = addDaysStr(gStart, Math.floor((n * totalDays) / goal.count) - 1);
				} else {
					dueDate = gEnd;
				}
				if (dueDate < startDate) dueDate = startDate;
				await addTask(app, rootPath, year, { text: name, plan: plan.name, start: startDate, due: dueDate });
			}
		}
		// Legacy fallback: plans without goals decompose at plan level (full split).
		if (plan.goals.length === 0 && plan.targetCount > 0) {
			if (today > planEnd) continue;
			const totalDays = Math.max(1, Math.round((parseDateString(planEnd).getTime() - parseDateString(planStart).getTime()) / DAY_MS) + 1);
			const unit = planCounterUnit(plan.target);
			const auto = tasks.filter((t) => t.plan === plan.name && isAutoTask(t));
			const need = plan.targetCount - auto.length;
			if (need <= 0) continue;

			const nums = autoTaskNumbers(auto, need, plan.targetCount, plan.name, unit);
			for (const n of nums) {
				const name = `${plan.name}（第 ${n} ${unit}）`;
				// v1.5 跨度任务（同 goals 分解逻辑）
				const startDate = addDaysStr(planStart, Math.floor(((n - 1) * totalDays) / plan.targetCount));
				let dueDate: string;
				if (n < plan.targetCount) {
					dueDate = addDaysStr(planStart, Math.floor((n * totalDays) / plan.targetCount) - 1);
				} else {
					dueDate = planEnd;
				}
				if (dueDate < startDate) dueDate = startDate;
				await addTask(app, rootPath, year, { text: name, plan: plan.name, start: startDate, due: dueDate });
			}
		}
	}
}

/** Add n days to an ISO date string, e.g. addDaysStr("2026-08-12", 3) → "2026-08-15". */
function addDaysStr(date: string, n: number): string {
	const d = new Date(parseDateString(date).getTime() + n * DAY_MS);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}
