import { App, TFile, parseYaml } from "obsidian";
import {
	countWorkdays,
	dayCount,
	daysInMonth,
	getISOWeek,
	parseDailyContent,
	parseTempTasksFromFrontmatter,
	weekRange,
} from "./daily";
import type { PoolTask } from "./tasks";
import { listTasks } from "./tasks";

/**
 * Statistics (PRD §2.4, 口径 must match the user's legacy system):
 * - 计划打卡率 = days the plan was checked in ÷ expected days in the period
 *   - 写作/健康/学习: expected = total days (week=7, month=month days, year=days since Jan 1)
 *   - 复盘: expected = workdays in the period (unless reviewWorkdays is off)
 * - 临时任务完成率 = completed ÷ total (filtered by period)
 * - 今日进度 = today's checked items ÷ today's total (computed in the view)
 * - M2: 周/月任务统计 = tasks in the period window (from the task pool) done ÷ total
 * - M2: 年度计划进度 = 数量型 uses completed tasks, 打卡型 uses check-in rate
 */

export type PeriodType = "week" | "month" | "year";

export interface PlanRate {
	plan: string;
	/** Days checked in during the period. */
	done: number;
	/** Expected days per PRD §2.4. */
	total: number;
	/** 0-100. */
	percent: number;
}

/** A quantified goal under a plan (v1.2: plans are categories, goals carry counts). */
export interface PlanGoal {
	/** Goal name shown on tasks: 「{name}（第 N {unit}）」. */
	name: string;
	/** Target quantity. */
	count: number;
	/** Counter noun (篇/本/条/个/…), defaults to 个. */
	unit: string;
	/** Optional custom window (defaults to the plan period). */
	start?: string;
	end?: string;
}

/** A plan definition read from the annual note's frontmatter `plans` (read-only). */
export interface PlanDef {
	name: string;
	type: "numeric" | "check";
	/** Target description text, e.g. "12 篇公众号文章". */
	target: string;
	/** Target count: Σ goals.count, or regex fallback from target for legacy data. */
	targetCount: number;
	/** Quantified goals under this plan (v1.2). Empty for pure check-in plans. */
	goals: PlanGoal[];
	/** Daily check-in action label, e.g. "1小时". */
	action: string;
	/** Icon prefix, e.g. "✍️". */
	label: string;
	/** Plan color (settings override), e.g. "#f59e0b". */
	color: string;
	/** Trading-day-only check-in (复盘). */
	tradingDay: boolean;
}

/** Progress of one goal under a plan. */
export interface PlanGoalProgress extends PlanGoal {
	/** Completed tasks whose name starts with `${goal.name}（`. */
	done: number;
	/** 0-100. */
	percent: number;
}

/** Combined annual plan progress for a single plan (homepage goal card / year view). */
export interface PlanProgress {
	plan: string;
	target: string;
	/** true when quantity-type (progress advances by completed tasks). */
	isNumeric: boolean;
	/** Target count for numeric plans, 0 otherwise. */
	targetCount: number;
	/** Completed tasks under this plan (numeric progress). */
	doneCount: number;
	/** Check-in days for check-type plans. */
	checkDone: number;
	/** Expected check-in days for check-type plans. */
	checkTotal: number;
	/** Check-in rate percent for check-type plans. */
	checkPercent: number;
	/** Display percent (numeric → task progress; check → check-in rate). */
	percent: number;
	/** All pool tasks belonging to this plan. */
	tasks: PoolTask[];
	/** Per-goal progress (v1.2). Empty for pure check-in plans. */
	goals: PlanGoalProgress[];
	/** Daily check-in action label, e.g. "1小时". */
	action: string;
	/** Icon prefix, e.g. "✍️". */
	label: string;
	/** Plan color (settings override), e.g. "#f59e0b". */
	color: string;
	/** Trading-day-only check-in (复盘). */
	tradingDay: boolean;
}

