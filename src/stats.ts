import { App, TFile, parseYaml } from "obsidian";
import {
	dayCount,
	daysInMonth,
	getISOWeek,
	parseDailyContent,
	parseTempTasksFromFrontmatter,
	weekRange,
} from "./daily";
import { annualPlanPath, dailyDir, monthDir, monthNotePath, weekDir, weekNotePath, rootPath as pfRoot } from "./paths";
import type { PoolTask } from "./tasks";
import { listTasks } from "./tasks";

/**
 * Statistics (PRD §2.4):
 * - 计划打卡率 = days the plan was checked in ÷ expected days in the period
 *   （所有计划统一口径：周=7 天，月=自然月天数，年=窗口内天数；week/month 用「至今」口径）
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

/**
 * v7.21: 量化到每日打卡的打卡项配置——编辑量化目标弹窗里与「添加打卡项」同款的
 * 可编辑内容（名称/计划/起止/复盘链接）。缺省（YAML 未写 dailyItem）时各字段
 * 回落目标自身值：name = 目标名、plan = 目标所属计划、start/end = 目标窗口、review = false。
 */
export interface GoalDailyItem {
	/** 打卡项标题（≠ 目标名时才有必要自定义，如「写作 30 分钟」）。 */
	name: string;
	/** `#计划/` 标签指向的计划名（默认 = 目标所属计划）。 */
	plan: string;
	/** 打卡项窗口起点（默认跟随目标 start；再缺省 = 当天）。 */
	start?: string;
	/** 打卡项窗口终点（默认跟随目标 end）。 */
	due?: string;
	/** 是否带复盘链接 `→ [[{date} 复盘]]`。 */
	review?: boolean;
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
	/** v7.20: 量化到每日打卡——窗口内每天自动加一条该目标的打卡项。 */
	daily?: boolean;
	/** v7.21: 每日打卡项的自定义内容（daily 为 true 时有意义；未写 = 全部回落目标自身值）。 */
	dailyItem?: GoalDailyItem;
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
	/** Whether this plan appears in the daily check-in (default true; `daily: false` excludes it). */
	daily: boolean;
}