export interface PeriodStats {
	type: PeriodType;
	/** e.g. "2026-W33" / "2026-08" / "2026". */
	label: string;
	/** e.g. "8/10 ~ 8/16". */
	rangeLabel: string;
	planRates: PlanRate[];
	tempTotal: number;
	tempDone: number;
	tempPercent: number;
	/** M2: tasks in the period window (from the task pool). */
	taskTotal: number;
	taskDone: number;
	taskPercent: number;
	tasks: PoolTask[];
	/** M2: annual plan progress (year only; empty for other periods). */
	planProgress: PlanProgress[];
}

export interface PlanPeriod {
	start: string;
	end: string;
}

/**
 * Read the annual plan's period (start/end) from its frontmatter.
 * Prefers `{root}/{year}/年度计划.md`, falls back to `{root}/年度计划.md`.
 */
export async function readPlanPeriod(app: App, rootPath: string, year: string): Promise<PlanPeriod | null> {
	const root = rootPath.replace(/\/+$/, "");
	for (const path of [`${root}/${year}/年度计划.md`, `${root}/年度计划.md`]) {
		const f = app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) continue;
		const fm = parseYaml((await app.vault.cachedRead(f)).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "") as {
			start?: string;
			end?: string;
		};
		if (typeof fm?.start === "string" && typeof fm?.end === "string") {
			return { start: fm.start, end: fm.end };
		}
		return null;
	}
	return null;
}

export async function computePeriodStats(
	app: App,
	rootPath: string,
	today: string,
	type: PeriodType,
	reviewWorkdays: boolean
): Promise<PeriodStats> {
	const period = resolvePeriod(today, type);
	let { start, end, label, yearDir } = period;

	// 年度窗口：优先用年度计划 frontmatter 定义的周期（如 8/10 ~ 12/31），而非自然年
	if (type === "year") {
		const planPeriod = await readPlanPeriod(app, rootPath, yearDir);
		if (planPeriod) {
			start = planPeriod.start;
			end = planPeriod.end;
		}
	}

	// --- Plan check-in rates -------------------------------------------------
	const prefix = `${rootPath}/${yearDir}/每日/`;
	const dailyFiles = app.vault
		.getFiles()
		.filter((f) => f.path.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name));

	const planDays = new Map<string, number>(); // checked days per plan
	const planSeen = new Set<string>();

	for (const file of dailyFiles) {
		const date = file.basename;
		if (date < start || date > end) continue;
		const content = await app.vault.cachedRead(file);
		const data = parseDailyContent(file, content, date);
		const checkedPlans = new Set<string>();
		for (const item of data.checkItems) {
			if (item.plan) planSeen.add(item.plan);
			if (item.plan && item.checked) checkedPlans.add(item.plan);
		}
		for (const plan of checkedPlans) planDays.set(plan, (planDays.get(plan) ?? 0) + 1);
	}

	// 周/月类型：打卡率用"至今"口径（未过的未来天不计入分母，周三看 2 天、月初看本月已过天数）
	let rateEnd = end;
	if ((type === "week" || type === "month") && today < end) rateEnd = today;
	const totalDays = dayCount(start, rateEnd);
	const workdays = countWorkdays(start, rateEnd);

	const planRates: PlanRate[] = Array.from(planSeen)
		.sort()
		.map((plan) => {
			const isReview = plan === "复盘";
			const total = isReview && reviewWorkdays ? workdays : totalDays;
			const done = planDays.get(plan) ?? 0;
			return { plan, done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
		});

	// --- Temp task completion ------------------------------------------------
	const tempFiles = collectTempTaskFiles(app, rootPath, yearDir, label, type);
	let tempTotal = 0;
	let tempDone = 0;
	for (const file of tempFiles) {
		const source: "week" | "month" = file.path.includes("/周/") ? "week" : "month";
		const tasks = parseTempTasksFromFrontmatter(await app.vault.cachedRead(file), file, source);
		for (const t of tasks) {
			if (!t.text) continue;
			tempTotal++;
			if (t.checked) tempDone++;
		}
	}

	// --- Task pool stats (M2) ------------------------------------------------
	const poolTasks = await listTasks(app, rootPath, yearDir);
	const windowTasks = filterTasksInRange(poolTasks, start, end);
	const taskSummary = summarizeTasks(windowTasks);

	// --- Annual plan progress (year only) ------------------------------------
	let planProgress: PlanProgress[] = [];
	if (type === "year") {
		planProgress = await computeAnnualPlanProgress(app, rootPath, today, poolTasks, planRates);
	}

	return {
		type,
		label,
		rangeLabel: `${start.slice(5)} ~ ${end.slice(5)}`,
		planRates,
		tempTotal,
		tempDone,
		tempPercent: tempTotal === 0 ? 0 : Math.round((tempDone / tempTotal) * 100),
		taskTotal: taskSummary.total,
		taskDone: taskSummary.done,
		taskPercent: taskSummary.percent,
		tasks: windowTasks,
		planProgress,
	};
}

// ---------------------------------------------------------------------------
// M2: task pool helpers
// ---------------------------------------------------------------------------

/** Tasks whose window (🛫 ~ 📅) overlaps the [start, end] range (DEV.md M2). */
export function filterTasksInRange(tasks: PoolTask[], start: string, end: string): PoolTask[] {
	return tasks.filter((t) => {
		const s = t.start ?? t.due;
		const e = t.due ?? t.start;
		if (!s || !e) return false; // undated tasks have no window
		return s <= end && e >= start;
	});
}

export interface TaskSummary {
	total: number;
	done: number;
	percent: number;
}

export function summarizeTasks(tasks: PoolTask[]): TaskSummary {
	const total = tasks.length;
	const done = tasks.filter((t) => t.checked).length;
	return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

// ---------------------------------------------------------------------------
// M2: annual plan progress
// ---------------------------------------------------------------------------

/**
 * Parse the `plans` list from the annual note's frontmatter.
 * Tolerant to list-of-strings and map-of-objects layouts; `target` is read
 * from the description-like fields. DEV.md M2: structure is read-only.
 */
export function parsePlansFromFrontmatter(content: string): PlanDef[] {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return [];
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return [];
	}
	const raw = data?.plans;
	if (raw === undefined || raw === null) return [];

	const defs: PlanDef[] = [];
	const push = (name: string, obj: Record<string, unknown> | undefined): void => {
		const trimmed = name.trim();
		if (!trimmed) return;
		const target = readPlanTarget(obj);
		const goals = readPlanGoals(obj);
		// v1.2: 有 goals 即数量型（targetCount = Σ goals.count）；无 goals 时按旧逻辑正则兜底
		let type: PlanDef["type"] = "check";
		let targetCount = 0;
		if (goals.length > 0) {
			type = "numeric";
			targetCount = goals.reduce((acc, g) => acc + g.count, 0);
		} else {
			type = readPlanType(obj, target);
			const m =
				/(\d+)\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门)/.exec(target) ??
				/(?<![0-9/%])(\d+)(?![0-9/%])/.exec(target);
			targetCount = type === "numeric" && m ? parseInt(m[1], 10) : 0;
		}
		defs.push({
			name: trimmed,
			type,
			target,
			targetCount,
			goals,
			action: readPlanString(obj, ["action", "动作", "时长", "duration"]),
			label: readPlanString(obj, ["label", "icon", "图标", "emoji"]),
			color: readPlanString(obj, ["color", "colour", "颜色"]),
			tradingDay: !!obj?.tradingDay || !!obj?.tradingday || !!obj?.["交易日"],
		});
	};

	if (Array.isArray(raw)) {
		for (const el of raw) {
			if (typeof el === "string") {
				const s = el.trim();
				const idx = s.indexOf(":");
				if (idx !== -1) push(s.slice(0, idx), { target: s.slice(idx + 1).trim() });
				else {
					const m = /^(\S+)\s+(.+)$/.exec(s);
					if (m) push(m[1], { target: m[2] });
					else push(s, undefined);
				}
			} else if (el && typeof el === "object") {
				const obj = el as Record<string, unknown>;
				const name = obj.name ?? obj.plan ?? obj["名称"] ?? obj["计划"];
				if (typeof name === "string") {
					push(name, obj);
				} else {
					// Object with a single key: { 写作: { type, target } }
					const key = Object.keys(obj)[0];
					if (key) {
						const val = obj[key];
						push(
							key,
							val && typeof val === "object" ? (val as Record<string, unknown>) : { target: typeof val === "string" ? val : "" }
						);
					}
				}
			}
		}
	} else if (typeof raw === "object") {
		for (const key of Object.keys(raw)) {
			const val = (raw as Record<string, unknown>)[key];
			if (val && typeof val === "object") push(key, val as Record<string, unknown>);
			else if (typeof val === "string") push(key, { target: val });
			else push(key, undefined);
		}
	}
	return defs;
}