/** Progress of one goal under a plan. */
export interface PlanGoalProgress extends PlanGoal {
	/** Completed tasks whose name starts with `${goal.name}（`. */
	done: number;
	/** v1.0.4: 任务池中该目标的实际任务总数（单一数据源；count 仅为生成规格）。 */
	total: number;
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
	/** Daily check-in action label, e.g. "1小时". v7.6 已退役，仅用于识别老笔记标题里的历史后缀。 */
	action: string;
	/** Icon prefix, e.g. "✍️". */
	label: string;
	/** Plan color (settings override), e.g. "#f59e0b". */
	color: string;
	/** v7.6: 是否每日打卡计划（决定今日打卡标题是否按「图标 + 计划名」硬裁历史后缀）。 */
	daily: boolean;
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
	const root = pfRoot(rootPath);
	for (const path of [annualPlanPath(root, year), annualPlanPath(root)]) {
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

// ---------------------------------------------------------------------------
// v1.0.5：按 (app, root, today, type) 加键的统计缓存
//
// 为什么需要（实测数据，不是猜测）：
//   回顾页一次刷新连算 3 个周期（`renderReview` 里 year + week + month），
//   而**年统计要把窗口内每一篇每日笔记读一遍 + parseDailyContent**（真库 2026 有 42 篇，
//   窗口满年时是 365 篇）。首页 banner、回顾页、settle 判定还会各自再算一遍年统计 ——
//   同一次 refresh 里可能重复 3~4 次同样的全量遍历。
//   vault modify 又会触发 refresh（500ms debounce），改一个 checkbox 就重算一遍全年。
//
// 为什么按 key 缓存而不是「只缓存年统计」：
//   week / month 的窗口小（7 / 30 天），重复计算的收益低但成本同样存在；
//   统一 keyed cache 逻辑只有一份，且键里带了全部输入（root/today/type/rw），
//   不存在「拿到别的口径的旧结果」这种风险。
//
// 失效策略：**整体清空**（`invalidateStatsCache`），不做逐 key 精细失效。
//   理由：一次 vault 事件往往同时影响多篇日记/多个文件，逐条算「谁脏了」的成本
//   几乎等于重算；而清空的代价只是「下一次 refresh 重算一次」，正确性上零风险。
//   视图在任何 vault modify 到达时都会调 invalidate —— 宁可可重算，不可算错。
// ---------------------------------------------------------------------------

interface StatsCacheEntry {
	stats: PeriodStats;
	/** 入库时的 vault mtime 指纹，仅用于诊断与调试输出 */
	stamp: string;
}

/** 按 app 对象分桶的缓存（多库场景下互不串味）。 */
let statsCaches = new WeakMap<App, Map<string, StatsCacheEntry>>();

/** 取缓存键：所有影响结果的输入都进键里。 */
function statsCacheKey(rootPath: string, today: string, type: PeriodType): string {
	// 分隔符用 \u0000 —— 路径/日期里不可能出现它，避免 "a|b" + "c" 与 "a" + "b|c" 撞键
	return `${rootPath}\u0000${today}\u0000${type}`;
}

/**
 * 作废某 app 的全部统计缓存。
 *
 * 必须在任何「文件可能变了」之后调用：vault modify / create / delete / rename，
 * 以及设置变更（rootPath 变了键自然不同，但清空更省心）。
 */
export function invalidateStatsCache(app: App): void {
	statsCaches.get(app)?.clear();
}

/** 清掉所有 app 的统计缓存（切库 / 卸载 / 测试隔离用）。 */
export function invalidateAllStatsCaches(): void {
	statsCaches = new WeakMap();
}

/** 读缓存命中则返回，未命中返回 undefined。 */
function readStatsCache(app: App, key: string): PeriodStats | undefined {
	return statsCaches.get(app)?.get(key)?.stats;
}

function writeStatsCache(app: App, key: string, stats: PeriodStats, stamp: string): void {
	let bucket = statsCaches.get(app);
	if (!bucket) {
		bucket = new Map();
		statsCaches.set(app, bucket);
	}
	// 只留最近 12 条：一次会话里 root/year/rw 的组合不会太多，
	// 上限是防「切库 + 改设置」这类长会话把内存慢慢撑起来。
	if (bucket.size >= 12) {
		const oldest = bucket.keys().next();
		if (!oldest.done) bucket.delete(oldest.value);
	}
	bucket.set(key, { stats, stamp });
}

export async function computePeriodStats(
	app: App,
	rootPath: string,
	today: string,
	type: PeriodType,
	/** 绕过缓存强制重算（自写写盘后、或调用方明确知道库变了时用）。 */
	force = false
): Promise<PeriodStats> {
	const cacheKey = statsCacheKey(rootPath, today, type);
	if (!force) {
		const hit = readStatsCache(app, cacheKey);
		if (hit) return hit;
	}
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
	const prefix = `${dailyDir(rootPath, yearDir)}/`;
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

	// v1.1.6：所有计划统一用自然天分母。
	// 原先有一层「复盘计划按工作日算分母」的特化（reviewWorkdays + tradingDay）——
	// 它服务的是作者本人那个 A 股复盘计划：交易日不含周末，用自然天当分母会让打卡率
	// 永远到不了 100%。但「交易日/工作日」是**那个用户的领域概念**，不是通用需求：
	// 别的用户没有交易日，复盘也不必按工作日算。留在插件里等于给所有人塞一个
	// 用不上的开关 + 一份交易相关的设置项，故整体移除。需要这个口径的用户可以
	// 在自己的库里用量化目标/自定义周期表达。
	const planRates: PlanRate[] = Array.from(planSeen)
		.sort()
		.map((plan) => {
			const done = planDays.get(plan) ?? 0;
			return { plan, done, total: totalDays, percent: totalDays === 0 ? 0 : Math.round((done / totalDays) * 100) };
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

	const result: PeriodStats = {
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
	// 写入缓存：即使 force 重算过也更新（force 只表示「别信旧值」，不表示「新值别存」）
	writeStatsCache(app, cacheKey, result, `${type}:${start}~${end}`);
	return result;
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
		const goals = readPlanGoals(obj, trimmed);
		// v1.2: 有 goals 即数量型（targetCount = Σ goals.count）；无 goals 时按旧逻辑正则兜底
		let type: PlanDef["type"] = "check";
		let targetCount = 0;
		if (goals.length > 0) {
			type = "numeric";
			targetCount = goals.reduce((acc, g) => acc + g.count, 0);
		} else {
			type = readPlanType(obj, target);
			// v1.1.2：lookbehind（(?<!...)）换成等价的前缀写法——regex lookbehind 是
			// 社区扫描器 error 级规则（旧 Electron/Safari 不支持，iPad 会直接崩）。
			// 13 组样本比对确认两写法首 match 完全等价（含 %50 / a%112 / 112 等边界）。
			const m =
				/(\d+)\s*(?:篇|条|个|部|期|集|次|份|张|幅|本|门)/.exec(target) ??
				/(?:^|[^0-9/%])(\d+)(?![0-9/%])/.exec(target);
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
			// v2.7: 每日打卡计划标志（daily: false 显式排除；缺省视为每日打卡）
			daily: obj?.daily !== false,
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
function readPlanGoals(obj?: Record<string, unknown>, planName = ""): PlanGoal[] {
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
		const daily = rec.daily === true || rec.daily === "true";
		// v7.21: dailyItem 对象——每日打卡项的自定义内容（名称/计划/窗口/复盘链接）。
		// plan 缺省回落所属计划名；start/due 缺省回落目标窗口（使用端再回落当天）。
		let dailyItem: GoalDailyItem | undefined;
		const diRaw = rec.dailyItem;
		if (diRaw && typeof diRaw === "object") {
			const d = diRaw as Record<string, unknown>;
			const dname = readPlanString(d, ["name", "名称"]);
			if (dname) {
				dailyItem = {
					name: dname.trim(),
					plan: readPlanString(d, ["plan", "计划"]) || planName,
				};
				const dstart = readPlanString(d, ["start", "开始"]);
				const ddue = readPlanString(d, ["due", "end", "结束"]);
				if (dstart) dailyItem.start = dstart;
				if (ddue) dailyItem.due = ddue;
				if (d.review === true) dailyItem.review = true;
			}
		}
		out.push({
			name: name.trim(),
			count,
			unit,
			start: start || undefined,
			end: end || undefined,
			daily: daily || undefined,
			dailyItem,
		});
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
	const root = pfRoot(rootPath);
	const year = today.slice(0, 4);
	const f = app.vault.getAbstractFileByPath(annualPlanPath(root, year));
	if (!(f instanceof TFile)) return [];
	const content = await app.vault.cachedRead(f);
	const defs = parsePlansFromFrontmatter(content);
	const rateByName = new Map(planRates.map((r) => [r.plan, r]));

	return defs.map((def) => {
		const planTasks = tasks.filter((t) => t.plan === def.name);
		const rate = rateByName.get(def.name);
		// v1.2: per-goal progress = completed tasks whose name starts with 「{goal.name}（」
		// v1.0.4: 分母改为任务池实际任务数（单一数据源），g.count 仅是生成规格
		const goalProgress: PlanGoalProgress[] = def.goals.map((g) => {
			const prefix = `${g.name}（`;
			const goalTasks = planTasks.filter((t) => t.text.trim().startsWith(prefix));
			const done = goalTasks.filter((t) => t.checked).length;
			const percent = goalTasks.length > 0 ? Math.round((done / goalTasks.length) * 100) : 0;
			return { ...g, done, total: goalTasks.length, percent };
		});
		const base = {
			plan: def.name,
			target: def.target,
			action: def.action,
			label: def.label,
			color: def.color,
			daily: def.daily,
			goals: goalProgress,
			tasks: planTasks,
		};
		if (def.type === "numeric") {
			const doneCount = planTasks.filter((t) => t.checked).length;
			// v1.0.4: 进度分母 = 任务池中该计划的实际任务总数——单一数据源（任务池），
			// 不再使用 frontmatter target 文本/goals 推导的数字，避免"定义已删、进度仍按旧数显示"
			const totalCount = planTasks.length;
			const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
			return {
				...base,
				isNumeric: true,
				targetCount: totalCount,
				doneCount,
				// v7.4: 数字型计划同样带回打卡数据（每日日记勾选产生 planRates）——
				// 计划卡顶条改用打卡进度后，硬编码 0 会把条清空。
				checkDone: rate?.done ?? 0,
				checkTotal: rate?.total ?? 0,
				checkPercent: rate?.percent ?? 0,
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
		const f = app.vault.getAbstractFileByPath(weekNotePath(rootPath, yearDir, label));
		return f instanceof TFile ? [f] : [];
	}
	if (type === "month") {
		const f = app.vault.getAbstractFileByPath(monthNotePath(rootPath, yearDir, label));
		return f instanceof TFile ? [f] : [];
	}
	// Year: all week + month notes of the year.
	return app.vault
		.getFiles()
		.filter(
			(f) =>
				f.name.endsWith(".md") &&
				(f.path.startsWith(`${weekDir(rootPath, yearDir)}/`) || f.path.startsWith(`${monthDir(rootPath, yearDir)}/`))
		);
}