function readPlanTarget(obj?: Record<string, unknown>): string {
	if (!obj) return "";
	for (const k of ["target", "description", "desc", "目标", "描述", "goal", "值"]) {
		if (typeof obj[k] === "string") return obj[k];
	}
	return "";
}

function readPlanString(obj: Record<string, unknown> | undefined, keys: string[]): string {
	if (!obj) return "";
	for (const k of keys) {
		if (typeof obj[k] === "string") return obj[k];
	}
	return "";
}

/** Parse the `goals` array under a plan (v1.2). Tolerant of string/number/object entries. */
function readPlanGoals(obj?: Record<string, unknown>): PlanGoal[] {
	if (!obj || !Array.isArray(obj.goals)) return [];
	const out: PlanGoal[] = [];
	for (const g of obj.goals) {
		if (typeof g === "string") {
			// "阅读 10 本 2026-08-12~2026-12-31" or "阅读 10 本"
			const m = /^(.+?)\s+(\d+)\s*(篇|本|条|个|部|期|集|次|份|张|幅|门|天)?(?:\s+(\d{4}-\d{2}-\d{2})~\s*(\d{4}-\d{2}-\d{2}))?$/.exec(g.trim());
			if (m) {
				out.push({ name: m[1].trim(), count: parseInt(m[2], 10), unit: m[3] ?? "个", start: m[4], end: m[5] });
			}
			continue;
		}
		if (!g || typeof g !== "object") continue;
		const rec = g as Record<string, unknown>;
		const name = readPlanString(rec, ["name", "名称", "goal", "任务"]);
		if (!name) continue;
		const count =
			typeof rec.count === "number"
				? rec.count
				: typeof rec["数量"] === "number"
					? rec["数量"]
					: (() => {
							const cv: unknown = rec.count ?? rec["数量"];
							return parseInt(cv == null ? "0" : typeof cv === "string" || typeof cv === "number" ? String(cv) : "0", 10);
						})();
		if (!count || Number.isNaN(count) || count <= 0) continue;
		const unit = readPlanString(rec, ["unit", "单位", "量词"]) || "个";
		const start = readPlanString(rec, ["start", "开始", "起"]);
		const end = readPlanString(rec, ["end", "结束", "止"]);
		out.push({ name: name.trim(), count, unit, start: start || undefined, end: end || undefined });
	}
	return out;
}

function readPlanType(obj: Record<string, unknown> | undefined, target: string): PlanDef["type"] {
	let t = "";
	if (obj) {
		for (const k of ["type", "kind", "类型", "模式"]) {
			if (typeof obj[k] === "string") {
				t = obj[k];
				break;
			}
		}
	}
	if (t) {
		if (/数量|量化|count|numeric|project|任务|篇|个|次/.test(t)) return "numeric";
		if (/打卡|习惯|habit|check|daily|复盘/.test(t)) return "check";
	}
	// 无 type 字段：target 含"数量词+单位"（12 篇 / 1 条 / 3 个）→ 数量型；否则打卡型
	if (/\d+\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门)/.test(target)) return "numeric";
	return "check";
}

/**
 * Build annual plan progress for every plan defined in `年度计划.md`.
 * - numeric: doneCount = completed pool tasks under the plan
 * - check:   progress = the plan's annual check-in rate (from planRates)
 */
export async function computeAnnualPlanProgress(
	app: App,
	rootPath: string,
	today: string,
	tasks: PoolTask[],
	planRates: PlanRate[]
): Promise<PlanProgress[]> {
	const root = rootPath.replace(/\/+$/, "");
	const year = today.slice(0, 4);
	const f = app.vault.getAbstractFileByPath(`${root}/${year}/年度计划.md`);
	if (!(f instanceof TFile)) return [];
	const content = await app.vault.cachedRead(f);
	const defs = parsePlansFromFrontmatter(content);
	const rateByName = new Map(planRates.map((r) => [r.plan, r]));

	return defs.map((def) => {
		const planTasks = tasks.filter((t) => t.plan === def.name);
		const rate = rateByName.get(def.name);
		// v1.2: per-goal progress = completed tasks whose name starts with 「{goal.name}（」
		const goalProgress: PlanGoalProgress[] = def.goals.map((g) => {
			const prefix = `${g.name}（`;
			const done = planTasks.filter((t) => t.checked && t.text.trim().startsWith(prefix)).length;
			return { ...g, done, percent: g.count > 0 ? Math.round((done / g.count) * 100) : 0 };
		});
		const base = {
			plan: def.name,
			target: def.target,
			action: def.action,
			label: def.label,
			color: def.color,
			tradingDay: def.tradingDay,
			goals: goalProgress,
			tasks: planTasks,
		};
		if (def.type === "numeric") {
			const doneCount = planTasks.filter((t) => t.checked).length;
			const percent = def.targetCount > 0 ? Math.round((doneCount / def.targetCount) * 100) : 0;
			return {
				...base,
				isNumeric: true,
				targetCount: def.targetCount,
				doneCount,
				checkDone: 0,
				checkTotal: 0,
				checkPercent: 0,
				percent,
			};
		}
		return {
			...base,
			isNumeric: false,
			targetCount: 0,
			doneCount: 0,
			checkDone: rate?.done ?? 0,
			checkTotal: rate?.total ?? 0,
			checkPercent: rate?.percent ?? 0,
			percent: rate?.percent ?? 0,
		};
	});
}

interface PeriodBounds {
	start: string;
	end: string;
	label: string;
	yearDir: string;
}

function resolvePeriod(today: string, type: PeriodType): PeriodBounds {
	if (type === "week") {
		const { year, week } = getISOWeek(today);
		const { start, end } = weekRange(today);
		return {
			start,
			end,
			label: `${year}-W${String(week).padStart(2, "0")}`,
			yearDir: String(year),
		};
	}
	if (type === "month") {
		const [y, m] = today.split("-").map(Number);
		const mm = String(m).padStart(2, "0");
		const dd = String(daysInMonth(y, m)).padStart(2, "0");
		return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${dd}`, label: `${y}-${mm}`, yearDir: String(y) };
	}
	const [y] = today.split("-").map(Number);
	return { start: `${y}-01-01`, end: today, label: String(y), yearDir: String(y) };
}

function collectTempTaskFiles(
	app: App,
	rootPath: string,
	yearDir: string,
	label: string,
	type: PeriodType
): TFile[] {
	if (type === "week") {
		const f = app.vault.getAbstractFileByPath(`${rootPath}/${yearDir}/周/${label}.md`);
		return f instanceof TFile ? [f] : [];
	}
	if (type === "month") {
		const f = app.vault.getAbstractFileByPath(`${rootPath}/${yearDir}/月/${label}.md`);
		return f instanceof TFile ? [f] : [];
	}
	// Year: all week + month notes of the year.
	return app.vault
		.getFiles()
		.filter(
			(f) =>
				f.name.endsWith(".md") &&
				(f.path.startsWith(`${rootPath}/${yearDir}/周/`) || f.path.startsWith(`${rootPath}/${yearDir}/月/`))
		);
}
