import { App, ButtonComponent, ItemView, MarkdownView, Menu, Modal, Notice, TAbstractFile, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type PlanBoardPlugin from "../main";
import type { CheckItem, DailyData } from "./daily";
import {
	buildDonutChartSvg,
	buildMonthBarsSvg,
	buildHeatmapSvg,
	buildPlanBarsH,
	buildYearMonthsSvg,
	buildCumulativeSvg,
} from "./charts";
import { deepenForText, softenChartColor, hexToRgba } from "./colors";
import { annualPlanPath, dailyDir, dailyNotePath, reviewTemplatePath, taskPoolPath, rootPath as pfRoot } from "./paths";
import {
	appendCheckItem,
	buildCheckLine,
	buildDailyTemplate,
	buildReviewTemplate,
	findCheckLineByPlan,
	insertLine,
	moveTaskLine,
	parseDailyContent,
	parseDateString,
	removeCheckLog,
	removeLine,
	replaceLine,
	replaceSummary,
	setCheckLineChecked,
	stripLegacyDuration,
	stripReviewLink,
	upsertCheckLog,
	TASK_LINE_RE,
	todayStr,
	toggleTaskLine,
	weekRange,
	daysInMonth,
	formatDate,
} from "./daily";
import type { PeriodStats, PlanDef, PlanGoal, PlanGoalProgress, PlanProgress, PlanRate } from "./stats";
import {
	computePeriodStats,
	computeAnnualPlanProgress,
	filterTasksInRange,
	parsePlansFromFrontmatter,
	readPlanPeriod,
	invalidateStatsCache,
} from "./stats";
import type { AutoTaskPlan, PoolTask } from "./tasks";
import { DAY_MS, deleteTask, ensureAutoTasks, listTasks, planCounterUnit, toggleTask } from "./tasks";
import { badgeCounts, computeStreak, readMonthBadges, readPeriodBadges, settleMonth, settleMonthCheckin, settleWeek, settleWeekCheckin, tierFor } from "./achievements";
import { DEFAULT_PLAN_COLORS, type PlanTemplate } from "./settings";
import { AddCheckItemModal, PlanEditModal, GoalEditModal, CheckItemManageModal } from "./modals";
import { readRawPlans, writePlansToFile, rotatePlanColor, toPlanDef } from "./plan-file";
import { summarize, taskStatus, sortTasksByDue } from "./tasks";
import type { GoalInput, PlanEditInput } from "./modals";

/** v1.7.4: 插件改名 PlanFlow——view type 同步改（workspace 布局重新打开一次即可） */
export const VIEW_TYPE_PLANFLOW = "planflow";

/** v2.9: 视图架构整合——6 tab 收敛为 4 页：今日 / 回顾(周月年粒度) / 计划(管理) / 任务(看板|甘特)。 */
type TabKey = "today" | "review" | "plans" | "tasks";

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * v7.22：把打卡按钮切到「已打卡 / 打卡」两态（按钮 + 整行高亮同步）。
 *
 * 为什么抽成函数：按钮文案、class、行高亮三处必须**同时**改，抽出去才能让
 * 「下拉框切日期」和「初始化渲染」共用同一份逻辑 —— 否则改一处漏两处，
 * 就会出现「按钮写着已打卡、行却没高亮」这种半截状态。
 * 抽出来还有个附带好处：这三行原本在 renderCheckItem 里内联，
 * 与新加的 change 监听回调无法共享，必须提作用域。
 *
 * @param date 该按钮当前对应的日期（ISO）。tooltip 要区分「今天打卡」与
 *   「补卡到某天」—— 补卡最怕的就是「我以为补上了，它其实记在今天」。
 *   真机实测踩过：只改文案不改 tooltip 时，applyCheckBtnState 会把补卡提示
 *   覆盖回「写入打卡记录」，等于白改。
 */
function applyCheckBtnState(btn: HTMLButtonElement, li: HTMLElement, checked: boolean, date?: string, today?: string): void {
	btn.textContent = checked ? "✓ 已打卡" : "打卡";
	// 原生 classList（不是 Obsidian 的 setClass —— 那挂在 HTMLElement 扩展上，
	// 而这里的类型是最朴素的 HTMLButtonElement）。
	btn.className = "planboard-check-btn" + (checked ? " is-checked" : "");
	const isToday = !date || !today || date === today;
	if (checked) {
		btn.setAttribute("title", isToday ? "取消打卡（勾选与记录一并撤掉）" : `取消 ${date} 的补卡（勾选与记录一并撤掉）`);
	} else {
		btn.setAttribute("title", isToday ? "打卡：勾选任务行 + 写入「打卡记录」" : `补卡：写进 ${date} 那一篇`);
	}
	li.classList.toggle("is-checked", checked);
}

/** 达成音效：WebAudio 合成"叮"（880→1320Hz 双音，零资源文件）。 */
function playAchievementSound(): void {
	try {
		const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		const now = ctx.currentTime;
		// 主音 880Hz（A5）
		const osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.setValueAtTime(880, now);
		osc.frequency.exponentialRampToValueAtTime(1320, now + 0.09);
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
		osc.connect(gain).connect(ctx.destination);
		osc.start(now);
		osc.stop(now + 0.55);
		// 泛音（加亮）
		const osc2 = ctx.createOscillator();
		osc2.type = "triangle";
		osc2.frequency.setValueAtTime(1760, now);
		const g2 = ctx.createGain();
		g2.gain.setValueAtTime(0.0001, now);
		g2.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
		g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
		osc2.connect(g2).connect(ctx.destination);
		osc2.start(now);
		osc2.stop(now + 0.4);
		window.setTimeout(() => void ctx.close(), 800);
	} catch {
		/* 音效失败不影响功能 */
	}
}

/** Days since the ISO base date (1-based), e.g. dayIndexOf("2026-02-01", "2026-01-01") = 32. */
function dayIndexOf(d: string, base: string): number {
	return Math.round((parseDateString(d).getTime() - parseDateString(base).getTime()) / DAY_MS) + 1;
}

/** v1.6: 徽章内容拆分——emoji 放大显示（奖牌数字清晰），文字常规字号。 */
function setBadgeContent(el: HTMLElement, emoji: string, text: string): void {
	el.empty();
	el.createSpan({ cls: "planboard-badge-emoji", text: emoji });
	el.createSpan({ cls: "planboard-badge-text", text: text });
}

/** 卡片底部拖拽调整高度（月/周任务列表、打卡卡、总结卡），持久化到插件设置。
 *  target 为高度变化元素（月/周=列表，打卡/总结=卡片自身）；handle 挂卡片上（列表 empty() 不会清掉）。
 *  linked 可选：并排联动卡（拖一张，另一张同高同步）。 */
/** v1.6: 计划卡拖拽排序——实时重排 + FLIP 动画（react-beautiful-dnd / dnd-kit 网格标准）：
 *  被拖卡 fixed 脱离流跟手（left/top 跟随鼠标）；
 *  拖动中实时 2D 碰撞检测（中心点 vs 其他卡矩形）→ 跨项即重排 DOM；
 *  重排后其他卡用 FLIP 动画平滑滑到新位置（左右上下都可拖）；
 *  松手恢复流式布局 + FLIP 归位。window 捕获阶段拦截（抢在 Obsidian 之前）。
 *  顺序持久化到 settings.planOrder。 */
function attachPlanSort(card: HTMLElement, container: HTMLElement, plugin: PlanBoardPlugin, planName: string, columns?: HTMLElement[]): void {
	const head = card.querySelector<HTMLElement>(".planboard-plan-head") ?? card;
	head.addClass("planboard-drag-head");
	card.setAttribute("data-plan-name", planName);
	// v1.7.4: JS 显式两列容器——columns 为列容器数组（默认 [container] 兼容非年度视图调用）
	const cols: HTMLElement[] = columns && columns.length ? columns : [container];
	const othersAll = (): HTMLElement[] => cols.flatMap((c) => Array.from(c.children)) as HTMLElement[];
	const parentOf = (el: HTMLElement): HTMLElement => (el.parentElement as HTMLElement) || container;
	let dragging = false;
	let grabX = 0;
	let grabY = 0;
	let offsetX = 0; // v1.6: 重排补偿（重排后 DOM 位置变化，transform 基准随之修正）
	let offsetY = 0;
	let lastMoveT = 0; // v1.6: 时间节流（替代 rAF——后台页面 rAF 暂停）
	let lastKey = ""; // v1.6.2: 防重键 = 目标计划名 + 模式（同目标不同模式可推进：before→swap）
	// v1.6.1: 逻辑位置缓存——碰撞检测用【布局最终位置】（FLIP 动画中间帧 rect 会抖动碰撞判断）
	const logicRects = new Map<HTMLElement, DOMRect>();
	const rectOf = (el: HTMLElement): DOMRect => logicRects.get(el) ?? el.getBoundingClientRect();
	// v1.6.2: 反推布局位置（视觉 rect − transform 偏移）——offset 补偿必须用布局位置（用视觉 rect 会被旧位移污染导致跟手断裂）
	const layoutOf = (el: HTMLElement): { left: number; top: number } => {
		const r = el.getBoundingClientRect();
		const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform);
		if (m) {
			return { left: r.left - parseFloat(m[1]), top: r.top - parseFloat(m[2]) };
		}
		return { left: r.left, top: r.top };
	};

	/** FLIP：让其他卡从旧位置平滑滑到新位置（重排后调用）；并缓存逻辑位置供碰撞检测。 */
	const flipOthers = (): void => {
		const others = othersAll().filter((c) => c !== card);
		const firsts = others.map((c) => c.getBoundingClientRect());
		// （DOM 已被调用方重排；这里仅做动画 + 缓存逻辑位置）
		others.forEach((c, i) => {
			const r = c.getBoundingClientRect();
			logicRects.set(c, r);
			const dx = firsts[i].left - r.left;
			const dy = firsts[i].top - r.top;
			if (dx || dy) {
				// 对齐看板列模式：先禁过渡（瞬间定位）→ 设 transform → 强制重排 → 开过渡归位
				c.addClass("planflow-flip-none");
				c.style.transform = `translate(${dx}px, ${dy}px)`;
				void c.offsetWidth;
				c.removeClass("planflow-flip-none");
				c.addClass("planflow-flip-med");
				c.style.removeProperty("transform");
			}
		});
	};

	/** v1.7.4 重写：列感知中心定位（columns 瀑布专用）。
	 *  目标列 = 被拖卡中心 x 所在列（±8 吸附）；
	 *  列内：中心 y 落某卡内 → swap（对准哪张换哪张，无歧义）；
	 *        中心 y 落两卡间隙 → 插入（before/after）；
	 *        中心 y 低于该列底部 → 列内末尾插入（修复旧 end 检测跨列误判——大卡撑高全局阈值，
	 *        小卡拖向矮列被误判为"拖到所有卡末尾"而无法移入）。 */
	interface RefResult {
		target: HTMLElement;
		mode: "swap" | "before" | "after" | "end" | "first";
	}
	/** 拖拽判定（v2.1 分离语义，实测校准）：
	 *  两列（年度视图）→ v2.0 间隙插入模型：列归属（横向重叠）→ 列内按中心 cy 找间隙
	 *    （列首 before / 卡内按中心± / 列尾 after / 空列 first），无 swap、无方向判定、无方向锁
	 *    （v2.2: 删除 lastRef2 锁——它把"拖到第一行上方"锁死在 after；年度卡大间距大本就不抖）；
	 *  单列（周/月视图）→ v1.7.5 swap 语义原样保留（用户实测确认满意，不再改动）。 */
	const computeRef = (): RefResult | null => {
		const others = othersAll().filter((c) => c !== card);
		const dr = card.getBoundingClientRect(); // 被拖卡视觉 rect（含 transform = 当前跟手位置）
		const cx = dr.left + dr.width / 2;
		const cy = dr.top + dr.height / 2;
		// ===== 两列（年度视图）：v2.0 间隙插入模型 =====
		if (cols.length > 1) {
			// 1. 列归属：与【列容器】横向重叠宽度最大者（v2.3: 用列容器而非卡聚类——
			//    空列不在卡聚类里，拖入空列会被判死区；列容器 rect 天然包含空列）。
			//    全部零重叠（列间隙）时用中心点兜底。
			let targetColEl: HTMLElement | null = null;
			let bestOverlap = 0;
			const colRects = cols.map((c) => c.getBoundingClientRect());
			for (let i = 0; i < cols.length; i++) {
				const cr = colRects[i];
				const ov = Math.min(dr.right, cr.right) - Math.max(dr.left, cr.left);
				if (ov > bestOverlap) {
					bestOverlap = ov;
					targetColEl = cols[i];
				}
			}
			if (!targetColEl || bestOverlap <= 0) {
				for (let i = 0; i < cols.length; i++) {
					const cr = colRects[i];
					if (cx >= cr.left && cx <= cr.right) {
						targetColEl = cols[i];
						break;
					}
				}
			}
			if (!targetColEl) return null;
			const sameCol = Array.from(targetColEl.children).filter((c) => c !== card) as HTMLElement[];
			// 2. 空列 → 插列首（第一行）
			if (sameCol.length === 0) {
				return { target: targetColEl, mode: "first" };
			}
			// 3. 列内按【卡顶 top】找间隙（v2.3: 卡中心会被大卡高度滞后——写作卡 h435 拖到列首上方
			//    时中心还在下面，插不到第一行；卡顶 = 鼠标抓取位置，判定更直觉）
			const top = dr.top;
			for (const o of sameCol) {
				const r = rectOf(o);
				if (top < r.top) return { target: o, mode: "before" }; // 列首
				if (top <= r.bottom) {
					// 卡内：按相对卡中心，上半插前、下半插后（吸附感）
					return { target: o, mode: top < (r.top + r.bottom) / 2 ? "before" : "after" };
				}
			}
			return { target: sameCol[sameCol.length - 1], mode: "after" }; // 列尾
		}
		// ===== 单列（周/月视图）：v1.7.5 swap 语义（原样保留）=====
		const dy = (card.style.transform.match(/translate3d\([^,]+,\s*(-?[\d.]+)px/) ?? [null, "0"])[1];
		const movingDown = parseFloat(dy ?? "0") >= 0;
		// 0. 全局末尾：中心 y 低于【所有卡】最大底部 +12 → append（真正拖到最底部）
		const maxBottom = others.reduce((m, o) => Math.max(m, rectOf(o).bottom), -Infinity);
		if (others.length > 0 && cy > maxBottom + 12) {
			return { target: others[others.length - 1], mode: "end" };
		}
		// 1. 列归属：按 left 聚类成列（同列 left 相同），中心 x 落在哪列 → 目标列
		const colGroups = new Map<number, HTMLElement[]>();
		for (const o of others) {
			const left = Math.round(rectOf(o).left);
			const list = colGroups.get(left) ?? [];
			list.push(o);
			colGroups.set(left, list);
		}
		let targetCol: HTMLElement[] | null = null;
		for (const [left, list] of colGroups) {
			const colRight = left + rectOf(list[0]).width;
			if (cx >= left && cx <= colRight) {
				targetCol = list;
				break;
			}
		}
		if (!targetCol) return null; // 中心在列间死区（间隙）——不动
		// 2. 列内沿拖动方向找垂直重叠 ≥ 1/3 的最大卡 → swap（重叠 1/3 即交换）
		let best: HTMLElement | null = null;
		let bestRatio = 0;
		for (const o of targetCol) {
			const r = rectOf(o);
			// 只沿拖动方向：向下拖只看下方卡，向上拖只看上方卡
			if (movingDown && r.top < dr.top - 2) continue;
			if (!movingDown && r.bottom > dr.bottom + 2) continue;
			const vOverlap = Math.min(dr.bottom, r.bottom) - Math.max(dr.top, r.top);
			if (vOverlap <= 0) continue;
			const ratio = vOverlap / Math.min(dr.height, r.height);
			if (ratio > bestRatio) {
				bestRatio = ratio;
				best = o;
			}
		}
		if (best && bestRatio >= 0.34) {
			return { target: best, mode: "swap" };
		}
		return null;
	};

	const onMove = (ev: PointerEvent): void => {
		if (!dragging) return;
		// v1.6: 时间节流 ~60fps——不用 rAF（后台/未聚焦页面 rAF 被 Chromium 暂停，拖拽会完全失效）
		const now = Date.now();
		if (now - lastMoveT < 16) return;
		lastMoveT = now;
		// transform 跟手（相对流式位置 + 重排补偿）——不用 fixed（Obsidian transform 祖先劫持 fixed 坐标基准）
		// v2.1: 移动阈值（activation constraint）——原始位移 <4px 视为"按下未拖"，不判定不重排
		//（修复：按下瞬间 dy≈0 时判定会锁死方向/触发无操作重排，周月年度通杀）
		const rawX = ev.clientX - grabX;
		const rawY = ev.clientY - grabY;
		if (Math.abs(rawX) < 4 && Math.abs(rawY) < 4) return;
		const dx = rawX + offsetX;
		const dy = rawY + offsetY;
		card.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
		// 2D 目标位置（单列 swap / 两列间隙插入；null=死区不动）
		const res = computeRef();
		if (res && res.target !== card) {
			const key = res.target.getAttribute("data-plan-name") + ":" + res.mode;
			if (key !== lastKey) {
				// v2.3 修复: 原位保护——C 已在目标位置则不重排（无操作 insertBefore + FLIP 是抖动源）。
				// 条件曾写反（before 用 previousElementSibling）：card 在 target【后】时判定 before
				// 被误判"已在位"跳过 → 拖到第一行上方插不进去。已在位 = card 紧邻 target 前/后。
				if (
					(res.mode === "before" && card.nextElementSibling === res.target) ||
					(res.mode === "after" && card.previousElementSibling === res.target) ||
					(res.mode === "first" && card.parentElement === res.target && card === res.target.firstChild)
				) {
					lastKey = key;
					return;
				}
				lastKey = key;
				// 重排：记录【布局位置】→ DOM 操作 → 补偿 offset（视觉连续）
				const oldL = layoutOf(card);
				if (res.mode === "swap") {
					// v1.7.5: 真交换（单列用）——重叠 1/3 即交换：相邻时单步移动，不相邻时两步对调
					if (card.nextSibling === res.target) {
						// card 紧邻 target 前 → card 移到 target 后
						parentOf(card).insertBefore(card, res.target.nextSibling);
					} else if (res.target.nextSibling === card) {
						// card 紧邻 target 后 → card 移到 target 前
						parentOf(card).insertBefore(card, res.target);
					} else {
						// 不相邻：target 移到 card 前，card 移到 target 原位
						const cardCol = parentOf(card);
						const targetCol = parentOf(res.target);
						const targetNext = res.target.nextSibling;
						cardCol.insertBefore(res.target, card);
						targetCol.insertBefore(card, targetNext);
					}
				} else if (res.mode === "after") {
					// 插目标后（列尾时 nextElementSibling=null → append 到该列末尾）
					const tc = parentOf(res.target);
					tc.insertBefore(card, res.target.nextElementSibling);
				} else if (res.mode === "first") {
					// 空列 → 插到列容器开头（第一行）
					res.target.insertBefore(card, res.target.firstChild);
				} else if (res.mode === "end") {
					// 拖到最底部 → 最后一列末尾（单列）
					cols[cols.length - 1].appendChild(card);
				} else {
					// before：插目标前（同列或跨列 insertBefore 均正确）
					parentOf(res.target).insertBefore(card, res.target);
				}
				const newL = layoutOf(card);
				offsetX += oldL.left - newL.left;
				offsetY += oldL.top - newL.top;
				card.style.transform = `translate3d(${rawX + offsetX}px, ${rawY + offsetY}px, 0)`;
				flipOthers();
			}
		}
	};

	const finish = (ev?: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("pointerup", finish, true);
		window.removeEventListener("pointercancel", finish, true);
		if (ev) ev.preventDefault();
		// v1.6.1: 清逻辑位置缓存
		logicRects.clear();
		// 先清其他卡所有残留 transform/transition（FLIP 动画残留会污染 rect 计算）
		othersAll().forEach((c) => {
				if (c === card) return;
				c.removeClass("planflow-flip-none");
				c.removeClass("planflow-flip-fast");
				c.removeClass("planflow-flip-med");
				c.removeClass("planflow-flip-slow");
				c.style.removeProperty("transform");
			});
		// 被拖卡恢复流式布局 + FLIP 归位（从鼠标位置滑入格子）
		const from = card.getBoundingClientRect();
		card.removeClass("is-plan-dragging");
		card.style.removeProperty("transform");
		const to = card.getBoundingClientRect();
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		if (dx || dy) {
			card.addClass("planflow-flip-none");
			card.style.transform = `translate(${dx}px, ${dy}px)`;
			void card.offsetWidth;
			card.removeClass("planflow-flip-none");
			card.addClass("planflow-flip-slow");
			card.style.removeProperty("transform");
		}
		// 兜底清理（rAF 不可靠时 300ms 后强制归零）
		window.setTimeout(() => {
			card.removeClass("planflow-flip-none");
			card.removeClass("planflow-flip-fast");
			card.removeClass("planflow-flip-med");
			card.removeClass("planflow-flip-slow");
			card.style.removeProperty("transform");
		}, 320);
		const names = othersAll().map((c) => c.getAttribute("data-plan-name") || "").filter(Boolean);
		plugin.settings.planOrder = names;
		void plugin.saveSettings();
	};

	// window 捕获阶段拦截 pointerdown（最早执行，抢在 Obsidian 任何监听之前）
	const onCapture = (e: PointerEvent): void => {
		if (!card.isConnected) {
			window.removeEventListener("pointerdown", onCapture, true);
			return;
		}
		// v1.7.4: 只响应左键——右键让位给卡头 contextmenu（编辑/删除计划菜单）
		if (e.button !== 0) return;
		const t = e.target as HTMLElement;
		if (t.closest("button, input, textarea, .planboard-icon-btn")) return;
		// v1.6: 精确匹配【本卡的 head】——路径里必须含本卡 head 才激活（修复"拖哪张都是第一张动"）
		if (!e.composedPath().includes(head)) return;
		e.preventDefault();
		e.stopImmediatePropagation(); // 阻断 Obsidian 及一切后续监听
		// v1.6: 拖动前彻底清理——防上次残留 transform 污染 rect 计算
		othersAll().forEach((c) => {
			c.removeClass("planflow-flip-none");
			c.removeClass("planflow-flip-fast");
			c.removeClass("planflow-flip-med");
			c.removeClass("planflow-flip-slow");
			c.style.removeProperty("transform");
		});
		// v1.6.1: 按下快照逻辑位置（此时无动画，实时 rect = 布局位置）
		logicRects.clear();
		othersAll().forEach((c) => {
			logicRects.set(c, c.getBoundingClientRect());
		});
		dragging = true;
		offsetX = 0;
		offsetY = 0;
		grabX = e.clientX;
		grabY = e.clientY;
		card.addClass("is-plan-dragging");
		lastKey = "";
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", finish, true);
		window.addEventListener("pointercancel", finish, true);
	};
	window.addEventListener("pointerdown", onCapture, true);
}
/** v1.7.2: 看板任务卡拖拽——列内重排（1D 垂直，重叠 1/3 触发）+ 跨列移动（拖入其他列松手写回）。
 *  mode: "category"（跨列 = 改 plan）/ "status"（跨列 = 改状态）。
 *  onDrop(task, targetCol) 负责数据写回 + 视图刷新。轻点（无移动）放行 click（打开编辑/勾选）。 */

function attachResizeHandle(
	card: HTMLElement,
	target: HTMLElement,
	plugin: PlanBoardPlugin,
	key: "monthCardHeight" | "weekCardHeight" | "checkCardHeight" | "summaryCardHeight" | "yearPlanHeights" | "weekChartHeight" | "trendChartHeight" | "heatCardHeight",
	linked?: {
		target: () => HTMLElement | null;
		key: "monthCardHeight" | "weekCardHeight" | "checkCardHeight" | "summaryCardHeight" | "weekChartHeight" | "trendChartHeight" | "heatCardHeight";
	},
	mapKey?: string,
	minH = 80,
): void {
	const handle = card.createDiv({ cls: "planboard-resize-handle", attr: { title: "拖动调整高度" } });
	let startY = 0;
	let startH = 0;
	const writeH = (h: number): void => {
		if (key === "yearPlanHeights" && mapKey) {
			plugin.settings.yearPlanHeights[mapKey] = h;
		} else {
			(plugin.settings as unknown as Record<string, number>)[key] = h;
		}
	};
	handle.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		startY = e.clientY;
		startH = target.clientHeight;
		const move = (ev: PointerEvent): void => {
			// v1.7.4: 自由缩放（默认 min 80，v3.9.2 可按卡指定下限）——handle 贴底即下边框，二者相对固定；
			// 内容溢出由各卡内容容器滚动/裁剪处理（见 styles.css 年度卡 plan-tasks 滚动）
			const h = Math.min(1200, Math.max(minH, startH + (ev.clientY - startY)));
			target.style.height = `${h}px`;
			writeH(h);
			if (linked) {
				const lt = linked.target();
				if (lt) {
					lt.style.height = `${h}px`;
					plugin.settings[linked.key] = h;
				}
			}
		};
		const up = (): void => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			void plugin.saveSettings();
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	});
}

/** 异步确认对话框（替代原生 confirm()，满足 Obsidian 官方审查合规要求）。返回 boolean。 */
function confirmDialog(app: App, message: string, opts: { confirmText?: string; cancelText?: string; danger?: boolean } = {}): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const modal = new Modal(app);
		modal.contentEl.addClass("planboard-confirm-modal");
		modal.contentEl.createEl("p", { text: message });
		const row = modal.contentEl.createDiv({ cls: "planboard-confirm-buttons" });
		const ok = new ButtonComponent(row)
			.setButtonText(opts.confirmText ?? "确定")
			.onClick(() => { resolve(true); modal.close(); });
		if (opts.danger) ok.buttonEl.addClass("mod-warning"); // 红色危险按钮（setWarning 已 deprecated、setDestructive 需 1.13+，用内置 CSS 类等效且无版本限制）
		new ButtonComponent(row)
			.setButtonText(opts.cancelText ?? "取消")
			.onClick(() => { resolve(false); modal.close(); });
		// Esc / 点遮罩关闭时兜底返回 false（按钮路径已先 resolve，二次 resolve 无效）
		modal.onClose = () => resolve(false);
		modal.open();
	});
}

/** 完成率分档（奖励机制）：≥100 金 / ≥80 银 / ≥60 铜 / 其余默认 */
function tierClass(percent: number): string {
	if (percent >= 100) return "is-gold";
	if (percent >= 80) return "is-silver";
	if (percent >= 60) return "is-bronze";
	return "";
}

/** 设置进度条分档 class（换档时清理旧档） */
function setTier(el: HTMLElement, percent: number): void {
	el.removeClass("is-gold", "is-silver", "is-bronze");
	const t = tierClass(percent);
	if (t) el.addClass(t);
}

/** Palette offered in PlanEditModal (spec v1.2); empty choice = auto-rotate. */

/**
 * v7.8（用户 115512 截图 #2）：打卡「用时」的四个快捷档位。
 *
 * v7.9（用户 130648 指令）：**不再是纯下拉，也不再留「不选」**——
 *   ① 默认值 = 上次打卡实际用过的值（存 `settings.checkMinutes`，首次 30）；
 *   ② 四档是「快捷填充」，点一下填进去，也允许自己敲（比如 45）；
 *   ③ 「选了 30 分之后默认就是 30，除非再手动改」由 ① 那条回写承担。
 */
const CHECK_MINUTE_TIERS = [10, 20, 30, 60] as const;
/** 用时兜底档：设置里没有值（首次安装 / 被清空）时用它。 */
const CHECK_MINUTES_FALLBACK = 30;
/** 用时上限（分钟）：防手滑敲出一长串数字把记录行撑爆。999 分 ≈ 16.6 小时，够用了。 */
const CHECK_MINUTES_MAX = 999;

/**
 * Main PlanBoard view: tab bar + per-tab panels (PRD §3, DEV.md M2).
 * Today panel is the home page (年度目标卡 → 本月任务卡 → 本周任务卡 → 今日打卡),
 * with live check-in toggling and task-pool CRUD in week/month/year views.
 */
export class PlanBoardView extends ItemView {
	plugin: PlanBoardPlugin;

	private tab: TabKey = "today";
	private today = todayStr();
	private dailyData: DailyData | null = null;
	private refreshTimer: number | null = null;
	/**
	 * 视图自己正在写盘的**嵌套层数**（>0 时抑制 vault modify 事件，避免自写触发重算）。
	 *
	 * 为什么是计数而不是布尔：写盘是 await 的，两个写盘会交错完成
	 * （快速连勾两个打卡项 / 补卡 + 自动补额 / 嵌套在 saveGoal 里写每日笔记）。
	 * 布尔方案下先完成的那个 finally 会把标记清成false，而另一个还在写 ——
	 * 它的 modify 事件就漏抑制了，界面无谓重算重绘（闪动），甚至读到写了一半的
	 * 状态引发连锁刷新。计数方案下只有最外层归零时才解除抑制。
	 */
	private selfWriteDepth = 0;
	/** Which panel's skeleton is currently rendered in the DOM. */
	private currentPanel: TabKey | null = null;
	private summaryFocused = false;
	/** v6.6: 任务页形态合并成一排三档（分类|状态|甘特）。
	 *  原先「看板|甘特」+「分类|状态」两排，用户要求并成一行三个。 */
	private taskMode: "category" | "status" | "gantt" = "category";

	// Task-pool data for the current period (refreshed on vault modify).
	private weekTasks: PoolTask[] = [];
	private monthTasks: PoolTask[] = [];
	private planProgress: PlanProgress[] = [];
	/** v6.5: 打卡率缓存——banner 常驻后，看板/甘特页算年度目标条时复用。 */
	private planRates: PlanRate[] = [];

	// DOM refs (nullable — guard before touching)
	private panelEl: HTMLElement | null = null;
	/** v4.0 窗格宽度断点：观察视图根元素实际宽度，挂 is-narrow / is-tiny 类。 */
	private resizeObserver: ResizeObserver | null = null;
	private paneWidthClass = "";
	/** 顶部日期行（v1.4）。 */
	private homeDateMainEl: HTMLElement | null = null;
	private homeDateSubEl: HTMLElement | null = null;
	private tabsEl: HTMLElement | null = null;
	/** v6.2: 顶栏 banner（渐变天蓝）——承载「页头 + 四个切换标签」，常驻、不随面板重建。 */
	private headerEl: HTMLElement | null = null;
	/** v6.5: banner 上半部——常驻的年度目标条（四页共用同一份，切页不重建）。 */
	private headerMainEl: HTMLElement | null = null;
	private checklistEl: HTMLElement | null = null;
	private summaryEl: HTMLTextAreaElement | null = null;
	/**
	 * v7.12: 「✅ 已完成 N/总」的挂点 —— 总结卡**标题行**中间那一枚。
	 *
	 * 它原来属于卡片里的统计行（v1.4 的「打卡自动生成区」，两行并列：
	 * ✅已完成 / ⬜未完成）。用户 143731 截图要求「把未完成去掉，把已完成上移到
	 * 标题行中间」，于是整块统计区连同那条虚线一起撤掉，只留这一枚计数上移。
	 * ⇒ 一并删除了 summaryAutoEl 字段与其 DOM 容器。
	 */
	private summaryDoneEl: HTMLElement | null = null;
	/**
	 * v7.11: 鼓励语（「已完成 50%，势头不错，继续冲！」）的挂点。
	 * 从统计那一行**上移到总结卡标题行**（用户 135859 截图要求），
	 * 所以它不再是统计区的子节点，得单独存一份引用。
	 * v7.12 起与 summaryDoneEl 同处标题行：标题左 · 已完成中 · 鼓励语右。
	 */
	private summaryCheerEl: HTMLElement | null = null;
	private progressNumberEl: HTMLElement | null = null;
	private todayBadgeEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;

	// Home-page task cards
	private goalListEl: HTMLElement | null = null;
	private goalEmptyEl: HTMLElement | null = null;
	private monthTaskNumberEl: HTMLElement | null = null;
	private monthTaskFillEl: HTMLElement | null = null;
	private monthPreviewEl: HTMLElement | null = null;
	private monthPreviewEmptyEl: HTMLElement | null = null;
	private weekTaskNumberEl: HTMLElement | null = null;
	private weekTaskFillEl: HTMLElement | null = null;
	private weekPreviewEl: HTMLElement | null = null;
	private weekPreviewEmptyEl: HTMLElement | null = null;
	private streakEl: HTMLElement | null = null;
	private monthTaskBadgeEl: HTMLElement | null = null;
	private weekTaskBadgeEl: HTMLElement | null = null;

	// v2.9 首页 dashboard 图表块（图表为主）
	private chartTrendEl: HTMLElement | null = null;
	private chartTrendMetaEl: HTMLElement | null = null;
	/** v3.9.4: 本月各计划打卡次数缓存（month → counts），勾选变动时置空重算。 */
	private planMonthCache: { month: string; counts: Record<string, number> } | null = null;
	private chartWeekEl: HTMLElement | null = null;
	// 每日完成度缓存（date YYYY-MM-DD → 该日完成打卡项数），供热力图与趋势图共享
	private completionMap: Map<string, number> | null = null;
	private completionMapYear = "";
	/**
	 * v7.22 补卡态缓存：`${date}|${显示名}` → 该项在那一天是否已打卡。
	 *
	 * 为什么需要：补卡的目标在**别的文件**里，今天的 `item.checked` 表达不了
	 * 「昨天打了、今天还没打」。下拉框切到昨天时现查那篇文件，命中即写入；
	 * 点按钮时读它判 undo。写盘成功后由 checkInOtherDate 就地更新，不必再读盘。
	 * 只存 true（false 无需记 —— 查不到就是没打，下次现查即可）。
	 */
	private backfilledState = new Map<string, boolean>();
	constructor(leaf: WorkspaceLeaf, plugin: PlanBoardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PLANFLOW;
	}

	getDisplayText(): string {
		return "计划总览";
	}

	getIcon(): string {
		return this.plugin.settings.icon || "calendar";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("planboard-root");
		// v6.5: 计划色改由 refresh() 统一重算（新增计划后不必重开视图）
		// v6.2: 顶栏 banner——标题区与四个切换标签同处一块，标签落在 banner 最下层。
		// 标签容器**常驻**（不随面板重建），所以它挂在 header 上、不挂在 content 上。
		this.headerEl = root.createDiv({ cls: "planboard-header" });
		this.headerMainEl = this.headerEl.createDiv({ cls: "planboard-header-main" });
		// v6.5: 年度目标条常驻 banner——只在打开时建一次，切页只换下面内容
		this.buildBannerGoals();
		this.tabsEl = this.headerEl.createDiv({ cls: "planboard-tabs" });
		this.renderTabs();
		this.panelEl = root.createDiv({ cls: "planboard-content" });
		// v4.0：按「窗格宽度」而不是「视口宽度」切布局（见 observePaneWidth 注释）。
		this.observePaneWidth(root);
		this.registerEvent(this.app.vault.on("modify", this.onVaultModify));
		this.registerEvent(this.app.vault.on("create", this.onVaultModify));
		this.registerEvent(this.app.vault.on("delete", this.onVaultDelete));
		this.registerEvent(this.app.vault.on("rename", this.onVaultRename));
		await this.refresh();
		// v1.7.3: 打开时自动创建今日笔记（保持计划总览完整）——Obsidian 启动时 vault 索引异步，
		// 延迟重试直到索引就绪，仍缺失则静默按模板创建。
		if (!this.getTodayFile()) {
			window.setTimeout(() => void this.autoEnsureTodayNote(), 1200);
			window.setTimeout(() => void this.autoEnsureTodayNote(), 3500);
		}
	}

	/**
	 * v4.0：按「窗格宽度」而不是「视口宽度」切换布局。
	 *
	 * Obsidian 的插件视图是分栏窗格，宽度由用户拖拽决定，与浏览器视口无关——
	 * 纯 @media 查询读的是视口，在 1920px 窗口里拖出 590px 的窗格时永远不会触发，
	 * 双列会被硬撑到 590px 里，卡片全被压扁。
	 *
	 * 这里用 ResizeObserver 观察视图根元素的实际宽度，挂两个类：
	 *   is-narrow（< 720px）：双列塌成单列，间距收紧
	 *   is-tiny  （< 420px）：进一步收紧内边距
	 * CSS 侧见 styles.css 末尾「v4.0 窗格宽度断点」一节。
	 */
	private observePaneWidth(el: HTMLElement): void {
		this.resizeObserver?.disconnect();
		const apply = (w: number): void => {
			// 布局未完成时 clientWidth 为 0，先不动类，等 ResizeObserver 首次回调。
			if (w <= 0) return;
			const next = w < 420 ? "is-tiny" : w < 720 ? "is-narrow" : "";
			if (next === this.paneWidthClass) return;
			el.removeClass("is-narrow");
			el.removeClass("is-tiny");
			if (next) el.addClass(next);
			this.paneWidthClass = next;
		};
		apply(el.clientWidth);
		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) apply(entry.contentRect.width);
		});
		this.resizeObserver.observe(el);
		this.register(() => {
			this.resizeObserver?.disconnect();
			this.resizeObserver = null;
		});
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
	}

	/** Called by the plugin when settings change. */
	requestRefresh(): void {
		void this.injectPlanColorStyles();
		void this.refresh();
	}

	// -------------------------------------------------------------------------
	// Vault event handling (PRD §4: modify + 500ms debounce, live sync)
	// -------------------------------------------------------------------------

	/**
	 * 包住一次「自己写盘」，期间抑制 vault modify 事件。
	 *
	 * 用法：`await this.withSelfWrite(() => this.app.vault.process(...))`
	 * 取代原先手工的 `selfWrite = true / try{...}finally{ selfWrite = false }`（13 处）。
	 * 计数而非布尔，见 selfWriteDepth 的注释。
	 */
	private async withSelfWrite<T>(fn: () => Promise<T>): Promise<T> {
		this.selfWriteDepth++;
		try {
			return await fn();
		} finally {
			this.selfWriteDepth--;
		}
	}

	private onVaultModify = (file: TAbstractFile): void => {
		if (this.selfWriteDepth > 0) return;
		if (file instanceof TFile && file.path.startsWith(this.plugin.settings.rootPath)) {
			// 库变了 → 统计缓存整体作废（下次 refresh 重算）。
			// 放在 scheduleRefresh 之前：debounce 期间可能有第二次事件，不清会读到旧值。
			invalidateStatsCache(this.app);
			this.scheduleRefresh();
		}
	};

	private onVaultDelete = (file: TAbstractFile): void => {
		if (file.path.startsWith(this.plugin.settings.rootPath)) {
			invalidateStatsCache(this.app);
			this.scheduleRefresh();
		}
	};

	private onVaultRename = (file: TAbstractFile, oldPath: string): void => {
		if (file.path.startsWith(this.plugin.settings.rootPath) || oldPath.startsWith(this.plugin.settings.rootPath)) {
			invalidateStatsCache(this.app);
			this.scheduleRefresh();
		}
	};

	private scheduleRefresh(): void {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 500);
	}

	// -------------------------------------------------------------------------
	// Tabs & panel switching
	// -------------------------------------------------------------------------

	private renderTabs(): void {
		if (!this.tabsEl) return;
		this.tabsEl.empty();
		// v1.0.5: tablist/tab/aria-selected —— 读屏与键盘用户此前感知不到「当前在哪个页」。
		// roving tabindex：只有激活 tab 可 Tab 聚焦，方向键在 tab 间移动（WAI-ARIA tabs 模式）。
		this.tabsEl.setAttribute("role", "tablist");
		// v6.5: 标签即每页标题（banner 常驻，页内不再重复放标题）
		// v6.8（#1）：四个标签各配一个图标——与卡片标题的 emoji 同一套读法。
		// 避让页内已占用的符号：📋 = 本周任务、🗂️ = 年度任务，故任务页取 🗂️ 同族、
		// 计划页取 🎯（与年度目标同源）、成就页取 🏆（与徽章墙同源）。
		const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
			{ key: "today", label: "今日行动", icon: "☀️" },
			{ key: "plans", label: "计划管理", icon: "🎯" },
			{ key: "tasks", label: "任务看板", icon: "🗂️" },
			{ key: "review", label: "我的成就", icon: "🏆" },
		];
		tabs.forEach((t, i) => {
			const active = this.tab === t.key;
			const btn = this.tabsEl!.createEl("button", {
				cls: "planboard-tab" + (active ? " is-active" : ""),
				attr: {
					role: "tab",
					"aria-selected": String(active),
					// roving tabindex：非激活 tab 用方向键到达，不进 Tab 序列
					tabindex: active ? "0" : "-1",
				},
			});
			btn.dataset.tabKey = t.key;
			btn.createSpan({ cls: "planboard-tab-icon", text: t.icon, attr: { "aria-hidden": "true" } });
			btn.createSpan({ cls: "planboard-tab-label", text: t.label });
			btn.addEventListener("click", () => void this.switchTab(t.key));
			btn.addEventListener("keydown", (e: KeyboardEvent) => {
				const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
				if (step !== 0) {
					e.preventDefault();
					const next = tabs[(i + step + tabs.length) % tabs.length];
					void this.switchTab(next.key, true);
				} else if (e.key === "Home" || e.key === "End") {
					e.preventDefault();
					void this.switchTab((e.key === "Home" ? tabs[0] : tabs[tabs.length - 1]).key, true);
				}
			});
		});
		// 键盘切页后焦点要跟上（初始化渲染时 activeElement 不在 tabs 内，不抢焦点）
		if (this.tabsEl.contains(document.activeElement)) {
			this.tabsEl.querySelector<HTMLElement>('.planboard-tab.is-active')?.focus();
		}
	}

	private async switchTab(tab: TabKey, fromKeyboard = false): Promise<void> {
		if (this.tab === tab) return;
		this.tab = tab;
		this.currentPanel = null; // force skeleton rebuild
		this.renderTabs();
		if (fromKeyboard && !this.tabsEl?.contains(document.activeElement)) {
			(this.tabsEl?.querySelector('.planboard-tab.is-active') as HTMLElement | null)?.focus();
		}
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		// v6.5: 计划色在此统一重算——此前只在 onOpen / 改设置时算过，
		// 新增「计划」后扇区与标签会先落到兜底色 #3572a8，必须重开视图才对。
		await this.injectPlanColorStyles();
		if (this.tab === "today") {
			await this.refreshToday();
		} else if (this.tab === "review") {
			await this.refreshReview();
		} else if (this.tab === "plans") {
			await this.refreshPlans();
		} else if (this.taskMode === "gantt") {
			await this.renderGanttPanel();
		} else {
			await this.renderBoardPanel();
		}
		// v6.5: banner 常驻——四页统一刷它：切页只换下面内容，banner 数值不滞后
		this.updateYearGoals();
		this.updateHomeDate();
	}

	// -------------------------------------------------------------------------
	// Today panel (home page)
	// -------------------------------------------------------------------------

	private getTodayPath(): string {
		const root = pfRoot(this.plugin.settings.rootPath);
		return dailyNotePath(root, this.today);
	}

	private getTodayFile(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.getTodayPath());
		return f instanceof TFile ? f : null;
	}

	/** Build the home page data: year goals + month/week task windows. */
	private async buildHomeData(): Promise<void> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);

		// v1.2 auto decomposition: top up this week's quota tasks for quantity plans.
		await this.ensureAutoTasksForToday(root, year);

		const tasks = await listTasks(this.app, root, year);

		const { start: ws, end: we } = weekRange(this.today);
		this.weekTasks = filterTasksInRange(tasks, ws, we);

		const [y, m] = this.today.split("-").map(Number);
		const monthStart = `${this.today.slice(0, 7)}-01`;
		const monthEnd = `${this.today.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
		this.monthTasks = filterTasksInRange(tasks, monthStart, monthEnd);

		// Annual check-in rates (needed for check-type plan progress).
		const yearStats = await computePeriodStats(
			this.app,
			this.plugin.settings.rootPath,
			this.today,
			"year",
			this.plugin.settings.reviewWorkdays
		);
		this.planRates = yearStats.planRates; // v6.5: 缓存给 banner 用（看板/甘特页也读它）
		this.planProgress = await computeAnnualPlanProgress(
			this.app,
			root,
			this.today,
			tasks,
			yearStats.planRates
		);
	}

	/**
	 * v6.5: banner 常驻后，任务看板/甘特两页也要给出「年度目标条」的数据。
	 * 这两页手上只有任务池，打卡率沿用最近一次别处算出的缓存；
	 * 缓存意外为空时（正常不会——默认落在「今日行动」页）就地补算一次。
	 */
	private async computeBannerProgress(root: string, tasks: PoolTask[]): Promise<PlanProgress[]> {
		if (this.planRates.length === 0) {
			const ys = await computePeriodStats(
				this.app,
				this.plugin.settings.rootPath,
				this.today,
				"year",
				this.plugin.settings.reviewWorkdays
			);
			this.planRates = ys.planRates;
		}
		return computeAnnualPlanProgress(this.app, root, this.today, tasks, this.planRates);
	}

	/** Read the annual plan's `plans` frontmatter (year-level, root-level fallback). */
	private async readAnnualPlanDefs(root: string, year: string): Promise<PlanDef[] | null> {
		for (const path of [annualPlanPath(root, year), annualPlanPath(root)]) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) {
				return parsePlansFromFrontmatter(await this.app.vault.cachedRead(f));
			}
		}
		return null;
	}

	/**
	 * v2.7: 今日打卡默认项 = 年度计划里 daily 计划的自动推导（无独立模板数据）。
	 * name = "{label} {计划名}"、复盘计划自动带复盘链接。
	 * v7.6: 不再带 action 后缀（原「1小时」），标题只有图标 + 计划名。
	 * v7.20: 勾了「量化到每日打卡」的目标也在窗口内每天一条（name = 目标名，
	 * plan 标签仍指计划——勾它计入计划打卡率/打卡统计，与量化进度（分解任务）两条线并行）。
	 * v7.21: 打卡项的名称/计划/窗口/复盘链接可自定义（GoalEditModal 可编辑段 →
	 * YAML dailyItem）；未配置回落目标自身值，口径与保存当天的立即补项一致。
	 */
	private async buildDefaultCheckItems(): Promise<PlanTemplate[]> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const defs = await this.readAnnualPlanDefs(root, this.today.slice(0, 4));
		if (!defs) return [];
		const items: PlanTemplate[] = [];
		for (const d of defs) {
			if (d.daily) {
				items.push({
					// v7.6：不再带 duration —— 标题就是「图标 + 计划名」，行动内容/用时打卡时现填
					name: `${d.label ?? ""} ${d.name}`.trim(),
					plan: d.name,
					includeReview: d.name === "复盘" || d.tradingDay,
				});
			}
			for (const g of d.goals) {
				if (!g.daily) continue;
				// v7.21: 打卡项内容/窗口用 dailyItem（可编辑段），未配置回落目标自身值
				const di = g.dailyItem;
				const name = di?.name ?? g.name;
				const plan = di?.plan ?? d.name;
				const ws = di?.start ?? g.start;
				const we = di?.due ?? g.end;
				if (ws && this.today < ws) continue;
				if (we && this.today > we) continue;
				items.push({ name, plan, includeReview: di?.review === true, start: ws, due: we });
			}
		}
		return items;
	}

	/**
	 * DEV.md v1.2: generate this week's quota tasks for quantity-type plans.
	 * Writes through the task pool (via ensureAutoTasks) only; suppressed from
	 * the vault-modify refresh loop via selfWrite.
	 */
	private async ensureAutoTasksForToday(root: string, year: string): Promise<void> {
		const defs = await this.readAnnualPlanDefs(root, year);
		if (!defs) return;
		const autoPlans: AutoTaskPlan[] = defs
			.filter((d) => d.type === "numeric" && d.targetCount > 0)
			.map((d) => ({
				name: d.name,
				target: d.target,
				targetCount: d.targetCount,
				goals: d.goals.map((g) => ({ name: g.name, count: g.count, unit: g.unit, start: g.start, end: g.end })),
			}));
		if (autoPlans.length === 0) return;
		const period = await readPlanPeriod(this.app, root, year);
		if (!period) return;
		await this.withSelfWrite(async () => {
			// v1.0.4: 传入墓碑（用户手动删除过的自动任务名），删除不再被补额"复活"
			const skip = new Set(this.plugin.settings.deletedAutoTasks ?? []);
			await ensureAutoTasks(this.app, root, year, this.today, autoPlans, period.start, period.end, skip);
		});
	}

	private async refreshToday(): Promise<void> {
		await this.buildHomeData();
		this.updateHomeDate();

		if (this.currentPanel !== "today") {
			this.panelEl?.empty();
			this.buildTodaySkeleton();
			this.currentPanel = "today";
		}

		// Home-page cards always render (independent of the daily note).
		this.updateYearGoals();
		this.updateMonthTaskCard();
		this.updateWeekTaskCard();

		const file = this.getTodayFile();
		if (!file) {
			this.setDailyCardsVisible(false);
			this.renderTodayDailyMissing();
			await this.updateStreak(); // v3.8.2: 骨架重建后再刷连击（原来在骨架前调用，首次渲染 span 还是空的）
			await this.updateHomeCharts(); // 今日笔记缺失：图表仍显示（环归零，周/计划照常）
			return;
		}
		this.setDailyCardsVisible(true);
		// Remove a stale "missing note" card left from an earlier refresh.
		this.panelEl?.querySelectorAll(".planboard-missing-card").forEach((el) => el.remove());
		const content = await this.app.vault.cachedRead(file);
		this.dailyData = parseDailyContent(file, content, this.today);
		this.updateProgress();
		this.updateChecklist();
		this.updateSummary();
		await this.updateStreak(); // v3.8.2: 移到骨架/数据之后——首次渲染连击不再丢
		await this.updateHomeCharts();
	}

	/**
	 * v6.5: banner 常驻的年度目标条——只在 onOpen 建一次骨架，
	 * 之后四页共享同一份 DOM：切标签只换下面内容，banner 不动。
	 * 数据由 refresh() 末尾统一刷新（updateYearGoals / updateHomeDate）。
	 */
	private buildBannerGoals(): void {
		const host = this.headerMainEl;
		if (!host) return;
		const goalCard = host.createDiv({ cls: "planboard-card planboard-goal-card" });
		const goalHeader = goalCard.createDiv({ cls: "planboard-card-header planboard-goal-header" });
		goalHeader.createDiv({ cls: "planboard-card-title", text: "🎯 年度目标" });
		// v1.5: 日期+问候并入年度标题行（左侧标题，右侧日期，省一行）
		const dateWrap = goalHeader.createDiv({ cls: "planboard-home-date" });
		this.homeDateMainEl = dateWrap.createSpan({ cls: "planboard-home-date-main" });
		// v6.9（#1）：问候语从日期组里拿出来，单独当 header 的第 3 个孩子——
		// banner 头是 grid「1fr auto 1fr」，第 3 格正好是"右半行"，居中落在那里。
		// 旧写法挂在 .planboard-home-date 里（第 2 格），只能跟在日期屁股后头。
		this.homeDateSubEl = goalHeader.createSpan({ cls: "planboard-home-greet" });
		this.goalListEl = goalCard.createDiv({ cls: "planboard-goal-strip" });
		// v1.0.5: 空状态从「实现细节指引」改为用户语言 + 直接动作——
		// frontmatter/plans 是文件格式，不是用户要做的事；去创建一步到位。
		const emptyWrap = goalCard.createDiv({ cls: "planboard-empty" });
		emptyWrap.createSpan({ text: "还没有年度计划" });
		const createBtn = emptyWrap.createEl("button", { cls: "planboard-btn planboard-btn-outline pf-empty-cta", text: "去创建" });
		createBtn.addEventListener("click", () => void this.openPlanModal(null));
		this.goalEmptyEl = emptyWrap;
	}

	private buildTodaySkeleton(): void {
		if (!this.panelEl) return;
		const panel = this.panelEl;

		// v1.0.3: 本月/本周卡改为纯展示 + 目标追踪（进度条/任务列表），新建统一在年度视图——
		// 原 4 个「+ 新建」按钮（header 与空态各一）已移除。
		// 注意：monthEnd/weekStart/weekEnd 仅被这些按钮使用，随之删除。

		// --- 1. 年度目标条在 banner 里常驻（v6.5，见 buildBannerGoals），本骨架不再自建 ---

		// --- 2. 周/月任务卡 (grid, two columns; v3.9.8: 本周在左——时间粒度从小到大) ---
		const taskGrid = panel.createDiv({ cls: "planboard-grid-2" });

		const weekCard = taskGrid.createDiv({ cls: "planboard-card planboard-week-task-card" });
		const weekHeader = weekCard.createDiv({ cls: "planboard-card-header" });
		weekHeader.createDiv({ cls: "planboard-card-title", text: "📋 本周任务" });
		const weekNumWrap = weekHeader.createDiv({ cls: "planboard-task-number planboard-task-number--inline" });
		this.weekTaskNumberEl = weekNumWrap.createSpan();
		this.weekTaskBadgeEl = weekNumWrap.createSpan({ cls: "planboard-badge planboard-hidden" });
		const weekBar = weekCard.createDiv({ cls: "planboard-progress-bar planboard-progress-bar--thin" });
		this.weekTaskFillEl = weekBar.createDiv({ cls: "planboard-progress-fill" });
		this.weekPreviewEl = weekCard.createEl("ul", { cls: "planboard-checklist planboard-home-preview" });
		if (this.plugin.settings.weekCardHeight > 0) this.weekPreviewEl.style.height = `${this.plugin.settings.weekCardHeight}px`;
		attachResizeHandle(weekCard, this.weekPreviewEl, this.plugin, "weekCardHeight", {
			target: () => this.monthPreviewEl,
			key: "monthCardHeight",
		});
		this.weekPreviewEmptyEl = weekCard.createDiv({ cls: "planboard-empty planboard-empty-cta" });
		this.weekPreviewEmptyEl.createSpan({ text: "本周暂无任务" });

		const monthCard = taskGrid.createDiv({ cls: "planboard-card planboard-month-task-card" });
		const monthHeader = monthCard.createDiv({ cls: "planboard-card-header" });
		monthHeader.createDiv({ cls: "planboard-card-title", text: "🗓️ 本月任务" });
		// v1.4: 任务数 + 徽章内联到标题行（省纵向空间）
		const monthNumWrap = monthHeader.createDiv({ cls: "planboard-task-number planboard-task-number--inline" });
		this.monthTaskNumberEl = monthNumWrap.createSpan();
		this.monthTaskBadgeEl = monthNumWrap.createSpan({ cls: "planboard-badge planboard-hidden" });
		const monthBar = monthCard.createDiv({ cls: "planboard-progress-bar planboard-progress-bar--thin" });
		this.monthTaskFillEl = monthBar.createDiv({ cls: "planboard-progress-fill" });
		this.monthPreviewEl = monthCard.createEl("ul", { cls: "planboard-checklist planboard-home-preview" });
		if (this.plugin.settings.monthCardHeight > 0) this.monthPreviewEl.style.height = `${this.plugin.settings.monthCardHeight}px`;
		attachResizeHandle(monthCard, this.monthPreviewEl, this.plugin, "monthCardHeight", {
			target: () => this.weekPreviewEl,
			key: "weekCardHeight",
		});
		this.monthPreviewEmptyEl = monthCard.createDiv({ cls: "planboard-empty planboard-empty-cta" });
		this.monthPreviewEmptyEl.createSpan({ text: "本月暂无任务" });

		// --- 3. 今日打卡 + 今日总结 (grid, equal columns) ---
		const dailyGrid = panel.createDiv({ cls: "planboard-grid-2 planboard-daily-only" });

		const checkCard = dailyGrid.createDiv({ cls: "planboard-card planboard-check-card" });
		const checkHeader = checkCard.createDiv({ cls: "planboard-card-header" });
		const checkTitle = checkHeader.createDiv({ cls: "planboard-card-title planboard-check-title" });
		checkTitle.createSpan({ text: "✅ 今日打卡" });
		// v1.4: 进度数字内联到标题行（与月/周卡一致，省纵向空间）
		this.progressNumberEl = checkHeader.createSpan({ cls: "planboard-progress-number planboard-progress-number--inline" });
		// v3.7: 连击提示移至总结卡标题行（原在此处，随 KPI 行移除一并归位）
		// 今日打卡分档徽章（即时显示，不结算进徽章墙）
		this.todayBadgeEl = checkTitle.createSpan({ cls: "planboard-badge planboard-today-badge planboard-hidden" });
		const addBtn = checkHeader.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-add-btn", text: "+ 添加" });
		addBtn.addEventListener("click", () => void this.openAddItemModal());
		const bar = checkCard.createDiv({ cls: "planboard-progress-bar" });
		this.progressFillEl = bar.createDiv({ cls: "planboard-progress-fill" });
		this.checklistEl = checkCard.createEl("ul", { cls: "planboard-checklist" });
		// v1.4: 打卡卡也可拖底部调高（内容 flex 填充），与总结卡联动同步
		if (this.plugin.settings.checkCardHeight > 0) checkCard.style.height = `${this.plugin.settings.checkCardHeight}px`;
		attachResizeHandle(checkCard, checkCard, this.plugin, "checkCardHeight", {
			target: () => this.summaryEl?.closest(".planboard-summary-card") ?? null,
			key: "summaryCardHeight",
		});

		const summaryCard = dailyGrid.createDiv({ cls: "planboard-card planboard-summary-card" });
		// v1.7.4: 标题包进 header（与打卡卡同构——两卡 header 等高 38px + center，标题/按钮同一中心线）
		const summaryHeader = summaryCard.createDiv({ cls: "planboard-card-header" });
		summaryHeader.createDiv({ cls: "planboard-card-title", text: "📝 今日总结" });
		/* v7.12（用户 143731 截图「把已完成上移到标题行中间」）：
		   这一枚放在**标题与鼓励语之间**。header 在 CSS 里是 grid 三列
		   （minmax(0,1fr) / auto / minmax(0,1fr)），左右两列等宽，
		   所以它天然落在卡片水平中点上 —— 用 flex 做不到（见 styles.css 那段注释）。 */
		this.summaryDoneEl = summaryHeader.createSpan({ cls: "planboard-summary-done" });
		/* v7.11（用户 135859 截图）：鼓励语从下面的统计行**上移到标题行**。
		   连击徽章同步搬走（那枚徽章原来也占着这一行，两样挤不下），
		   新家是「📅 本月每日打卡」的标题行 —— 见下方 weekChartHeader。 */
		this.summaryCheerEl = summaryHeader.createSpan({ cls: "planboard-summary-cheer" });
		/* v7.12（用户 143731 截图「把未完成去掉」）：原来这里还有一块
		   `.planboard-summary-auto`（✅已完成 N/总 ⬜未完成 N/总 两行 + 一条虚线）。
		   整块**已删除** —— 未完成不再展示，已完成搬去标题行。 */
		this.summaryEl = summaryCard.createEl("textarea", {
			cls: "planboard-summary-input",
			attr: { placeholder: "今天完成了什么？写点什么吧…" },
		});
		this.summaryEl.addEventListener("focus", () => {
			this.summaryFocused = true;
		});
		this.summaryEl.addEventListener("blur", () => {
			this.summaryFocused = false;
			void this.saveSummary();
		});
		// v1.4: 复盘入口移到总结区底部（不占 header）
		const reviewBtn = summaryCard.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-review-btn planboard-review-bottom", text: "📝 写复盘 →" });
		reviewBtn.addEventListener("click", () => void this.openOrCreateReview());
		// v1.4: 总结卡也可拖底部调高（textarea flex 填充），与打卡卡联动同步
		if (this.plugin.settings.summaryCardHeight > 0) summaryCard.style.height = `${this.plugin.settings.summaryCardHeight}px`;
		attachResizeHandle(summaryCard, summaryCard, this.plugin, "summaryCardHeight", {
			target: () => this.checklistEl?.closest(".planboard-check-card") ?? null,
			key: "checkCardHeight",
		});
		// --- v3.7 dashboard 精简：KPI 4 卡移除（今日完成在打卡卡/连击在总结卡标题行已体现）---
		// ② v3.6: 年度计划圆环卡已移除（与年度目标 banner 功能重复）；热力图移至页面底部通栏
		// ③ 本月每日柱状 + 月度趋势（v3.8: 周→月；两卡可拖下边框调高）
		const weekRow = panel.createDiv({ cls: "planboard-grid-2 planboard-charts" });
		const weekChartCard = weekRow.createDiv({ cls: "planboard-card planboard-chart-card" });
		const weekChartHeader = weekChartCard.createDiv({ cls: "planboard-card-header" });
		/* v6.7（#6）：其它卡片标题都带图标，这两张漏了 */
		weekChartHeader.createDiv({ cls: "planboard-card-title", text: "📅 本月每日打卡" });
		/* v7.11（用户 135859 截图）：连击徽章从「今日总结」标题行搬到这里。
		   放这张卡是因为连击讲的就是「每天有没有打卡」—— 与这张柱状图同一件事；
		   挂在这条 header 右端（header 是 space-between，标题左、徽章右）。
		   原来它在总结卡标题行是 absolute 居中定位的，那条 CSS 已随本次搬家删除。 */
		this.streakEl = weekChartHeader.createSpan({ cls: "planboard-streak planboard-hidden" });
		this.chartWeekEl = weekChartCard.createDiv({ cls: "planboard-chart-body" });
		if (this.plugin.settings.weekChartHeight > 0) weekChartCard.style.height = `${this.plugin.settings.weekChartHeight}px`;
		// v3.9: 两卡高度联动——拖任一个，另一个同步（与打卡/总结卡同款交互）
		attachResizeHandle(weekChartCard, weekChartCard, this.plugin, "weekChartHeight", {
			target: () => this.chartTrendEl?.closest(".planboard-chart-card") ?? null,
			key: "trendChartHeight",
		});
		const trendCard = weekRow.createDiv({ cls: "planboard-card planboard-chart-card" });
		const trendHeader = trendCard.createDiv({ cls: "planboard-card-header" });
		trendHeader.createDiv({ cls: "planboard-card-title", text: "📊 本月各计划打卡" });
		// v3.9.2: 标题行右侧环比提示（上周 vs 前周）
		this.chartTrendMetaEl = trendHeader.createSpan({ cls: "planboard-chart-meta" });
		this.chartTrendEl = trendCard.createDiv({ cls: "planboard-chart-body" });
		if (this.plugin.settings.trendChartHeight > 0) trendCard.style.height = `${this.plugin.settings.trendChartHeight}px`;
		attachResizeHandle(trendCard, trendCard, this.plugin, "trendChartHeight", {
			target: () => this.chartWeekEl?.closest(".planboard-chart-card") ?? null,
			key: "weekChartHeight",
		});
		// v3.9.9: 热力图移至「回顾」年视图（全年视角统一归回顾），行动页不再渲染

		// 骨架重建后刷新日期行（refreshToday 的调用可能早于重建）
		this.updateHomeDate();
	}

	/** v2.9: 首页 dashboard 图表刷新——4 KPI + 圆环组 + 周柱 + 热力图 + 月度趋势（手写 SVG，零依赖）。 */
	private async updateHomeCharts(): Promise<void> {
		// 一次性读 365 天每日完成度（缓存同年内复用），供热力图/周柱/趋势共享
		// v1.1.1 修正：守卫漏了「map 已被置 null」的情况——补卡路径把 completionMap
		// 置 null 想强制重算，但年份没变守卫不通过，`?? new Map()` 拿到空表，
		// 本月每日柱状全部退化成不可见的幽灵槽（用户实测「统计条全消失」）。
		// 与回顾页年度图表（3199 行）的正确守卫对齐。
		const year = this.today.slice(0, 4);
		if (this.completionMapYear !== year || !this.completionMap) {
			this.completionMap = await this.computeDailyCompletionMap(year);
			this.completionMapYear = year;
		}
		const map = this.completionMap ?? new Map<string, number>();

		// ① v3.7: KPI 4 卡已移除——今日完成见打卡卡、连击见总结卡标题行、年度进度见 banner、徽章见回顾页

		// ② v3.6: 计划圆环组已随圆环卡移除（banner 内已有每计划进度条，不再重复）

		// ③ v3.9.9: 打卡热力图已移入「回顾·年」页，首页不再显示

		// 分母 = 每日打卡项总数（v3.2 方案 B）——月柱与趋势共用
		const goalTotal = this.dailyData?.checkItems.length ?? 0;

		// ④ 本月每日柱状（v3.8: 周→月，用共享 map，不重复读文件）
		if (this.chartWeekEl) {
			this.chartWeekEl.empty();
			const { done: monthDone, slots } = this.monthSeriesFromMap(map);
			this.chartWeekEl.appendChild(buildMonthBarsSvg(monthDone, goalTotal, slots));
		}

		// ⑤ 本月各计划打卡（v3.9.4: 方案 A——每计划一根横向条，长度=当月勾选次数；与左侧"本月每日打卡"同粒度）
		if (this.chartTrendEl) {
			this.chartTrendEl.empty();
			const counts = await this.planMonthCounts();
			// v3.9.4.1: 行 = 计划列表全集（0 次也要显示"0 次"），counts 里有而计划里没有的孤儿计划追加在尾部
			const rows = this.planProgress.map((p) => ({
				plan: p.plan,
				count: counts[p.plan] ?? 0,
				color: this.planColorVars[p.plan]?.["--pb-accent"],
			}));
			for (const [plan, count] of Object.entries(counts)) {
				if (!rows.some((r) => r.plan === plan)) rows.push({ plan, count, color: this.planColorVars[plan]?.["--pb-accent"] });
			}
			rows.sort((a, b) => this.orderIndexOf(a.plan) - this.orderIndexOf(b.plan));
			const total = rows.reduce((s, r) => s + r.count, 0);
			// v3.9.5: 满条 = 整月天数（9 月 = 31），不再按"计划间最大值"缩放
			this.chartTrendEl.appendChild(buildPlanBarsH(rows, new Date(Number(this.today.slice(0, 4)), Number(this.today.slice(5, 7)), 0).getDate()));
			if (this.chartTrendMetaEl) this.chartTrendMetaEl.textContent = `本月合计 ${total} 次`;
		}
	}

	/**
	 * 读整年每日完成度（并发 cachedRead，无文件=0）。
	 * 一次刷新首屏 ~365 次文件元数据查询 + 已有文件读缓存，耗时 < 1s。
	 */
	private async computeDailyCompletionMap(year: string): Promise<Map<string, number>> {
		const rootPath = pfRoot(this.plugin.settings.rootPath);
		const start = new Date(`${year}-01-01T00:00:00`);
		const dates: string[] = [];
		for (let i = 0; i < 366; i++) {
			const d = new Date(start);
			d.setDate(d.getDate() + i);
			if (d.getFullYear() !== Number(year)) break;
			dates.push(formatDate(d));
		}
		const reads = dates.map(async (date) => {
			const f = this.app.vault.getAbstractFileByPath(dailyNotePath(rootPath, date));
			if (!(f instanceof TFile)) return [date, 0] as const;
			const content = await this.app.vault.cachedRead(f);
			return [date, parseDailyContent(f, content, date).checkItems.filter((c) => c.checked).length] as const;
		});
		const pairs = await Promise.all(reads);
		return new Map(pairs);
	}

	/** 从全年 map 截取本周 7 天（复用缓存）。 */
	/** v3.8: 本月 1 日至今的每日完成数（月度柱状用，替代原周序列）。slots = 整月天数（未来日期留空位，柱宽恒定）。 */
	private monthSeriesFromMap(map: Map<string, number>): { done: number[]; slots: number } {
		const year = Number(this.today.slice(0, 4));
		const month = Number(this.today.slice(5, 7));
		const day = Number(this.today.slice(8, 10));
		const slots = new Date(year, month, 0).getDate();
		const prefix = this.today.slice(0, 8);
		const done: number[] = [];
		for (let d = 1; d <= day; d++) {
			done.push(map.get(`${prefix}${String(d).padStart(2, "0")}`) ?? 0);
		}
		return { done, slots };
	}

	/**
	 * v3.9.4: 本月每个计划的打卡次数——遍历当月每日笔记，✅ 项按 #计划/ 归属计数。
	 * 结果缓存到月；勾选变动时由 refreshHomeChartsAfterChange 清缓存。
	 */
	private async planMonthCounts(): Promise<Record<string, number>> {
		const month = this.today.slice(0, 7);
		if (this.planMonthCache?.month === month) return this.planMonthCache.counts;
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = month.slice(0, 4);
		const counts: Record<string, number> = {};
		const folder = this.app.vault.getAbstractFileByPath(dailyDir(root, year));
		if (folder instanceof TFolder) {
			for (const f of folder.children) {
				if (!(f instanceof TFile) || !f.name.startsWith(month)) continue;
				const date = f.basename;
				if (date > this.today) continue; // 未来日期不统计
				const data = await this.app.vault.cachedRead(f);
				for (const item of parseDailyContent(f, data, date).checkItems) {
					if (!item.checked || !item.plan) continue;
					counts[item.plan] = (counts[item.plan] ?? 0) + 1;
				}
			}
		}
		this.planMonthCache = { month, counts };
		return counts;
	}

	private setDailyCardsVisible(visible: boolean): void {
		this.panelEl?.querySelectorAll(".planboard-daily-only").forEach((el) => {
			(el as HTMLElement).toggleClass("planboard-hidden", !visible);
		});
	}

	// --- Home page cards -----------------------------------------------------

	private updateYearGoals(): void {
		if (!this.goalListEl || !this.goalEmptyEl) return;
		this.goalListEl.empty();
		this.goalEmptyEl.hidden = this.planProgress.length > 0;
		for (const prog of this.planProgress) {
			this.goalListEl.appendChild(this.renderGoalRow(prog));
		}
	}

	private renderGoalRow(prog: PlanProgress): HTMLElement {
		// v1.4 紧凑条：每计划 = 图标+名 + 数字 + 迷你进度条，一行内一目了然（无展开交互）
		const item = createDiv({ cls: "planboard-goal-strip-item" });
		item.setAttribute("title", prog.target || prog.plan);
		const nameSpan = item.createSpan({
			cls: "planboard-goal-name",
			// label 含名称时不重复拼接（"✍️ 写作"），纯 emoji/空时补上计划名
			text: prog.label && !prog.label.includes(prog.plan) ? `${prog.label} ${prog.plan}` : prog.label || prog.plan,
		});
		// v3.6: 计划名用计划色强调——浅色主题加深版保证可读，深色主题柔化提亮
		const resolved = this.planColorVars[prog.plan]?.["--pb-accent"] || prog.color;
		if (resolved) {
			nameSpan.addClass("is-plan-colored");
			nameSpan.style.setProperty("--plan-title-light", deepenForText(resolved));
			nameSpan.style.setProperty("--plan-title-dark", softenChartColor(resolved));
		}

		let number: string;
		if (prog.isNumeric && prog.goals.length > 0) {
			// 多 goal：显示合计 done/target（如 3/22），子目标 hover 可见
			number = `${prog.doneCount}/${prog.targetCount}`;
		} else if (prog.isNumeric) {
			const unit = planCounterUnit(prog.target);
			number = `${prog.doneCount}/${prog.targetCount}${unit ? ` ${unit}` : ""}`;
		} else {
			number = `${prog.percent}%`;
		}
		item.createSpan({ cls: "planboard-goal-number", text: number });

		const bar = item.createDiv({ cls: "planboard-progress-bar planboard-progress-bar--mini" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${prog.percent}%`;
		setTier(fill, prog.percent);
		return item;
	}

	private updateMonthTaskCard(): void {
		const { total, done, percent } = summarize(this.monthTasks);
		this.monthTaskNumberEl?.setText(total === 0 ? "0/0" : `${done}/${total}`);
		this.updateTaskBadge(this.monthTaskBadgeEl, done, total);
		if (this.monthTaskFillEl) {
			this.monthTaskFillEl.style.width = `${percent}%`;
			setTier(this.monthTaskFillEl, percent);
		}

		if (!this.monthPreviewEl || !this.monthPreviewEmptyEl) return;
		this.monthPreviewEl.empty();
		this.monthPreviewEmptyEl.hidden = this.monthTasks.length > 0;
		// v1.4: 全量列出当期任务（卡片内滚动）
		for (const t of this.monthTasks) {
			this.monthPreviewEl.appendChild(this.renderTaskItem(t));
		}
	}

	private updateWeekTaskCard(): void {
		const { total, done, percent } = summarize(this.weekTasks);
		this.weekTaskNumberEl?.setText(total === 0 ? "0/0" : `${done}/${total}`);
		this.updateTaskBadge(this.weekTaskBadgeEl, done, total);
		if (this.weekTaskFillEl) {
			this.weekTaskFillEl.style.width = `${percent}%`;
			setTier(this.weekTaskFillEl, percent);
		}

		if (!this.weekPreviewEl || !this.weekPreviewEmptyEl) return;
		this.weekPreviewEl.empty();
		this.weekPreviewEmptyEl.hidden = this.weekTasks.length > 0;
		// v1.4: 全量列出当期任务（卡片内滚动）
		for (const t of this.weekTasks) {
			this.weekPreviewEl.appendChild(this.renderTaskItem(t));
		}
	}

	/** v1.6: 计划在 settings.planOrder 中的位置（未收录 = 末尾，保持原相对顺序）。 */
	private orderIndexOf(plan: string): number {
		const i = this.plugin.settings.planOrder.indexOf(plan);
		return i === -1 ? Number.MAX_SAFE_INTEGER : i;
	}

	/** v1.6: 给计划卡挂拖拽排序（grip 在卡头最左）。 */
	private attachPlanSortTo(card: HTMLElement, container: HTMLElement, plan: string, cols?: HTMLElement[]): void {
		attachPlanSort(card, container, this.plugin, plan, cols);
	}

	/** 🔥 连续打卡天数：当天完成 ≥1 项即计 1 天（v1.1.1 放宽，原全勾口径恒为 0），再往前累计。 */
	private async updateStreak(): Promise<void> {
		if (!this.streakEl) return;
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const streak = await computeStreak(this.app, root, year, this.today);
		// v3.8: 常态显示——没有连击就显示 0 天（不再隐藏）
		this.streakEl.setText(`🔥 连续打卡 ${streak} 天`);
		this.streakEl.removeClass("planboard-hidden");
	}

	/** v1.4: 顶部日期 + 时段问候（时间锚点）。 */
	private updateHomeDate(): void {
		if (!this.homeDateMainEl) return;
		const [y, m, d] = this.today.split("-").map(Number);
		const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
		const wd = weekdays[new Date(y, m - 1, d).getDay()];
		this.homeDateMainEl.setText(`${m}月${d}日 周${wd}`);
		if (!this.homeDateSubEl) return;
		const h = new Date().getHours();
		let greet: string;
		if (h < 6) greet = "夜深了，早点休息 🌙";
		else if (h < 9) greet = "早上好，开始今天的打卡吧 ☀️";
		else if (h < 12) greet = "上午好，保持节奏 📈";
		else if (h < 14) greet = "中午好，别忘了今日打卡 🍚";
		else if (h < 18) greet = "下午好，继续加油 💪";
		else if (h < 22) greet = "晚上好，今天打卡了吗 ✨";
		else greet = "夜深了，收尾今天的打卡吧 🌙";
		this.homeDateSubEl.setText(greet);
	}

	/** 任务卡进度数字旁的完成率徽章（≥60 铜 / ≥80 银 / 100 金）。 */
	private updateTaskBadge(el: HTMLElement | null, done: number, total: number): void {
		if (!el) return;
		el.removeClass("is-gold", "is-silver", "is-bronze", "planboard-hidden");
		const tier = tierFor(done, total);
		const prev = el.dataset.tier ?? "";
		if (tier) {
			setBadgeContent(el, tier.emoji, tier.qualifier);
			el.addClass(tier.cls);
			// v1.4: 档位变化 → 弹出动画 + 音效（与今日打卡徽章一致）；
			// 首次渲染（prev 为空）不播音效，避免打开视图时响
			if (tier.cls !== prev && prev !== "") {
				el.addClass("planboard-badge-pop");
				window.setTimeout(() => el.removeClass("planboard-badge-pop"), 700);
				if (this.plugin.settings.achievementSound) playAchievementSound();
			}
			const pct = total === 0 ? 0 : Math.round((done / total) * 100);
			el.setAttribute("title", `完成率 ${pct}%（${total > 0 ? `${done}/${total}` : "暂无任务"}），达成${tier.qualifier}`);
		} else {
			el.setText("");
			el.addClass("planboard-hidden");
		}
		el.dataset.tier = tier?.cls ?? "";
	}

	// --- Daily check-in (M1, preserved) -------------------------------------

	private lastTierKey = "";
	/** 今日徽章是否已初始化（首次渲染不播音效，v1.4）。 */
	private badgeInitialized = false;

	private updateProgress(): void {
		const checks = this.dailyData?.checkItems ?? [];
		const done = checks.filter((c) => c.checked).length;
		const total = checks.length;
		const pct = total === 0 ? 0 : Math.round((done / total) * 100);
		this.progressNumberEl?.setText(total === 0 ? "0/0" : `${done}/${total}`);
		// Dynamic width is the only in-DOM value; the 200ms animation comes from CSS.
		if (this.progressFillEl) {
			this.progressFillEl.style.width = `${pct}%`;
			setTier(this.progressFillEl, pct);
		}
		// 今日分档徽章（即时反馈；周结算时并入徽章墙）
		if (this.todayBadgeEl) {
			const tier = tierFor(done, total);
			const tierKey = tier ? tier.cls : "";
			if (tier) {
				this.todayBadgeEl.removeClass("is-gold", "is-silver", "is-bronze");
				setBadgeContent(this.todayBadgeEl, tier.emoji, tier.qualifier);
				this.todayBadgeEl.addClass(tier.cls);
				this.todayBadgeEl.removeClass("planboard-hidden");
				// 达成（升档）时刻：弹出动画 + 叮声（首次渲染不播）
				if (tierKey !== this.lastTierKey && this.badgeInitialized) {
					this.todayBadgeEl.removeClass("planboard-badge-pop");
					// 强制重排以重触发动画
					void this.todayBadgeEl.offsetWidth;
					this.todayBadgeEl.addClass("planboard-badge-pop");
					window.setTimeout(() => this.todayBadgeEl?.removeClass("planboard-badge-pop"), 800);
					if (this.plugin.settings.achievementSound) playAchievementSound();
				}
				this.badgeInitialized = true;
				this.todayBadgeEl.setAttribute("title", `今日完成率 ${pct}%，达成${tier.qualifier}`);
			} else {
				this.todayBadgeEl.removeClass("is-gold", "is-silver", "is-bronze");
				this.todayBadgeEl.addClass("planboard-hidden");
			}
			this.lastTierKey = tierKey;
		}
	}

	/**
	 * 重画打卡卡。
	 *
	 * @param keepDate v7.22b：重绘后把每一行的下拉框设到这一档（补卡后用）。
	 *   整卡是 `empty()` 后重建的，不设的话下拉框一律回到默认「今天」——
	 *   补完昨天的卡却显示成今天的「打卡」按钮，用户会以为**没生效**（15:41 实测反馈）。
	 *   传 undefined = 保持原行为（默认今天）。
	 */
	private updateChecklist(keepDate?: string): void {
		if (!this.dailyData || !this.checklistEl) return;
		this.checklistEl.empty();
		for (const item of this.dailyData.checkItems) {
			const li = this.renderCheckItem(item, keepDate);
			this.checklistEl.appendChild(li);
		}
	}

	private renderCheckItem(item: CheckItem, keepDate?: string): HTMLElement {
		const li = createEl("li", { cls: "planboard-check-item" + (item.checked ? " is-checked" : "") });
		li.setAttribute("data-line", String(item.line));

		// v7.5（用户 084611 截图 + 002818 参考图）：行首复选框取消，打卡动作后置为按钮。
		// 左区现在只剩标题（原 <label> 只用来裹复选框，现在拆成纯展示 div）。
		// v7.6：**去掉计划标签那一列**——计划名已在标题里（「✍️ 写作」），再挂一颗
		// 「写作」药丸纯属重复占宽。
		// v7.13（用户 150250 截图）：**行首那颗 8px 色点也一并取消**
		// （用户：「所有页面遗留的彩色圆点都取消了吧」）。归属信息没有丢 —— 今日页标题里
		// 已带计划 emoji（「✍️ 写作」），计划页的任务行本身就落在该计划的卡里，
		// 任务看板另有 `.planboard-plan-tag` 药丸。
		const main = li.createDiv({ cls: "planboard-check-main" });
		main.createSpan({ cls: "planboard-check-text", text: this.checkDisplayText(item) });
		// v7.19: 起止日期展示——添加打卡项时可带窗口（量化目标分解到日的人工补充）。
		// 只在窗口不是「当天~当天」时才显示，老打卡项（起止都是当天）一概不加尾巴。
		if ((item.start && item.start !== this.today) || (item.due && item.due !== this.today)) {
			const dates: string[] = [];
			if (item.start) dates.push(`🛫 ${item.start}`);
			if (item.due) dates.push(`📅 ${item.due}`);
			main.createSpan({ cls: "planboard-task-dates", text: dates.join("  ") });
		}

		// v7.8（截图 #3）：行末尾簇 = ↑↓✕ + 打卡按钮，**必须包在同一个 div 里**。
		// 为什么不拆成两个并列的 li 子元素：那样 `margin-left: auto` 挂在谁身上谁才右对齐；
		// 一旦放不下换行，另一个会单独落到第二行**行首**（实测 419px 卡片上「✓ 已打卡」
		// 按钮孤零零停在 x=112，离右缘还差 262px）。包成一个整体后，换行时两者一起落到
		// 第二行、整簇贴右缘 —— 行末右对齐在「一行」和「两行」两种情形下都成立。
		const tail = li.createDiv({ cls: "planboard-check-tail" });

		const actions = tail.createDiv({ cls: "planboard-item-actions" });
		const upBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-move-btn", attr: { "aria-label": "上移", title: "上移" } });
		setIcon(upBtn, "lucide-arrow-up");
		upBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.moveCheckItem(item, -1);
		});
		const downBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-move-btn", attr: { "aria-label": "下移", title: "下移" } });
		setIcon(downBtn, "lucide-arrow-down");
		downBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.moveCheckItem(item, 1);
		});
		// v1.0.5.2: 行内 ✕ 移除——删除收归计划管理页（计划卡「✅ 打卡行动」行的 ✏️🗑️）。
		// 理由：删除是低频+危险动作，行内高频位置放破坏键误触代价高；今日页职责收敛为
		// 打卡与顺序微调，与计划卡「编辑用右键/管理页」的既有分工一致。

		// --- v7.8：右区控件（用时 + 日期）+ 行末打卡按钮 ---
		const controls = li.createDiv({ cls: "planboard-check-controls" });
		// v7.8（用户 115512 截图 #1）：「打卡内容」输入框下线。
		// 打卡现在只记「用时」这一件事——当天做了什么由任务勾选负责，
		// 再让人手打一遍纯属重复，还白占一行宽度。
		//
		// v7.9（用户 130648）：用时 = **可输入的档位选择器**。
		//   · 仍是 `<input>`（能敲数字），`list` 指向 datalist 给出 10/20/30/60 四个快捷档；
		//   · **不再留空档**：默认值 = 上次打卡实际用过的值（settings.checkMinutes，首次 30），
		//     这正是「选了 30 分，以后打卡默认就是 30，除非再手动改」；
		//   · 值后面带「分」，因为空档去掉后 placeholder 不再可见，不给单位的话
		//     一个孤零零的「30」和旁边的日期框分不清是什么。
		// 用时 = 输入框 + 右侧档位按钮，**合成一个 60px 的「可输入下拉」**。
		//
		// 为什么不用 `<input list>` + `<datalist>`（第一版做法）：档位箭头由 Blink 画在
		// `::-webkit-calendar-picker-indicator` 上，而这版 Electron 里那个指示器**时有时无** ——
		// 同一份规则写在 styles.css 里它不出现（字段和普通文本框长得一样、用户不知道能点），
		// 临时注入同样的规则却又出现，二分了十几轮没找到稳定触发条件。赌 UA 的实现不如自己画。
		// 现在箭头是我们自己的按钮，点开是 Obsidian 原生 Menu，行为完全可控。
		const minutesField = controls.createDiv({ cls: "planboard-check-minutes-field" });
		const minutes = minutesField.createEl("input", {
			cls: "planboard-check-input planboard-check-minutes",
			attr: {
				type: "text",
				inputmode: "numeric",
				value: `${this.defaultCheckMinutes()}分`,
				title: `用时（分钟）：点右侧箭头选 ${CHECK_MINUTE_TIERS.join(" / ")} 档，也可直接输入；改过的值会成为以后打卡的默认`,
				"aria-label": "打卡用时（分钟）",
			},
		});
		const tiersBtn = minutesField.createEl("button", {
			cls: "planboard-check-tiers-btn",
			attr: {
				type: "button",
				"aria-label": "选择用时档位",
				title: `选择用时档位（${CHECK_MINUTE_TIERS.join(" / ")} 分），也可以直接在左边输入`,
			},
		});
		tiersBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const cur = this.parseCheckMinutes(minutes.value);
			const menu = new Menu();
			for (const t of CHECK_MINUTE_TIERS) {
				menu.addItem((mi) =>
					mi
						.setTitle(`${t} 分`)
						.setChecked(cur === t)
						.onClick(() => {
							minutes.value = `${t}分`;
						})
				);
			}
			menu.showAtMouseEvent(e);
		});
		const dateSel = controls.createEl("select", {
			cls: "planboard-check-input planboard-check-date",
			attr: { title: "打卡日期：默认今天；昨天那一档是补卡（写进昨天那篇日记）" },
		});
		for (const [label, value] of this.checkDateOptions()) {
			dateSel.createEl("option", { text: label, value });
		}
		// v7.22b：重绘时若指定了档位（补卡后），就选中它并按该档渲染按钮 ——
		// 否则一律回默认「今天」，用户会以为补卡没生效。
		const initialDate =
			keepDate && this.checkDateOptions().some(([, v]) => v === keepDate) ? keepDate : this.today;
		dateSel.value = initialDate;

		// v7.22：这一项在**其它日期**那篇日记里的打卡态，键 = `${date}|${显示名}`。
		// 界面上「已打卡」要跟随下拉框走（见下方 syncBtnToDate），而选昨天时该项
		// 根本不在今天这篇里，只能现查现存；查一次存一次，点击时直接读它判 undo。
		const key = this.checkDisplayText(item);

		// 打卡按钮（截图 #3）：作为**末簇的最后一个元素**（`order` 上排在 ↑↓✕ 之后），
		// 由末簇的 `margin-left: auto` 一起顶到卡片右缘。
		// 为何不留在控件组里：控件组是贴着标题的（`flex: 0 0 auto`），
		// 按钮若在其中就只能跟在「日期」右边，而不是行末。
		// v7.22：按钮状态**跟随下拉框选中的日期**，不再恒等于今天的勾选态。
		//
		// 为什么必须改（旧实现的第二个 bug）：`undo` 传的是 `item.checked` —— 今天的勾选态。
		// 于是「昨天真打了、今天还没打」这个状态根本无法表达：
		//   昨天打完了 → 今天的 checkbox 也被勾上（因为旧代码写的是今天）→ 按钮显示「已打卡」
		//   → 今天想正常打卡时，再点是 **undo**，把刚补的那次记录删掉。
		// 用户原话：「应该我选昨天打一次卡，还能选今天再打卡」—— 做不到的根因就在这一行。
		//
		// 现在的口径：选哪天，就显示哪天打没打；点按钮 = 改那一天。
		// 「今天」这一档是纯同步的（item.checked 就是它的真实状态，不需读盘）；
		// 「昨天」需要在 process 回调里现查目标文件那一行 —— 见 checkInOtherDate。
		const syncBtnToDate = (date: string) => {
			if (date === this.today) {
				applyCheckBtnState(checkBtn, li, item.checked, date, this.today);
				return;
			}
			// 跨天：先给个「未打卡」的常态，再异步校正（读盘几十毫秒，别让按钮闪着假状态等人点）
			applyCheckBtnState(checkBtn, li, false, date, this.today);
			void this.readCheckStateOnDate(date, item, key).then((checked) => {
				// 只在用户还没点、日期没被改回去时校正，避免与并发写盘打架
				if (dateSel.value === date) applyCheckBtnState(checkBtn, li, checked, date, this.today);
			});
		};

		const checkBtn = tail.createEl("button", {
			cls: "planboard-check-btn" + (item.checked ? " is-checked" : ""),
			attr: { title: item.checked ? "取消打卡（勾选与记录一并撤掉）" : "打卡：勾选任务行 + 写入「打卡记录」" },
			text: item.checked ? "✓ 已打卡" : "打卡",
		});
		// tooltip 交给 applyCheckBtnState 统一管（它才知道当前是今天还是补卡）。
		// 别在这里另设一份 —— 真机实测过：另设的那份会被随后的 applyCheckBtnState 覆盖掉。
		dateSel.addEventListener("change", () => syncBtnToDate(dateSel.value));
		// v7.22b：**创建时就按一次**（不是只绑监听）。keepDate 指定补卡后的档位时，
		// 新建的按钮必须直接显示那一档的状态（昨天打过了就该是「✓ 已打卡」），
		// 否则要等用户手动切一次下拉框才纠正 —— 那一瞬看着就是「没生效」。
		syncBtnToDate(initialDate);
		checkBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const date = dateSel.value;
			// undo 判据 = **选中日期**的打卡态，不是今天的。
			// 跨天这一档在点击瞬间必须用刚查到的状态；此刻可能还没查回来（默认 false = 当作没打），
			// 那就按「打卡」处理 —— 对一个真没打过卡的日期，语义正确。
			void this.checkInItem(item, {
				minutes: minutes.value,
				date,
				undo: date === this.today ? item.checked : this.backfilledState.get(`${date}|${key}`) === true,
			});
		});

		return li;
	}

	/**
	 * v7.6：界面显示的标题 = 任务行原文去掉历史遗留的「时长后缀」。
	 * 老笔记行是 `✍️ 写作 1小时`（action 由计划定义预写进标题），
	 * 现在改由「用时」框当场填，标题只留 `✍️ 写作`。
	 *
	 * ⚠️ 只做显示层剥离，**不改笔记原文**；而且打卡记录行也用同一个值当键，
	 * 两处必须走这一个函数，否则记录行的项名会和界面上的标题对不上。
	 */
	private checkDisplayText(item: CheckItem): string {
		const prog = this.planProgress.find((p) => p.plan === item.plan);
		// 标准打卡项名 = 「图标 + 计划名」，新建行就是这个名字（见 buildDefaultCheckItems）
		const canon = prog ? `${prog.label} ${prog.plan}`.trim() : "";

		// ① 精确匹配年度计划里的历史 action —— 能吃掉「复盘+次日计划」这类非时长词
		let t = stripLegacyDuration(item.text, prog?.action ?? "", canon);

		// ② 兜底（v7.6）：自动推导的每日打卡项，标题必为「{图标} {计划名}」，
		//    所以以标准名开头的部分可以硬裁到标准名 + 复盘链接。
		//    为什么要这一条：`action` 已从年度计划 frontmatter 里退役，用户把它删掉之后
		//    ① 就认不出「复盘+次日计划」了（它不含时长单位），后缀会在界面上复活。
		//    影响面很小：只有「daily 计划」且「标题以标准名开头」的行会被裁，
		//    用户自己用「+ 添加」起的名字（如「阅读 30 分钟」）不受影响。
		if (prog?.daily && canon && t.startsWith(canon)) {
			const link = / → \[\[[^\]]*\]\]$/.exec(t)?.[0] ?? "";
			t = canon + link;
		}

		// ③ v7.7（用户 113001 截图）：界面上**不再显示复盘链接尾段** `→ [[2026-10-01 复盘]]`。
		//    它只是笔记行里的一个 wikilink + 设置项「含复盘链接」的产物，在打卡卡里既点不动
		//    又白占一整行宽（复盘项因此被顶成两行）。原文一字不改，纯显示层截断。
		return stripReviewLink(t);
	}

	/** v7.9：打卡「用时」的默认档 —— 上次用过的值，没记录过就是 30。 */
	private defaultCheckMinutes(): number {
		const n = this.plugin.settings.checkMinutes;
		return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), CHECK_MINUTES_MAX) : CHECK_MINUTES_FALLBACK;
	}

	/**
	 * v7.9：把输入框里的内容解析成分钟数。
	 * 认三种写法：`30分`（点档位填进来的）/ `30`（手敲）/ `用时 30 分钟`（从别处粘的），
	 * 抽不出数字（清空了、敲了「半小时」）就退回默认档。
	 * 为什么一定要有兜底：用时现在是打卡的必填项，留空会让记录行只剩
	 * `- 日期 · 项名 · `，日记里多出一个悬空的项目符号。
	 */
	private parseCheckMinutes(raw: string): number {
		const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
		if (!Number.isFinite(n) || n <= 0) return this.defaultCheckMinutes();
		return Math.min(n, CHECK_MINUTES_MAX);
	}

	/**
	 * v7.22：日期可选框 —— **只有今天 / 昨天**（option value = ISO 日期）。
	 *
	 * 为什么砍掉「前天」（v7.5 曾经是 今天/昨天/前天）：
	 *   补卡的口子一旦开大，连击（computeStreak 从昨天往回数、每天必须全勾）就会被
	 *   刷成假的 —— 月初把整月补满，屏幕上会凭空出现一串连击。
	 *   「补昨天」是真实且高频的场景（今天才想起来昨天做了），
	 *   「补前天」大多已经是为了数字好看而补 —— 那种卡不该算数。
	 *   这条边界是刻意的，不是没实现完。
	 */
	private checkDateOptions(): Array<[string, string]> {
		const base = parseDateString(this.today).getTime();
		return [
			["今天", this.today],
			["昨天", formatDate(new Date(base - DAY_MS))],
		];
	}

	/**
	 * v7.8（用户 115512 截图 #1）：「打卡内容」栏下线后，记录行正文只剩用时。
	 *
	 * v7.9：形如 `用时 30 分钟`，**不再有「已打卡」这个退化分支**——
	 * 用时改由 `parseCheckMinutes()` 兜底（默认档），永远不会是空的。
	 */
	private buildLogDetail(minutes: number): string {
		return `用时 ${minutes} 分钟`;
	}

	/**
	 * v7.22 打卡主流程 —— 一次写盘落两件事实：勾选任务行 + 写/删打卡记录。
	 * 已打卡状态再点 = 取消打卡（记录行一并移除）。
	 *
	 * ⚠️ v7.22 真修复（原实现的 bug，v7.5 起就存在）：
	 *   旧代码写盘目标是 `item.file` —— **恒等于今天那篇**，下拉框选的日期只被拼进
	 *   记录行文本里当装饰。于是「选昨天打卡」的真实效果是：
	 *     · 勾勾在**今天**的 checkbox 上（所以「已打卡」立刻变成今天）
	 *     · `2026-10-02.md` 根本没被创建或写入（真库实测：该文件不存在）
	 *     · 记录区多出一行 `- 2026-10-02 · …`，而**统计侧三处（本月柱状图 / 计划打卡率 /
	 *       连续打卡）全都只读「文件所属日期 + checkbox」，从不读这行文本** ⇒ 补卡完全不算数
	 *     · 因为勾在今天，也就没法「昨天打一次、今天再打一次」（第二次点走的是 undo 分支）
	 *   现在改为：**按 input.date 解析目标文件**，勾选与记录都落在那一天。
	 *
	 * 选今天时行为与 v7.5 逐字节一致（走同一条 toggleTaskLine 路径），不引入回归。
	 */
	private async checkInItem(
		item: CheckItem,
		input: { minutes: string; date: string; undo: boolean }
	): Promise<void> {
		if (!this.dailyData) return;
		const minutes = this.parseCheckMinutes(input.minutes);
		// v7.9：本次**实际写进记录行**的用时会成为以后打卡的默认档（回写插件设置）。
		// 取消打卡（undo）不参与回写——那一下并没有真的"用掉"这个时长，
		// 让取消也能改默认的话，点一下取消就把基准改掉了，太脏。
		if (!input.undo && minutes !== this.plugin.settings.checkMinutes) {
			this.plugin.settings.checkMinutes = minutes;
			void this.plugin.saveSettings();
		}
		const detail = this.buildLogDetail(minutes);
		// 记录行的项名 = 界面上的标题（同一函数），两处必须一致，否则取消打卡找不到行
		const key = this.checkDisplayText(item);

		// v7.22：补卡写的是**另一篇**文件，今天的 view 不能拿今天的行号去动它。
		if (input.date !== this.today) {
			await this.checkInOtherDate(item, input.date, key, detail, input.undo);
			return;
		}

		let next = "";
		await this.withSelfWrite(async () => {
			await this.app.vault.process(item.file, (data) => {
				const toggled = toggleTaskLine(data, item.line, !input.undo, item.raw);
				next = input.undo
					? removeCheckLog(toggled, input.date, key)
					: upsertCheckLog(toggled, input.date, key, detail);
				return next;
		});
		});
		if (!next) return;
		this.dailyData = parseDailyContent(item.file, next, this.today);
		this.updateProgress();
		this.updateChecklist();
		this.updateSummary();
		this.refreshHomeChartsAfterChange();
		// v1.1.1：勾卡/取消直接影响连击（≥1 项算一天）——此前只有补卡流程刷新连击，
		// 今日勾完卡 🔥 数字不动（真机闭环实测抓到）。
		void this.updateStreak();
	}

	/**
	 * v7.22：查某一项在**指定日期**那篇日记里是不是已打卡。
	 *
	 * 文件不存在 → false（没打开过插件的那天不可能打过卡）。
	 * 查不到这一项 → false（并清掉缓存里的 true，免得用户取消打卡后又去撤销）。
	 * 命中且已勾 → 写进 backfilledState，供点击时判 undo。
	 *
	 * 定位靠**计划名**而非显示名 —— 界面名已剥掉复盘链接/时长后缀，而目标那篇
	 * 的行可能还带着（单测实测，见 findCheckLineByPlan 注释）。
	 */
	private async readCheckStateOnDate(date: string, item: CheckItem, key: string): Promise<boolean> {
		const root = pfRoot(this.plugin.settings.rootPath);
		// 路径用 date 自己的年份：12-31 补昨天的卡，文件在上一年目录里。
		const file = this.app.vault.getAbstractFileByPath(dailyNotePath(root, date));
		const cacheKey = `${date}|${key}`;
		if (!(file instanceof TFile)) {
			this.backfilledState.delete(cacheKey);
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		const lines = content.split("\n");
		const idx = findCheckLineByPlan(content, item.plan, key);
		if (idx === -1) {
			this.backfilledState.delete(cacheKey);
			return false;
		}
		const checked = /^- \[x\]/.test(lines[idx] ?? "");
		if (checked) this.backfilledState.set(cacheKey, true);
		else this.backfilledState.delete(cacheKey);
		return checked;
	}

	/**
	 * v7.22 补卡：把打卡写到**目标日期**那篇日记去。
	 *
	 * 三件事，顺序不能换：
	 *   ① 目标文件不存在 → 按模板建档（`ensureDateNote`）。用户库里 10-02 就是缺的，
	 *      补卡最常见的场景恰恰是「昨天没开过插件」，不建档就无从写起。
	 *   ② 在目标文件里**按项名**定位那一行（跨文件行号不可用，见 findCheckLineByName 注释）。
	 *      定位不到（昨天那篇没有这一项，比如昨天用的是旧版模板）→ 追加一条，
	 *      否则这次补卡会静默消失，用户只看到「没反应」。
	 *   ③ 勾选 + 记录行都写目标文件。
	 *
	 * 撤销（undo）同样落在目标文件：按项名找到行取消勾 + 删那条记录行。
	 * 找不到行就当无事发生（fail-safe，不误伤别的行）。
	 */
	private async checkInOtherDate(
		item: CheckItem,
		date: string,
		key: string,
		detail: string,
		undo: boolean
	): Promise<void> {
		// 撤销时**先看文件在不在**：不存在就别去建档 —— 为了「撤销昨天」而凭空
		// 创建一篇昨天的日记，比什么都不做更糟（凭空多一个空文件，用户以为补过）。
		if (undo) {
			const root = pfRoot(this.plugin.settings.rootPath);
			const existing = this.app.vault.getAbstractFileByPath(
				dailyNotePath(root, date)
			);
			if (!(existing instanceof TFile)) return; // 那天压根没打过卡，无可撤销
		}

		const file = await this.ensureDateNote(date);
		if (!file) {
			new Notice(`补卡失败：无法创建 ${date} 的日记`);
			return;
		}

		// 追加与勾选必须放进**同一个 process 回调**：分开两次写盘会出现
		// 「追加成功了、勾选那步失败了」的半截状态，而且两次之间若有别处写盘，
		// 行号就漂了。回调里现解析行号（追加会挪行，事前算的索引到时就过期）。
		let wrote = false;
		await this.withSelfWrite(async () => {
			await this.app.vault.process(file, (data) => {
				let idx = findCheckLineByPlan(data, item.plan, key);
				if (idx === -1) {
					if (undo) return data; // 该项那天不存在（老模板/手写笔记）→ 无可撤销
					// 目标那篇没有这一项（昨天用的是另一套模板）→ 先补一条进去，
					// 否则这次补卡会静默消失，用户只看到「点了没反应」。
					data = this.appendCheckLineToDate(data, item, date);
					idx = findCheckLineByPlan(data, item.plan, key);
					if (idx === -1) return data;
				}
				const toggled = setCheckLineChecked(data, idx, !undo);
				const out = undo
					? removeCheckLog(toggled, date, key)
					: upsertCheckLog(toggled, date, key, detail);
				wrote = out !== data;
				return out;
		});
		});
		if (!wrote) {
			new Notice(undo ? "取消失败：那一项当天不存在" : "补卡失败：目标日记里找不到这一项");
			return;
		}
		// 写成功了就把新状态记进缓存：按钮文案不必再读一次盘，撤销判据也同步了。
		if (undo) this.backfilledState.delete(`${date}|${key}`);
		else this.backfilledState.set(`${date}|${key}`, true);
		new Notice(undo ? `已取消 ${date} 的打卡` : `已补卡到 ${date}`);
		// ⚠️ 必须重渲染打卡卡：真机实测漏了这一步 —— 补卡成功后目标那篇确实写对了，
		// 但**按钮文案还停在「打卡」**（li 也没高亮），用户会以为没生效而连点，
		// 第二次就变成撤销。
		//
		// v7.22b：**重绘后要把下拉框按回去**（用户 15:41 反馈：「点了昨日打卡就留在昨日
		// 显示已打卡，不要自动跳转，不然好像打卡没成功」）。`updateChecklist()` 是
		// 整卡 `empty()` 后重建，新建时下拉框回到默认的「今天」—— 那一瞬间按钮显示
		// 「打卡」，用户看着就像**刚才那次白打了**。改回用户选的日期后，按钮立刻
		// 显示「✓ 已打卡」，正反馈才对。
		this.updateChecklist(date);
		// 目标那篇不是今天，**不重解析 dailyData**（今天的界面没变），
		// 但图表口径变了（昨天那天的完成数）→ 必须清缓存重算。
		this.planMonthCache = null;
		this.completionMap = null; // 昨天的柱高变了，今天的图也得跟着重画
		await this.updateStreak();
		this.updateHomeDate();
		void this.updateHomeCharts();
	}

	/**
	 * v7.22：目标日期的日记不存在就按模板建一篇。
	 *
	 * 骨架照抄 autoEnsureTodayNote（那边是「今天缺失时静默建」），差别有三处：
	 *   ① 路径用**目标日期自己的年份**（`date.slice(0,4)`），跨年时不能沿用 `this.today`
	 *      —— 12-31 补昨天的卡，文件该落在上一年目录里；
	 *   ② 建档内容按**目标日期**算窗口（`buildDailyTemplate(date, ...)`），
	 *      否则补出来的行会带今天的 🛫/📅，统计按窗口过滤时会对不上；
	 *   ③ 失败给 Notice（补卡是用户主动动作，静默失败会让人以为没生效），
	 *      成功也给一条确认 —— 补卡发生在别的文件，界面无变化，正反馈是刚需。
	 */
	private async ensureDateNote(date: string): Promise<TFile | null> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const dir = dailyDir(root, date.slice(0, 4));
		const path = `${dir}/${date}.md`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		try {
			await this.ensureFolder(dir);
			const items = await this.buildDefaultCheckItems();
			const created = await this.app.vault.create(path, buildDailyTemplate(date, items));
			return created;
		} catch (e) {
			new Notice(`创建 ${date} 日记失败：${(e as Error).message ?? String(e)}`);
			return null;
		}
	}

	/**
	 * v7.22：目标那篇没有这一项时，补一条进去。
	 *
	 * 什么时候会走到：昨天用的模板与今天不同（期间新增/删过打卡项），
	 * 或那篇是用户手写的、压根没有打卡区。
	 * 窗口用**目标日期**（不是今天）—— 与 ensureDateNote 的建档口径保持一致，
	 * 否则补出来的行会带今天的 🛫/📅，统计按窗口过滤时会对不上。
	 *
	 * 纯函数（吃 content 吐 content，不自己写盘）：它被包在 checkInOtherDate 的
	 * process 回调里，与勾选合成**一次**原子写盘 —— 分两次写会出现「行加上了但
	 * 勾没上」的半截状态，process 的原子性也就白费了。
	 */
	private appendCheckLineToDate(content: string, item: CheckItem, date: string): string {
		const prog = this.planProgress.find((p) => p.plan === item.plan);
		const line = buildCheckLine({
			name: this.checkDisplayText(item),
			plan: item.plan ?? prog?.plan ?? "其他",
			includeReview: false,
			date,
		});
		return appendCheckItem(content, line);
	}

	/**
	 * v3.0: 打卡变动（勾选/新增/删除）后同步首页图表——
	 * 先更新 completionMap 里今天的计数（否则热力图/周柱/趋势吃旧缓存），
	 * 再整体刷新 KPI + 全部图表。激励闭环要求勾完立刻看到数据动。
	 */
	private refreshHomeChartsAfterChange(): void {
		this.planMonthCache = null; // v3.9.4: 打卡变动后本月各计划计数需重算
		if (this.completionMap && this.dailyData) {
			this.completionMap.set(this.today, this.dailyData.checkItems.filter((c) => c.checked).length);
		}
		void this.updateHomeCharts();
	}

	private async moveCheckItem(item: CheckItem, delta: number): Promise<void> {
		if (!this.dailyData) return;
		const newContent = await this.withSelfWrite(() =>
			this.app.vault.process(item.file, (data) => moveTaskLine(data, item.line, delta, item.raw))
		);
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
	}

	private async deleteCheckItem(item: CheckItem): Promise<void> {
		if (!this.dailyData) return;
		const newContent = await this.withSelfWrite(() =>
			this.app.vault.process(item.file, (data) => removeLine(data, item.line, item.raw))
		);
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
		this.refreshHomeChartsAfterChange(); // v3.0 联动
		void this.updateStreak(); // 删掉勾选项可能让今天完成数归零，连击要跟着掉
		this.offerRestoreCheckItem(item);
	}

	/**
	 * v1.0.5: 删除打卡项后 8s 内可撤销。
	 *
	 * 为什么不弹确认：打卡项增删是高频操作，每删一项都要确认会先于人拒绝这个功能；
	 * 门禁真正要求的是「破坏性操作可恢复」——原行内容就在 item.raw 里，
	 * 恢复 = insertLine 插回原下标，成本几乎为零。撤销窗口过了 Notice 自然消失。
	 */
	private offerRestoreCheckItem(item: CheckItem): void {
		const label = this.checkDisplayText(item);
		const frag = createFragment();
		frag.createSpan({ text: `已删除「${label}」 ` });
		const undoBtn = frag.createEl("button", { text: "撤销", cls: "pf-notice-undo" });
		const notice = new Notice(frag, 8000);
		undoBtn.addEventListener("click", () => {
			void (async () => {
				undoBtn.disabled = true; // 防连点造成重复插入
				try {
					await this.withSelfWrite(() =>
						this.app.vault.process(item.file, (data) => insertLine(data, item.line, item.raw))
					);
					const finalContent = await this.app.vault.read(item.file);
					this.dailyData = parseDailyContent(item.file, finalContent, this.today);
					this.updateChecklist();
					this.updateProgress();
					this.updateSummary();
					this.refreshHomeChartsAfterChange();
					notice.hide();
				} finally {
					undoBtn.disabled = false;
				}
			})();
		});
	}

	private async addCheckItem(line: string): Promise<void> {
		if (!this.dailyData) return;
		// v1.0.5.2: 同名防重——连点添加/重复提交会建出多条一模一样的打卡项
		//（真机验证时实测踩到：残留项 + 新增项 = 两条同名行）。同 raw 即同内容同日期，拒绝。
		if (this.dailyData.checkItems.some((c) => c.raw === line)) {
			new Notice("已有相同的打卡项，未重复添加");
			return;
		}
		// 先取出 file：闭包里 TS 的 `this.dailyData` 收窄不跨 await 生效
		const file = this.dailyData.file;
		await this.withSelfWrite(async () => {
			const newContent = await this.app.vault.process(file, (data) => appendCheckItem(data, line));
			this.dailyData = parseDailyContent(file, newContent, this.today);
		});
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
		this.refreshHomeChartsAfterChange(); // v3.0 联动
	}

	// --- Summary -------------------------------------------------------------

	private updateSummary(): void {
		if (!this.dailyData || !this.summaryEl) return;
		// Don't clobber the textarea while the user is typing.
		if (document.activeElement === this.summaryEl) return;
		this.summaryEl.value = this.dailyData.summary;
		this.updateSummaryAuto();
	}

	/**
	 * v1.4: 打卡自动生成区，只读展示不写文件。
	 * v7.11（用户 135859 截图）：💪 鼓励语上移到总结卡标题行（this.summaryCheerEl）。
	 * v7.12（用户 143731 截图）：⬜未完成 整项撤掉；✅已完成 也上移到标题行中间
	 * （this.summaryDoneEl）。所以本方法现在**一行都不往卡片里生成**了 ——
	 * 它只负责更新标题行上那两处文本。
	 * 方法名沿用（3 处调用点，改名是纯噪音）。
	 */
	private updateSummaryAuto(): void {
		if (!this.dailyData) return;
		const checks = this.dailyData.checkItems;
		const done = checks.filter((c) => c.checked);
		const total = checks.length;

		if (this.summaryDoneEl) {
			/* v7.12: 这里**不再**给 ✅ 包一层放大 span。
			   v7.11 那次把它放大到 1.35em 是为了追平旁边「⬜未完成」的墨迹
			   （同字号下 U+2705 比 U+2B1C 小 35%），现在「未完成」整项撤掉，
			   没有要对齐的邻居了；放大反而让这个勾比同行 18px 的标题还抢眼。
			   恢复自然字号 —— 图标与文字同行同基线，最省事也最不容易歪。 */
			this.summaryDoneEl.empty();
			this.summaryDoneEl.createSpan({ cls: "planboard-summary-done-label", text: "✅ 已完成" });
			this.summaryDoneEl.createSpan({ cls: "planboard-summary-done-count", text: `${done.length}/${total}` });
		}

		const pct = total === 0 ? 0 : Math.round((done.length / total) * 100);
		let cheer: string;
		if (total === 0) cheer = "今天还没有打卡项，去添加一个吧";
		else if (pct === 100) cheer = "全勤达成！今天的你闪闪发光";
		else if (pct >= 80) cheer = `已完成 ${pct}%，快完成啦，再坚持一下！`;
		else if (pct >= 50) cheer = `已完成 ${pct}%，势头不错，继续冲！`;
		else if (pct > 0) cheer = `已完成 ${pct}%，加油突破，动起来！`;
		else cheer = "从第一项开始吧"; // v1.1.1 精简（原「今天还没开始打卡哦，从第一项开始吧」鼓励语独占一行后过长）
		// v7.11: 落到总结卡标题行右端（💪 已在 CSS 里用 ::before 画上）
		if (this.summaryCheerEl) this.summaryCheerEl.setText(cheer);
	}

	/** v1.0.5: 保存中标记——blur 可在 await 完成前再次触发，防重复写盘 */
	private summarySaving = false;

	private async saveSummary(): Promise<void> {
		if (!this.dailyData || !this.summaryEl) return;
		if (this.summarySaving) return;
		const value = this.summaryEl.value;
		if (value === this.dailyData.summary) return;
		const file = this.dailyData.file; // 闭包里 TS 收窄不跨 await，提前取出
		this.summarySaving = true;
		try {
			await this.withSelfWrite(() => this.app.vault.process(file, (data) => replaceSummary(data, value)));
		} finally {
			this.summarySaving = false;
		}
		this.dailyData.summary = value;
		new Notice("总结已保存");
	}

	// --- Missing note / creation ---------------------------------------------

	private renderTodayDailyMissing(): void {
		if (!this.panelEl) return;
		if (this.panelEl.querySelector(".planboard-missing-card")) return;
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-missing-card" });
		card.createDiv({ cls: "planboard-card-title", text: "今日笔记不存在" });
		card.createDiv({ cls: "planboard-missing-desc", text: "尚未创建今日笔记，点击下方按钮按模板一键生成。" });
		const btn = card.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "创建今日笔记" });
		btn.addEventListener("click", () => void this.createTodayNote());
	}

	private async autoEnsureTodayNote(): Promise<void> {
		if (this.getTodayFile()) return;
		const root = pfRoot(this.plugin.settings.rootPath);
		const dir = dailyDir(root, this.today.slice(0, 4));
		const path = `${dir}/${this.today}.md`;
		try {
			await this.ensureFolder(dir);
			const items = await this.buildDefaultCheckItems();
			await this.app.vault.create(path, buildDailyTemplate(this.today, items));
			await this.refresh();
		} catch {
			// 静默：重试由第二个定时器兜底
		}
	}

	private async createTodayNote(): Promise<void> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const dir = dailyDir(root, this.today.slice(0, 4));
		const path = `${dir}/${this.today}.md`;
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
			new Notice("今日笔记已存在");
			await this.refreshToday();
			return;
		}
		try {
			await this.ensureFolder(dir);
			const items = await this.buildDefaultCheckItems();
			await this.app.vault.create(path, buildDailyTemplate(this.today, items));
			new Notice("今日笔记已创建");
			await this.refreshToday();
		} catch (e) {
			new Notice(`创建今日笔记失败：${(e as Error).message ?? String(e)}`);
		}
	}

	private async openOrCreateReview(): Promise<void> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const dir = dailyDir(root, this.today.slice(0, 4));
		const path = `${dir}/${this.today} 复盘.md`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		let file: TFile;
		if (existing instanceof TFile) {
			file = existing;
		} else {
			await this.ensureFolder(dir);
			try {
				const template = await this.loadReviewTemplate();
				file = await this.app.vault.create(path, buildReviewTemplate(this.today, template));
				new Notice("复盘笔记已创建");
			} catch (e) {
				new Notice(`创建复盘笔记失败：${(e as Error).message ?? String(e)}`);
				return;
			}
		}
		await this.openFileInEditMode(file);
	}

	/**
	 * v1.2: 复盘模板改为文件化（{rootPath}/复盘模板.md）。
	 * 文件不存在时自动创建——内容优先用设置里已有的自定义模板（迁移），否则用默认模板。
	 */
	private async loadReviewTemplate(): Promise<string> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const filePath = reviewTemplatePath(root);
		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			return await this.app.vault.read(existing);
		}
		// v1.0.3 修复：旧版把「文件路径」误传给建目录函数 ensureFolder，
		// 会在库中创建名为「复盘模板.md」的文件夹，导致 vault.create 永远撞路径报错（iPad 全新安装必现）。
		if (existing instanceof TFolder) {
			if (existing.children.length === 0) {
				// 空文件夹 = 旧 bug 残留，移入 Obsidian 回收站自愈（trashFile 尊重用户删除偏好）
				await this.app.fileManager.trashFile(existing);
			} else {
				new Notice(`「${filePath}」被同名文件夹占用，本次使用内置模板`);
			}
		}
		const content = this.plugin.settings.reviewTemplate;
		try {
			await this.ensureFolder(root);
			await this.app.vault.create(filePath, content);
		} catch (e) {
			// 模板文件写不进去不阻塞复盘：退回内置模板内容（复盘笔记照常生成）
			console.warn("PlanFlow: 复盘模板文件创建失败，使用内置模板", e);
		}
		return content;
	}

	private async openFileInEditMode(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		// DEV.md 踩坑记录 #2: openFile inherits preview mode — force edit mode.
		const view = leaf.view;
		if (view instanceof MarkdownView && view.getMode() === "preview") {
			// toggleMode() exists at runtime in 1.13.x but is missing from the 1.5.x typings (DEV.md #1).
			(view as unknown as { toggleMode(): void }).toggleMode();
		}
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const parts = folderPath.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(cur);
			if (existing instanceof TFolder) continue;
			if (existing) {
				new Notice(`路径冲突：${cur}`);
				return;
			}
			await this.app.vault.createFolder(cur);
		}
	}

	// --- Add item modal -------------------------------------------------------

	private async openAddItemModal(): Promise<void> {
		// v7.20: ①today 打开弹窗时现取（视图的 this.today 只在构造时取一次，隔天不刷新，
		// 弹窗默认日期会停在旧日期——用户 1958 实测「不是今天」）；②计划下拉列真实计划
		//（原先只有 4 个内置名，选了不在年度计划里的名 → 打卡统计对不上号）。
		const root = pfRoot(this.plugin.settings.rootPath);
		const defs = (await this.readAnnualPlanDefs(root, todayStr().slice(0, 4))) ?? [];
		const options = Array.from(new Set([...defs.map((d) => d.name), ...Object.keys(DEFAULT_PLAN_COLORS)]));
		new AddCheckItemModal(this.app, this.plugin, todayStr(), options, (line) => void this.addCheckItem(line)).open();
	}

	/**
	 * v1.0.5.2: 打卡项管理弹窗（计划管理页入口）——按计划过滤今日打卡项，
	 * 列表逐项删 + 添加表单。今日打卡卡只留打卡与顺序微调（行内 ✕ 已移除）。
	 */
	private openCheckItemManager(plan: string): void {
		// 自动项名单：buildDefaultCheckItems 生成的「daily 型计划/目标」当日项——不可删除。
		// 匹配口径 = item.text 精确等于模板 name（自动项当天才生成，今日笔记里的即当日窗口项）。
		void this.buildDefaultCheckItems().then((templates) => {
			const autoNames = new Set(templates.map((t) => t.name));
			new CheckItemManageModal(this.app, {
				plan,
				today: this.today,
				getItems: () => (this.dailyData?.checkItems ?? []).filter((c) => c.plan === plan),
				isAuto: (item) => autoNames.has(item.text),
				onAdd: (line) => this.addCheckItem(line),
				onDeleteItem: (item) => this.deleteCheckItem(item),
				onEditItem: (item, name, start, due) => this.editCheckItem(item, name, start, due),
			}).open();
		});
	}

	/** v1.0.5.2: 编辑手动打卡项（名称/起止窗口）——checkbox 状态与 #计划/ 标签原样保留。 */
	private async editCheckItem(item: CheckItem, newName: string, start: string | null, due: string | null): Promise<void> {
		if (!this.dailyData) return;
		const checked = item.raw.startsWith("- [x]");
		const newLine = `- [${checked ? "x" : " "}] ${newName} #计划/${item.plan} 🛫 ${start ?? this.today} 📅 ${due ?? this.today}`;
		const file = this.dailyData.file;
		await this.withSelfWrite(() =>
			this.app.vault.process(file, (data) => replaceLine(data, item.line, item.raw, newLine))
		);
		const content = await this.app.vault.read(file);
		this.dailyData = parseDailyContent(file, content, this.today);
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
		this.refreshHomeChartsAfterChange();
	}

	/** v1.0.5.2: 清空某计划今日全部打卡项（计划管理页 🗑️，danger 确认）。
	 *  一次 process 按 raw 全文精确匹配删行——行号在连续删除中会漂移，
	 *  按内容匹配不受影响；同名多条一起删即"清空"语义。 */
	private async clearTodayCheckItems(plan: string): Promise<void> {
		const items = (this.dailyData?.checkItems ?? []).filter((c) => c.plan === plan);
		if (items.length === 0) {
			new Notice(`「${plan}」今天还没有打卡项`);
			return;
		}
		if (!await confirmDialog(this.app, `清空「${plan}」今天全部 ${items.length} 项打卡？`, { danger: true })) return;
		const file = this.dailyData!.file; // TS 收窄不跨 await，提前取出
		const raws = new Set(items.map((i) => i.raw));
		await this.withSelfWrite(() =>
			this.app.vault.process(file, (data) => data.split("\n").filter((l) => !raws.has(l)).join("\n"))
		);
		const content = await this.app.vault.read(file);
		this.dailyData = parseDailyContent(file, content, this.today);
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
		this.refreshHomeChartsAfterChange();
		new Notice(`已清空「${plan}」今日打卡 ${items.length} 项`);
	}

	// -------------------------------------------------------------------------
	// Task pool（M2；v7.18 只读化——编辑/删除/新建弹窗全部退役，见 renderTaskItem）
	// -------------------------------------------------------------------------

	private async togglePoolTask(task: PoolTask, checked: boolean): Promise<void> {
		await this.withSelfWrite(async () => {
			await toggleTask(this.app, task, checked);
		});
		await this.refresh();
	}

	/** v1.0.4: 清掉匹配前缀的自动任务墓碑（目标重建/删除后，原墓碑不再有意义）。 */
	private clearAutoTombstones(prefix: string): void {
		const before = this.plugin.settings.deletedAutoTasks?.length ?? 0;
		this.plugin.settings.deletedAutoTasks = (this.plugin.settings.deletedAutoTasks ?? []).filter((n) => !n.startsWith(prefix));
		if (this.plugin.settings.deletedAutoTasks.length !== before) void this.plugin.saveSettings();
	}

	/**
	 * Render one pool task row. Checkbox toggles it back to the pool;
	 * clicking the text opens the edit modal; ✕ deletes it.
	 */
	/** v1.7.3: 看板列（大类卡片）拖拽排序——水平 1D 重排 + 松手持久化 boardColumnOrder。 */
	private attachColSort(board: HTMLElement, col: HTMLElement, plan: string): void {
		const header = col.querySelector(".planboard-board-col-header") as HTMLElement;
		if (!header) return;
		let dragging = false;
		let moved = false;
		let grabX = 0;
		let startX = 0;
		let startY = 0;
		let offsetX = 0;
		let lastKey = "";
		let lastMoveT = 0;
		const logicRects = new Map<HTMLElement, DOMRect>();
		const rectOf = (el: HTMLElement): DOMRect => logicRects.get(el) ?? el.getBoundingClientRect();
		// v1.7.3 修复：layoutOf 用实时 rect（含 transform）——重排前后取真实视觉位置，offsetX 补偿才正确
		const layoutOf = (el: HTMLElement): { left: number; top: number } => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top };
		};
		const flipOthers = (): void => {
			Array.from(board.children).forEach((c) => {
				const el = c as HTMLElement;
				if (el === col) return;
				const oldR = logicRects.get(el);
				const newR = el.getBoundingClientRect();
				if (!oldR) return;
				const dx = oldR.left - newR.left;
				const dy = oldR.top - newR.top;
				if (dx !== 0 || dy !== 0) {
					el.addClass("planflow-flip-none");
					el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
					void el.offsetWidth;
					el.removeClass("planflow-flip-none");
					el.style.removeProperty("transform");
				}
				logicRects.set(el, newR);
			});
		};
		// v1.7.4: 列拖拽改回"宽度重叠判定"（用户拍板——鼠标位置判定受抓取点偏移影响，手感不统一）。
		// 用被拖列视觉 rect（含 transform）与目标列求水平宽度重叠：重叠比例 ≥ 1/3 即判定，与抓取偏移无关。
		const computeRef = (): { target: HTMLElement; mode: "before" | "after" | "end" } | null => {
			const others = Array.from(board.children).filter((c) => c !== col) as HTMLElement[];
			const dr = col.getBoundingClientRect(); // 被拖列视觉 rect（含 transform = 当前跟手位置）
			const dcx = dr.left + dr.width / 2;
			const drW = dr.width;
			// 0. 末尾检测：被拖列中心在所有列最大右缘 +8 之外 → append
			const maxRight = others.reduce((m, o) => Math.max(m, rectOf(o).right), -Infinity);
			if (others.length > 0 && dcx > maxRight + 8) {
				return { target: others[others.length - 1], mode: "end" };
			}
			// 1. 水平宽度重叠比例 ≥ 1/3 的最大列（分母 = 双方较小宽度 → 列宽差距不影响触发）
			let best: HTMLElement | null = null;
			let bestRatio = 0;
			for (const o of others) {
				const r = rectOf(o);
				const w = Math.min(dr.right, r.right) - Math.max(dr.left, r.left);
				if (w <= 0) continue;
				const ratio = w / Math.min(drW, r.width);
				if (ratio > bestRatio) {
					bestRatio = ratio;
					best = o;
				}
			}
			if (best && bestRatio >= 0.34) {
				const r = rectOf(best);
				// 方向：被拖列中心在目标列中心左侧 → before；右侧 → after（与抓取点无关）
				const ncx = r.left + r.width / 2;
				return dcx < ncx ? { target: best, mode: "before" } : { target: best, mode: "after" };
			}
			return null;
		};
		const onMove = (ev: PointerEvent): void => {
			if (!dragging) return;
			if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
			moved = true;
			const now = Date.now();
			if (now - lastMoveT < 16) return;
			lastMoveT = now;
			const dx = ev.clientX - grabX + offsetX;
			col.style.transform = `translate3d(${dx}px, 0, 0)`;
			const res = computeRef();
			if (res && res.target !== col) {
				const key = res.mode + ":" + (res.target.getAttribute("data-plan") ?? "");
				if (key !== lastKey) {
					lastKey = key;
					const oldL = layoutOf(col);
					if (res.mode === "end") board.appendChild(col);
					else if (res.mode === "after") board.insertBefore(col, res.target.nextElementSibling);
					else board.insertBefore(col, res.target);
					const newL = layoutOf(col);
					offsetX += oldL.left - newL.left;
					col.style.transform = `translate3d(${ev.clientX - grabX + offsetX}px, 0, 0)`;
					flipOthers();
				}
			}
		};
		const finish = (ev?: PointerEvent): void => {
			if (!dragging) return;
			dragging = false;
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", finish, true);
			window.removeEventListener("pointercancel", finish, true);
			if (ev) ev.preventDefault();
			if (moved) {
				col.removeClass("planflow-flip-none");
				col.addClass("planflow-flip-fast");
				col.style.removeProperty("transform");
				window.setTimeout(() => {
					col.removeClass("planflow-flip-fast");
				}, 160);
				// 持久化列顺序
				const order = Array.from(board.children).map((c) => (c as HTMLElement).getAttribute("data-plan") || "其他");
				this.plugin.settings.boardColumnOrder = order;
				void this.plugin.saveSettings();
			}
			col.removeClass("is-col-dragging");
		};
		const onCapture = (e: PointerEvent): void => {
			if (!col.isConnected) {
				window.removeEventListener("pointerdown", onCapture, true);
				return;
			}
			const t = e.target as HTMLElement;
			if (t.closest("button, input, textarea")) return;
			if (!e.composedPath().includes(header)) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			dragging = true;
			moved = false;
			lastKey = "";
			offsetX = 0;
			grabX = e.clientX;
			startX = e.clientX;
			startY = e.clientY;
			Array.from(board.children).forEach((c) => logicRects.set(c as HTMLElement, (c as HTMLElement).getBoundingClientRect()));
			col.addClass("is-col-dragging");
			window.addEventListener("pointermove", onMove, true);
			window.addEventListener("pointerup", finish, true);
			window.addEventListener("pointercancel", finish, true);
		};
		window.addEventListener("pointerdown", onCapture, true);
	}

	private renderTaskItem(task: PoolTask): HTMLElement {
		const li = createEl("li", { cls: "planboard-check-item planboard-pool-item" + (task.checked ? " is-checked" : "") });
		li.setAttribute("data-line", String(task.line));

		const label = li.createEl("label", { cls: "planboard-check-label" });
		const cb = label.createEl("input", { type: "checkbox", cls: "planboard-checkbox" });
		cb.checked = task.checked;
		cb.addEventListener("change", () => void this.togglePoolTask(task, cb.checked));
		label.createSpan({ cls: "planboard-check-text", text: task.text });
		// v1.7.3: 标签 + 起止日期合并到第二行（meta 行）——标题第一行完整显示，不再被标签挤换行
		const meta = li.createDiv({ cls: "planboard-task-meta" });
		if (task.plan) {
			const tag = meta.createSpan({ cls: "planboard-plan-tag", text: task.plan });
			tag.setAttribute("data-plan", task.plan);
			this.applyPlanColor(tag, task.plan);
			// v7.13（用户 150250 截图）：这里原本还 `label.prepend(dot)` 挂一颗 8px 色点
			// （v6.8 #2 为解决「色点与勾选框不同轴」而改的真元素）。色点整体取消后删除 ——
			// 它和上面的 plan-tag 药丸表达的是同一件事，药丸保留、色点退场。
		}
		const dates: string[] = [];
		if (task.start) dates.push(`🛫 ${task.start}`);
		if (task.due) dates.push(`📅 ${task.due}`);
		if (dates.length > 0) {
			meta.createSpan({ cls: "planboard-task-dates", text: dates.join("  ") });
		}
		// v7.18: 任务只读化——编辑/删除入口整体撤除（✏️/✕ 按钮与「点文字开编辑弹窗」）。
		// 任务是量化目标分解的产物（v1.2），手改名字会切断与目标的进度联动、手删会留墓碑
		// 永久压缩配额——都是数据源分裂的源头。唯一数据源 = 计划页（编辑目标自动重建任务），
		// 这里只保留勾选（进度数据就来自勾选）。TaskModal / openTaskModal / saveTask /
		// deletePoolTask 随之退役删除。

		return li;
	}

	// -------------------------------------------------------------------------
	// Board view (M3 + v1.3): category columns (all plans) or status columns
	// -------------------------------------------------------------------------

	private async renderBoardPanel(): Promise<void> {
		if (!this.panelEl) return;
		const panel = this.panelEl;
		panel.empty();
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		// v6.5: banner 常驻——本页也要给出年度目标条的数据（打卡率复用缓存）
		this.planProgress = await this.computeBannerProgress(root, tasks);

		// v6.6: 标题交给「任务看板」标签；一排三档（分类|状态|甘特）由
		// renderTaskModePills 统一渲染，本页不再单独排第二行。
		const pillRow = this.renderTaskModePills(panel);
		pillRow.createSpan({
			cls: "planboard-page-count",
			text: `${year} · ${this.taskMode === "category" ? "按计划分组" : "按状态分组"} · 共 ${tasks.length} 个任务`,
		});

		if (this.taskMode === "category") {
			await this.renderBoardCategory(panel, tasks);
		} else {
			this.renderBoardStatus(panel, tasks);
		}
	}

	/**
	 * Category columns: every annual-plan category (even zero-task ones), plus a
	 * "其他" column for unplanned tasks. Empty columns show a "暂无任务" state.
	 */
	private async renderBoardCategory(panel: HTMLElement, tasks: PoolTask[]): Promise<void> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const defs = (await this.readAnnualPlanDefs(root, year)) ?? [];

		// Group by plan (unplanned tasks → "其他").
		const groups = new Map<string, PoolTask[]>();
		for (const t of tasks) {
			const key = t.plan ?? "其他";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(t);
		}

		// Column order: annual plan categories first (empty ones included), then
		// any task plans not defined in the annual note, then "其他".
		const columns: string[] = [];
		const seen = new Set<string>();
		for (const def of defs) {
			columns.push(def.name);
			seen.add(def.name);
		}
		for (const [plan] of groups) {
			if (plan !== "其他" && !seen.has(plan)) {
				seen.add(plan);
				columns.push(plan);
			}
		}
		if (groups.has("其他")) columns.push("其他");

		// v1.7.3: 用户拖拽过的列顺序（boardColumnOrder）优先；新列追加尾部
		if (this.plugin.settings.boardColumnOrder.length > 0) {
			const known = new Set<string>(columns);
			const ordered = this.plugin.settings.boardColumnOrder.filter((c) => known.has(c));
			for (const c of columns) if (!ordered.includes(c)) ordered.push(c);
			columns.length = 0;
			columns.push(...ordered);
		}

		// 计划名显示：有 icon 时 "✍️ 写作"，否则用原始名。
		const displayByName = new Map<string, string>();
		for (const def of defs) {
			displayByName.set(def.name, def.label ? `${def.label} ${def.name}` : def.name);
		}

		if (columns.length === 0) {
			panel.createDiv({ cls: "planboard-empty", text: "任务池为空 · 在计划页给计划添加量化目标后自动分解" });
			return;
		}

		const board = panel.createDiv({ cls: "planboard-board" });
		for (const plan of columns) {
			const list = groups.get(plan) ?? [];
			const done = list.filter((t) => t.checked).length;
			const col = board.createDiv({ cls: "planboard-board-col" });
			col.setAttribute("data-plan", plan === "其他" ? "" : plan); // v1.7.2: 跨列写回用
			this.applyPlanColor(col, plan === "其他" ? undefined : plan);
			const colHeader = col.createDiv({ cls: "planboard-board-col-header" });
			colHeader.createDiv({ cls: "planboard-board-col-title", text: displayByName.get(plan) ?? plan });
			colHeader.createDiv({ cls: "planboard-board-col-count", text: `${done}/${list.length}` });
			// v1.7.3: 列头拖拽排序（大类卡片拖动——水平 1D 重排 + 持久化 boardColumnOrder）
			this.attachColSort(board, col, plan);
			// Unfinished first (by due/start), finished sink to bottom.
			const sorted = [...list].sort((a, b) => {
				if (a.checked !== b.checked) return a.checked ? 1 : -1;
				return (a.due ?? a.start ?? "").localeCompare(b.due ?? b.start ?? "");
			});
			if (sorted.length === 0) {
				col.createDiv({ cls: "planboard-empty", text: "暂无任务" });
			}
			for (const t of sorted) {
				col.appendChild(this.renderTaskItem(t));
			}
		}
	}

	/** Status columns (spec v1.3): 📋 未开始 / 🔥 进行中 / ✅ 已完成. */
	private renderBoardStatus(panel: HTMLElement, tasks: PoolTask[]): void {
		const cols: Array<{ key: "todo" | "doing" | "done"; label: string }> = [
			{ key: "todo", label: "📋 未开始" },
			{ key: "doing", label: "🔥 进行中" },
			{ key: "done", label: "✅ 已完成" },
		];
		const board = panel.createDiv({ cls: "planboard-board" });
		for (const c of cols) {
			const list = tasks.filter((t) => taskStatus(t, this.today) === c.key);
			const col = board.createDiv({ cls: `planboard-board-col planboard-board-col-status-${c.key}` });
			const colHeader = col.createDiv({ cls: "planboard-board-col-header" });
			colHeader.createDiv({ cls: "planboard-board-col-title", text: c.label });
			colHeader.createDiv({ cls: "planboard-board-col-count", text: String(list.length) });
			// Unfinished first (by due/start), finished sink to bottom.
			const sorted = [...list].sort((a, b) => {
				if (a.checked !== b.checked) return a.checked ? 1 : -1;
				return (a.due ?? a.start ?? "").localeCompare(b.due ?? b.start ?? "");
			});
			if (sorted.length === 0) {
				col.createDiv({ cls: "planboard-empty", text: "暂无任务" });
			}
			for (const t of sorted) {
				col.appendChild(this.renderTaskItem(t));
			}
		}
	}

	// -------------------------------------------------------------------------
	// Gantt view (M3 + v1.3): week / month / year sub-modes, task bars with handles
	// -------------------------------------------------------------------------

	private async renderGanttPanel(): Promise<void> {
		if (!this.panelEl) return;
		const panel = this.panelEl;
		panel.empty();
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		// v6.5: banner 常驻——本页也要给出年度目标条的数据（打卡率复用缓存）
		this.planProgress = await this.computeBannerProgress(root, tasks);

		// v6.6: 计数并入同一行三档切换的右侧（与看板页结构一致）
		const pillRow = this.renderTaskModePills(panel);
		pillRow.createSpan({
			cls: "planboard-page-count",
			// v7.0（#4）：「任务时间条」已上移成卡片标题，这里只留年份与计数，
			// 与另外两档（按计划分组 / 按状态分组）的行尾格式对齐。
			text: `${year} · 共 ${tasks.length} 个任务`,
		});

		// v1.0.4: 周/月子视图移除（用户确认甘特只看年维度），直接渲染年视图
		this.renderGanttYear(panel, tasks);
	}

	/** A task's effective window (🛫 ~ 📅); at least one date is guaranteed. */
	private taskWindow(t: PoolTask): { start: string; end: string } {
		return { start: t.start ?? t.due!, end: t.due ?? t.start! };
	}

	/**
	 * Intersect a task's window with [start, end] and map it onto a 1..N axis
	 * via `unit` (day index within the year). This is
	 * the cross-window clamp Hermes' drag code depends on.
	 */
	private ganttBarRange(
		t: PoolTask,
		start: string,
		end: string,
		unit: (d: string) => number
	): { s: number; e: number } {
		const w = this.taskWindow(t);
		const isStart = w.start < start ? start : w.start;
		const isEnd = w.end > end ? end : w.end;
		const s = unit(isStart);
		const e = unit(isEnd);
		// Intersecting windows always satisfy s <= e; guard defensively.
		return { s: Math.min(s, e), e: Math.max(s, e) };
	}

	/**
	 * Render one task bar with drag handles (v1.3). Hermes' drag.ts reads the
	 * data-* attributes and left/width to recompute dates — keep this DOM exact.
	 */
	private renderGanttBar(
		track: HTMLElement,
		t: PoolTask,
		s: number,
		e: number,
		n: number,
		todayIdx: number,
	): void {
		// v6.9（#4）：条不再用「半透明 + 划线」表示完成（旧 is-done 是 opacity .5
		// 加一道白色横线，看着像被划掉），改成低饱和的四态填充：
		//   已完成     实心，整条铺满
		//   进行中     左半段实心（到今天）+ 右半段浅底
		//   逾期未完成 实心 + 虚线边（窗口已过但没勾，最需要一眼看见）
		//   未开始     整条浅卡其实心（v7.14：虚线框退役；纯卡其=未开始，
		//              彩色头+卡其尾=进行中，与「进行中」的未来段同色）
		const w = this.taskWindow(t);
		const state: "done" | "doing" | "overdue" | "todo" = t.checked
			? "done"
			: this.today < w.start
				? "todo"
				: this.today <= w.end
					? "doing"
					: "overdue";
		const span = Math.max(e - s + 1, 1);
		const elapsed = Math.max(0, Math.min(span, todayIdx - s + 1));
		const ratio = state === "todo" ? 0 : state === "doing" ? elapsed / span : 1;

		const bar = track.createDiv({ cls: `planboard-gantt-bar is-${state}` });
		if (t.plan) {
			// v7.1（#2）：条不再吃计划色——所有任务共用一套状态色板（参考图单色系），
			// 计划的区分交给左侧任务名文字色；data-plan 留作信息。
			bar.setAttribute("data-plan", t.plan);
		}
		bar.setAttribute("data-line", String(t.line));
		bar.setAttribute("data-start", t.start ?? "");
		bar.setAttribute("data-due", t.due ?? "");
		bar.setAttribute("data-axis", "year"); // v1.0.4: 甘特只保留年视图
		bar.setAttribute("data-state", state);
		bar.style.left = `${((s - 1) / n) * 100}%`;
		bar.style.width = `${Math.max((span / n) * 100, 1.2)}%`;
		// 已走过的部分：铺在条内的实心段。v7.1（#3）：拖拽与两端把手取消——
		// 在甘特上拖日期与清单/编辑弹窗是两套心智，这里改纯展示。
		const fill = bar.createDiv({ cls: "planboard-gantt-bar-fill" });
		fill.style.width = `${Math.round(ratio * 1000) / 10}%`;
		const stateText =
			state === "done"
				? "已完成"
				: state === "overdue"
					? "逾期未完成"
					: state === "doing"
						? `进行中 ${Math.round(ratio * 100)}%`
						: "未开始";
		bar.setAttribute("title", `${t.text} · ${stateText}`);
	}

	/** Shared "🗂️ 未排期任务" card below the chart. */
	private renderUnscheduled(panel: HTMLElement, tasks: PoolTask[]): void {
		if (tasks.length === 0) return;
		const uCard = panel.createDiv({ cls: "planboard-card" });
		const uHeader = uCard.createDiv({ cls: "planboard-card-header" });
		uHeader.createDiv({ cls: "planboard-card-title", text: "🗂️ 未排期任务" });
		for (const t of tasks) uCard.appendChild(this.renderTaskItem(t));
	}

	/** Year axis: 1月~12月 (12 cells), bars positioned by day index (v1.5), current month highlighted. */
	private renderGanttYear(panel: HTMLElement, tasks: PoolTask[]): void {
		const year = this.today.slice(0, 4);
		const yearStart = `${year}-01-01`;
		const yearEnd = `${year}-12-31`;
		const todayMonth = Number(this.today.slice(5, 7));
		// v1.5: 全年天数（条/今日线的天粒度坐标系分母）
		const totalDays = Math.round((parseDateString(yearEnd).getTime() - parseDateString(yearStart).getTime()) / DAY_MS) + 1;
		const inWindow = filterTasksInRange(tasks, yearStart, yearEnd);
		const unscheduled = tasks.filter((t) => !t.start && !t.due);
		// v6.9（#4）：四态条要拿"今天在第几天"切进行中的实心段
		const todayIdx = dayIndexOf(this.today, yearStart);

		// v7.0（#4）：甘特原来直接铺在页面上、没有卡面。加了浅蓝内容画布之后
		// 它就成了"没穿衣服"的一块；参考图里图表都住在白卡里，这里补上卡面 + 标题，
		// 与其它页的卡片读法一致（下面 renderUnscheduled 本来就自带卡面）。
		const ganttCard = panel.createDiv({ cls: "planboard-card planboard-gantt-card" });
		ganttCard.createDiv({ cls: "planboard-card-title", text: "📈 全年任务时间条" });
		const chart = ganttCard.createDiv({ cls: "planboard-gantt" });

		const axisRow = chart.createDiv({ cls: "planboard-gantt-axis" });
		for (let m = 1; m <= 12; m++) {
			const cell = axisRow.createDiv({
				cls: "planboard-gantt-axis-cell" + (m === todayMonth ? " is-today" : ""),
				text: `${m}月`,
			});
			cell.style.width = `${100 / 12}%`;
		}

		if (inWindow.length === 0) {
			chart.createDiv({ cls: "planboard-empty", text: "本年没有带日期的任务" });
		}
		for (const t of inWindow) {
			const row = chart.createDiv({ cls: "planboard-gantt-row" });
			const label = row.createDiv({ cls: "planboard-gantt-label", text: t.text.slice(0, 14), attr: { title: t.text } });
			if (t.plan) {
				label.setAttribute("data-plan", t.plan);
				// v7.1（#2）：计划区分搬到任务名文字色（浅色加深档 / 深色柔化档）。
				this.applyPlanColor(label, t.plan);
			}
			const track = row.createDiv({ cls: "planboard-gantt-track" });

			const todayMark = track.createDiv({ cls: "planboard-gantt-today" });
			// v1.5: 今日线按天索引定位（与条同坐标系）
			todayMark.style.left = `${((dayIndexOf(this.today, yearStart) - 1) / totalDays) * 100}%`;

			// v1.5: 年视图条用天粒度（轴仍为 12 月格）——首尾相接的跨度任务不再重叠
			const { s, e } = this.ganttBarRange(t, yearStart, yearEnd, (d) => dayIndexOf(d, yearStart));
			this.renderGanttBar(track, t, s, e, totalDays, todayIdx);
		}

		// v6.9（#4）：图例——四态靠"填充样式"区分，不给图例读不出来。
		// 色块用中性灰（不跟计划色混）：颜色在这里表达"状态"，不是"哪个计划"。
		const legend = chart.createDiv({ cls: "planboard-gantt-legend" });
		for (const it of [
			{ cls: "is-done", label: "已完成" },
			{ cls: "is-doing", label: "进行中" },
			{ cls: "is-overdue", label: "逾期未完成" },
			{ cls: "is-todo", label: "未开始" },
			{ cls: "is-today", label: "今天" },
		]) {
			const item = legend.createDiv({ cls: "planboard-gantt-legend-item" });
			item.createDiv({ cls: `planboard-gantt-legend-swatch ${it.cls}` });
			item.createSpan({ text: it.label });
		}

		this.renderUnscheduled(panel, unscheduled);
	}

	// -------------------------------------------------------------------------
	// Period panels (week / month / year)
	// -------------------------------------------------------------------------

	/**
	 * v3.9.9: 回顾页 = 年度总结页（周/月粒度视图取消）。
	 * 周/月徽章结算仍自动执行（幂等），徽章查看入口合并进年视图的徽章墙汇总行。
	 */
	private async refreshReview(): Promise<void> {
		this.panelEl?.empty();
		this.currentPanel = "review";
		const root = this.plugin.settings.rootPath;
		const rw = this.plugin.settings.reviewWorkdays;
		const yearStats = await computePeriodStats(this.app, root, this.today, "year", rw);
		const weekStats = await computePeriodStats(this.app, root, this.today, "week", rw);
		const monthStats = await computePeriodStats(this.app, root, this.today, "month", rw);
		await this.settleIfNeeded(weekStats);
		await this.settleIfNeeded(monthStats);
		if (!this.panelEl) return;
		// v6.5: banner 常驻——本页顺手喂它数据（复用已算出的年度统计，不重算）
		this.planProgress = yearStats.planProgress;
		this.planRates = yearStats.planRates;
		await this.renderYearReviewPanel(this.panelEl, yearStats, { weekStats, monthStats });
	}

	/**
	 * 周/月徽章结算（reward v3）：只在有任务数据时结算，成就.md 仅由
	 * settleWeek/settleMonth 写入（幂等，该周期已记录不重复写）。
	 */
	private async settleIfNeeded(stats: PeriodStats): Promise<void> {
		if (stats.type !== "week" && stats.type !== "month") return;
		if (stats.taskDone <= 0 || stats.taskTotal <= 0) return;
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = stats.label.slice(0, 4);
		await this.withSelfWrite(async () => {
			if (stats.type === "week") {
				await settleWeek(this.app, root, year, stats.label, stats.taskDone, stats.taskTotal);
				// 周打卡完成率（习惯维度）：各计划打卡 Σdone/Σtotal
				const sum = stats.planRates.reduce(
					(acc, r) => ({ done: acc.done + r.done, total: acc.total + r.total }),
					{ done: 0, total: 0 }
				);
				if (sum.total > 0 && sum.done > 0) {
					await settleWeekCheckin(this.app, root, year, stats.label, sum.done, sum.total);
				}
			} else {
				await settleMonth(this.app, root, year, stats.label, stats.taskDone, stats.taskTotal);
				// 月打卡完成率（习惯维度）：各计划打卡 Σdone/Σtotal
				const sum = stats.planRates.reduce(
					(acc, r) => ({ done: acc.done + r.done, total: acc.total + r.total }),
					{ done: 0, total: 0 }
				);
				if (sum.total > 0 && sum.done > 0) {
					await settleMonthCheckin(this.app, root, year, stats.label, sum.done, sum.total);
				}
			}
		});
		// 结算写了周/月笔记 → 本次算出的 stats 已不是最新（settle 后的完成数变了）。
		// 不清的话：紧接着 renderYearReviewPanel 若复用缓存，就会显示结算前的旧数字。
		invalidateStatsCache(this.app);
	}

	/** v6.6: 任务页形态切换 —— 一排三档（分类|状态|甘特）。
	 *  取代原先「看板|甘特」+「分类|状态」两排标签。 */
	private renderTaskModePills(panel: HTMLElement): HTMLElement {
		const sub = panel.createDiv({ cls: "planboard-subtabs" });
		// v6.9（#3）：三档加一条共同底框（segmented）——底框只包三个按钮，
		// 行尾的「共 N 个任务」由调用方 append 到 sub 上，留在底框外面。
		const track = sub.createDiv({ cls: "planboard-subtab-track" });
		const items: Array<{ key: "category" | "status" | "gantt"; label: string }> = [
			{ key: "category", label: "分类" },
			{ key: "status", label: "状态" },
			{ key: "gantt", label: "甘特" },
		];
		for (const it of items) {
			const btn = track.createEl("button", {
				cls: "planboard-subtab" + (this.taskMode === it.key ? " is-active" : ""),
				text: it.label,
			});
			btn.addEventListener("click", () => {
				if (this.taskMode === it.key) return;
				this.taskMode = it.key;
				void this.refresh();
			});
		}
		return sub; // v6.5: 调用方在行尾挂"共 N 个任务"
	}

	/** 回顾·年粒度 = 年度统计（徽章墙 + 年度任务完成 + 打卡率）。
	 *  计划卡管理（新增/编辑/目标/拖拽）已移入「计划」页 refreshPlans（v2.9）。 */
	private async renderYearReviewPanel(
		panel: HTMLElement,
		stats: PeriodStats,
		periods: { weekStats: PeriodStats; monthStats: PeriodStats },
	): Promise<void> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const counts = await badgeCounts(this.app, root, stats.label);
		const totalBadges = counts.gold + counts.silver + counts.bronze;
		// v3.9.9: 周期徽章汇总（周/月视图取消后的查看入口）
		const weekBadges = await readPeriodBadges(this.app, root, periods.weekStats.label.slice(0, 4), periods.weekStats.label);
		const monthBadges = await readMonthBadges(this.app, root, periods.monthStats.label.slice(0, 4), periods.monthStats.label);
		// v6.5: 撤销 v6.1 的页头——标题已由「我的成就」标签承担，banner 不再随页换内容
		{
			const wall = panel.createDiv({ cls: "planboard-card planboard-period-wall" });
			const wallHeader = wall.createDiv({ cls: "planboard-card-header" });
			wallHeader.createDiv({ cls: "planboard-card-title", text: "🏆 徽章墙" });
			const summary = wallHeader.createSpan({ cls: "planboard-chart-meta" });
			summary.textContent = `本周 ${weekBadges.length} · 本月 ${monthBadges.length} · 全年累计 ${totalBadges} 枚`;
			if (totalBadges > 0) {
				const row = wall.createDiv({ cls: "planboard-period-wall-row" });
				if (counts.gold > 0) {
					const b = row.createSpan({ cls: "planboard-badge is-gold" });
					setBadgeContent(b, "🥇", `完美 ×${counts.gold}`);
				}
				if (counts.silver > 0) {
					const b = row.createSpan({ cls: "planboard-badge is-silver" });
					setBadgeContent(b, "🥈", `优秀 ×${counts.silver}`);
				}
				if (counts.bronze > 0) {
					const b = row.createSpan({ cls: "planboard-badge is-bronze" });
					setBadgeContent(b, "🥉", `合格 ×${counts.bronze}`);
				}
			} else {
				wall.createDiv({ cls: "planboard-badge-wall-empty", text: "暂无徽章 · 周/月任务完成 60%+ 即可获得" });
			}
		}

		// v6.3: 年度任务 + 打卡统计并置——两块本来各占一行、都很矮，首屏被拉长；
		// 并排后一眼看完全年「做了多少 / 分在哪」。
		const duo = panel.createDiv({ cls: "planboard-period-duo" });

		// v6.4: 年度任务卡由「一条进度条」换成「环形图 + 图例」，
		// 与右边打卡统计同构——两块高度自然对齐（原来左矮右高，拉伸后底下空一片）。
		// 读法刻意保持一致：扇区角度 = 任务量占比，中心 + 图例 = 完成度。
		const overview = duo.createDiv({ cls: "planboard-card planboard-plan-card planboard-review-task" });
		const taskHead = overview.createDiv({ cls: "planboard-card-header" });
		taskHead.createDiv({ cls: "planboard-card-title", text: "🗂️ 年度任务" });
		if (stats.taskTotal <= 0) {
			overview.createDiv({ cls: "planboard-empty", text: "年度暂无任务 · 去「计划」页或「今日」页添加" });
		} else {
			// 扇区 = 各计划的任务量（任务池每条带 #计划/xxx 标签，没标签的归「未分类」）
			const groups = new Map<string, { done: number; total: number }>();
			for (const t of stats.tasks) {
				const key = t.plan ?? "未分类";
				const g = groups.get(key) ?? { done: 0, total: 0 };
				g.total += 1;
				if (t.checked) g.done += 1;
				groups.set(key, g);
			}
			const taskSlices = Array.from(groups.entries())
				.map(([label, g]) => ({
					label,
					done: g.done,
					total: g.total,
					percent: g.total > 0 ? Math.round((g.done / g.total) * 100) : 0,
					color: softenChartColor(this.planColorVars[label]?.["--pb-accent"] ?? "#3572a8"),
				}))
				// 与打卡统计同序：量大的在上（同量按名称排，保证多次刷新顺序稳定）
				.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "zh"));
			taskHead.createSpan({ cls: "planboard-chart-meta" }).textContent =
				`${taskSlices.length} 个计划 · 合计 ${stats.taskTotal} 个`;
			const taskWrap = overview.createDiv({ cls: "planboard-donut-wrap" });
			const taskChartBox = taskWrap.createDiv({ cls: "planboard-donut-chart" });
			taskChartBox.appendChild(
				buildDonutChartSvg(
					taskSlices.map((s) => ({ value: s.total, color: s.color, done: s.done })),
					`${stats.taskDone}/${stats.taskTotal}`,
					"已完成",
				),
			);
			const taskLegend = taskWrap.createDiv({ cls: "planboard-donut-legend" });
			for (const s of taskSlices) {
				const lrow = taskLegend.createDiv({ cls: "planboard-donut-legend-row" });
				const dot = lrow.createSpan({ cls: "planboard-donut-dot" });
				dot.style.background = s.color;
				lrow.createSpan({ cls: "planboard-donut-name", text: s.label });
				const val = lrow.createSpan({ cls: "planboard-donut-val" });
				val.createSpan({ cls: "planboard-donut-num", text: `${s.done}/${s.total} 个` });
				val.createSpan({ cls: "planboard-donut-pct", text: `${s.percent}%` });
				lrow.title = `${s.label}：任务已完成 ${s.done}/${s.total} 个（${s.percent}%）· 占全年任务量 ${Math.round((s.total / stats.taskTotal) * 100)}%`;
			}
		}

		// 打卡统计：v6.3 由「按计划分行进度条」改为「彩色环形图 + 图例」——
		// 分行进度条各说各的完成率，看不出"全年打卡量怎么分布"；环形图一次画出来。
		// 色 = 计划色柔化（softenChartColor），与首页「本月各计划打卡」条形图同一读法。
		const checkCard = duo.createDiv({ cls: "planboard-card planboard-plan-card planboard-review-check" });
		const checkHead = checkCard.createDiv({ cls: "planboard-card-header" });
		checkHead.createDiv({ cls: "planboard-card-title", text: "🍩 打卡统计" });
		const liveRates = stats.planRates.filter((r) => stats.planProgress.some((p) => p.plan === r.plan));
		if (liveRates.length === 0) {
			checkCard.createDiv({ cls: "planboard-empty", text: "暂无打卡数据" });
		} else {
			const slices = liveRates
				.map((rate) => {
					const prog = stats.planProgress.find((p) => p.plan === rate.plan);
					const raw = this.planColorVars[rate.plan]?.["--pb-accent"] ?? prog?.color ?? "#3572a8";
					return {
						label: rate.plan,
						done: Math.max(0, rate.done),
						total: rate.total,
						percent: rate.percent,
						color: softenChartColor(raw),
					};
				})
				// 参考图的顺序：扇区大的在上（同量按名称排，保证多次刷新顺序稳定）
				.sort((a, b) => b.done - a.done || a.label.localeCompare(b.label, "zh"));
			const sum = slices.reduce((s, x) => s + x.done, 0);
			checkHead.createSpan({ cls: "planboard-chart-meta" }).textContent = `${slices.length} 个计划 · 合计 ${sum} 次`;
			const wrap = checkCard.createDiv({ cls: "planboard-donut-wrap" });
			const chartBox = wrap.createDiv({ cls: "planboard-donut-chart" });
			chartBox.appendChild(
				buildDonutChartSvg(
					slices.map((s) => ({ value: s.done, color: s.color })),
					String(sum),
					"总计",
				),
			);
			const legend = wrap.createDiv({ cls: "planboard-donut-legend" });
			for (const s of slices) {
				const row = legend.createDiv({ cls: "planboard-donut-legend-row" });
				if (s.done <= 0) row.addClass("is-zero");
				const dot = row.createSpan({ cls: "planboard-donut-dot" });
				dot.style.background = s.color;
				row.createSpan({ cls: "planboard-donut-name", text: s.label });
				const val = row.createSpan({ cls: "planboard-donut-val" });
				val.createSpan({ cls: "planboard-donut-num", text: `${s.done}/${s.total} 天` });
				val.createSpan({ cls: "planboard-donut-pct", text: `${s.percent}%` });
				row.title = `${s.label}：打卡 ${s.done}/${s.total} 天（${s.percent}%）· 占全年打卡量 ${sum > 0 ? Math.round((s.done / sum) * 100) : 0}%`;
			}
		}

		// v3.9.8: 年度总结图表——月度打卡分布（12 根柱），数据复用 completionMap 缓存
		const year = stats.label.slice(0, 4);
		if (!this.completionMap || this.completionMapYear !== year) {
			this.completionMap = await this.computeDailyCompletionMap(year);
			this.completionMapYear = year;
		}
		const yearMap = this.completionMap ?? new Map<string, number>();
		const months: { label: string; done: number }[] = [];
		for (let m = 1; m <= 12; m++) {
			const mm = String(m).padStart(2, "0");
			let sum = 0;
			for (let d = 1; d <= 31; d++) sum += yearMap.get(`${year}-${mm}-${String(d).padStart(2, "0")}`) ?? 0;
			months.push({ label: String(m), done: sum });
		}
		const distCard = panel.createDiv({ cls: "planboard-card planboard-chart-card" });
		const distHeader = distCard.createDiv({ cls: "planboard-card-header" });
		distHeader.createDiv({ cls: "planboard-card-title", text: "📊 月度打卡分布" });
		const distBody = distCard.createDiv({ cls: "planboard-chart-body" });
		distBody.appendChild(buildYearMonthsSvg(months));

		// v3.9.9: 累计打卡曲线 + 热力图（从行动页移入，全年视角统一归回顾）
		const cumCard = panel.createDiv({ cls: "planboard-card planboard-chart-card" });
		const cumHeader = cumCard.createDiv({ cls: "planboard-card-header" });
		cumHeader.createDiv({ cls: "planboard-card-title", text: "📈 累计打卡曲线" });
		const cumMeta = cumHeader.createSpan({ cls: "planboard-chart-meta" });
		const cumBody = cumCard.createDiv({ cls: "planboard-chart-body" });
		cumBody.appendChild(buildCumulativeSvg(months, yearMap));
		// 最长连击：按日期排序扫全年（断签日 < 今天才清零，未来日期不算断）
		let bestStreak = 0;
		let run = 0;
		const yearDates = [...yearMap.keys()].sort();
		for (const d of yearDates) {
			if ((yearMap.get(d) ?? 0) > 0) {
				run++;
				if (run > bestStreak) bestStreak = run;
			} else if (d < this.today) {
				run = 0;
			}
		}
		cumMeta.textContent = `全年共 ${[...yearMap.values()].reduce((s, v) => s + v, 0)} 次 · 最长连击 ${bestStreak} 天`;
		const heatCard = panel.createDiv({ cls: "planboard-card planboard-chart-card planboard-heatmap-card" });
		const heatHeader = heatCard.createDiv({ cls: "planboard-card-header" });
		heatHeader.createDiv({ cls: "planboard-card-title", text: "🔥 打卡热力图" });
		const heatBody = heatCard.createDiv({ cls: "planboard-chart-body planboard-heatmap-body" });
		heatBody.appendChild(buildHeatmapSvg(yearMap, this.today));


	}

	/** 计划页（v2.9）：年度计划管理——计划卡 masonry（新增/编辑/量化目标/拖拽排序/卡高）。
	 *  内容 = 原年度视图去掉徽章墙与打卡统计（已归 回顾·年粒度）。 */
	private async refreshPlans(): Promise<void> {
		this.panelEl?.empty();
		this.currentPanel = "plans";
		const stats = await computePeriodStats(
			this.app,
			this.plugin.settings.rootPath,
			this.today,
			"year",
			this.plugin.settings.reviewWorkdays
		);
		if (!this.panelEl) return;
		const panel = this.panelEl;
		// v6.5: banner 常驻——本页顺手喂它数据（复用已算出的年度统计，不重算）
		this.planProgress = stats.planProgress;
		this.planRates = stats.planRates;

		// v6.5: 标题交给「计划管理」标签，页内只留动作行。
		// v7.19: 去掉前缀年份——它只是统计口径的标签年（用户 1930 口径：标题不可编辑，
		// 挂着「2026」反而像写死的死文本），页面语义「计划与目标管理」本身不带年份。
		const bar = panel.createDiv({ cls: "planboard-page-bar" });
		bar.createDiv({ cls: "planboard-page-hint", text: "计划与目标管理" });
		const addPlanBtn = bar.createEl("button", {
			cls: "planboard-btn planboard-btn-outline planboard-year-add-btn",
			text: "＋ 新增计划",
		});
		addPlanBtn.addEventListener("click", () => void this.openPlanModal(null));

		if (stats.planProgress.length === 0) {
			// v1.0.5: 与首页空态同一口径——说明状态 + 给下一步动作，不提文件格式细节
			const emptyCard = panel.createDiv({ cls: "planboard-card planboard-empty-card" });
			emptyCard.createSpan({ text: "还没有年度计划" });
			const createBtn = emptyCard.createEl("button", { cls: "planboard-btn planboard-btn-outline pf-empty-cta", text: "去创建" });
			createBtn.addEventListener("click", () => void this.openPlanModal(null));
			return;
		}
		// 计划卡两列 masonry（拖放精确；保留卡高自由）
		const grid = panel.createDiv({ cls: "planboard-plan-grid is-masonry" });
		const cols = [grid.createDiv({ cls: "planboard-plan-col" }), grid.createDiv({ cls: "planboard-plan-col" })];
		const progs = [...stats.planProgress].sort((a, b) => this.orderIndexOf(a.plan) - this.orderIndexOf(b.plan));
		const colH = [0, 0];
		for (const prog of progs) {
			const card = this.renderYearPlanCard(prog);
			const saved = this.plugin.settings.yearPlanHeights[prog.plan] ?? 0;
			if (saved > 0) card.style.height = `${saved}px`;
			const idx = colH[0] <= colH[1] ? 0 : 1;
			cols[idx].appendChild(card);
			colH[idx] += card.offsetHeight + 12; // 12 = 列内 gap
			this.attachPlanSortTo(card, grid, prog.plan, cols);
			attachResizeHandle(card, card, this.plugin, "yearPlanHeights", undefined, prog.plan);
		}
	}

	private renderYearPlanCard(prog: PlanProgress): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		card.setAttribute("data-plan-name", prog.plan);
		this.applyPlanColor(card, prog.plan);

		// 卡头：名称 + hover 浮现的 [✏️][🗑️]；计划编辑/删除移入右键菜单（v1.7.4，与"编辑用右键"标准一致）
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: prog.label ? `${prog.label} ${prog.plan}` : prog.plan });
		head.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((item) => item.setTitle("编辑计划").setIcon("pencil").onClick(() => void this.openPlanModal(toPlanDef(prog))));
			// v7.20: 「新增量化目标」菜单项退役——编辑计划表单已带量化目标段（用户 195107），
			// 补目标走「编辑计划」一段即可，菜单少一项、入口唯一。
			menu.addItem((item) => item.setTitle("删除计划").setIcon("trash").onClick(() => void this.deletePlan(prog)));
			menu.showAtMouseEvent(e);
		});
		const headActions = head.createDiv({ cls: "planboard-head-actions" });
		// v7.4: 编辑/删除从「标题右键」改 hover 浮现（v7.4c 用户 020852：常驻太抢眼）——悬停卡头浮现、透明占位；
		// v7.16: 「＋新增量化目标」按钮撤除——新建目标并入「新增计划」表单第二段（用户 165222），
		// 已有计划补目标走卡头右键菜单。
		const planEditBtn = headActions.createEl("button", {
			cls: "planboard-icon-btn",
			attr: { "aria-label": "编辑计划", title: "编辑计划" },
		});
		planEditBtn.setText("✏️"); // 编辑按钮统一为彩色 emoji（与打卡行动区一致，用户拍板）
		planEditBtn.addEventListener("click", () => void this.openPlanModal(toPlanDef(prog)));
		const planDelBtn = headActions.createEl("button", {
			cls: "planboard-icon-btn planboard-del-btn",
			attr: { "aria-label": "删除计划", title: "删除计划" },
		});
		setIcon(planDelBtn, "lucide-trash-2");
		planDelBtn.addEventListener("click", () => void this.deletePlan(prog));

		// v6.7（#9）：目标文案 / 进度条 / 打卡率 三行并成一行。
		// 原来竖着码三行，卡片被撑高且读起来要上下扫；现在一处横向读完。
		const metric = card.createDiv({ cls: "planboard-plan-metric" });
		// v7.17: 度量框加「打卡行动」标题。
		// v1.0.5.2: **与量化目标区同构的两行制**（用户截图反馈「这跟量化目标的一样吗」）——
		// 标题行（title + hover ✏️）+ 进度行（target + bar + count）。此前按钮混在一行制里位置不明。
		// ✏️ = 打开该计划今日打卡项的管理弹窗（自动项不可删，手动项可编辑/删除）。
		// 🗑️ 清空按钮已移除：跟随计划自动创建的打卡项不可删除，只有删除计划才连带删除。
		const metricHead = metric.createDiv({ cls: "planboard-plan-metric-head" });
		metricHead.createDiv({ cls: "planboard-plan-metric-title", text: "✅ 打卡行动" });
		const metricActions = metricHead.createDiv({ cls: "planboard-item-actions planboard-goal-actions" });
		const metricEditBtn = metricActions.createEl("button", {
			cls: "planboard-icon-btn",
			attr: { "aria-label": "管理今日打卡项", title: "管理今日打卡项" },
		});
		metricEditBtn.setText("✏️"); // 彩色 emoji（用户拍板保留原样；Lucide 铅笔是灰色描边）
		metricEditBtn.addEventListener("click", () => void this.openCheckItemManager(prog.plan));
		const metricRow = metric.createDiv({ cls: "planboard-plan-metric-row" });
		if (prog.target) {
			const targetEl = metricRow.createDiv({ cls: "planboard-plan-target-line", text: prog.target });
			targetEl.setAttribute("title", prog.target); // 窄档下会省略号截断，hover 看全文
		}

		// v7.4: 顶条改为打卡进度条——数字型计划的顶条原来显示任务进度，
		// 与下方量化目标行完全重复（用户 012810 截图）。打卡数据（checkDone/checkTotal）
		// 来自每日日记勾选，数字型计划同样可能有（stats v7.4 起带回）。分工：
		//   顶条 = 打卡进度（坚持多少天）  量化目标行 = 任务进度（写了几篇）
		// 无打卡数据（checkTotal=0）的计划回退旧口径，避免 0/0 空条。
		const useCheck = prog.checkTotal > 0;
		const barPercent = useCheck ? prog.checkPercent : prog.percent;
		const bar = metric.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${barPercent}%`;
		setTier(fill, barPercent);

		// 条上 = 百分比；条后 = 计数/总数；明细进 hover（v6.8/v7.0 分工延续）
		bar.setAttribute(
			"title",
			useCheck
				? `打卡率 ${prog.checkDone}/${prog.checkTotal} 天 · ${prog.checkPercent}%`
				: prog.isNumeric
					? `已完成 ${prog.doneCount}/${prog.targetCount} · ${prog.percent}%`
					: `打卡率 ${prog.checkDone}/${prog.checkTotal} 天 · ${prog.percent}%`,
		);
		bar.createDiv({ cls: "planboard-progress-pct", text: `${barPercent}%` });

		metric.createDiv({
			cls: "planboard-progress-count",
			text: useCheck
				? `${prog.checkDone}/${prog.checkTotal} 天`
				: prog.isNumeric
					? `${prog.doneCount}/${prog.targetCount}`
					: `${prog.checkDone}/${prog.checkTotal} 天`,
		});

		// 量化目标区（仅数量型且有 goals 的计划；打卡型不显示）。
		// v7.4b: 目标行的 ✏️🗑️ 落「🎯 量化目标」标题行，hover 标题行浮现（v7.4c 用户 020852）——
		// 单目标计划直接落标题行；多目标时标题行按钮无法定位是哪个目标，回退行内按钮。
		if (prog.isNumeric && prog.goals.length === 0) {
			// v1.0.5: 空状态引导——建了计划但还没拆量化目标，这是流程的下一步，
			// 指到「编辑计划」表单（v7.16 起新增/补目标都走这一段，入口唯一）。
			const goalEmpty = card.createDiv({ cls: "planboard-goals-empty" });
			goalEmpty.createSpan({ text: "还没有量化目标，先去拆一个" });
			const addGoalBtn = goalEmpty.createEl("button", { cls: "planboard-btn planboard-btn-outline pf-empty-cta", text: "去添加" });
			addGoalBtn.addEventListener("click", () => void this.openPlanModal(toPlanDef(prog)));
		}
		if (prog.isNumeric && prog.goals.length > 0) {
			const goalsBox = card.createDiv({ cls: "planboard-goals-box" });
			const goalsHead = goalsBox.createDiv({ cls: "planboard-goals-head" });
			goalsHead.createDiv({ cls: "planboard-goals-title", text: "🎯 量化目标" });
			const single = prog.goals.length === 1 ? prog.goals[0] : null;
			if (single) {
				const actions = goalsHead.createDiv({ cls: "planboard-item-actions planboard-goal-actions is-static" });
				const gEditBtn = actions.createEl("button", {
					cls: "planboard-icon-btn",
					attr: { "aria-label": "编辑目标", title: "编辑目标" },
				});
				gEditBtn.setText("✏️"); // 编辑按钮统一为彩色 emoji
				gEditBtn.addEventListener("click", () => void this.openGoalModal(prog.plan, single));
				const gDelBtn = actions.createEl("button", {
					cls: "planboard-icon-btn planboard-del-btn",
					attr: { "aria-label": "删除目标", title: "删除目标" },
				});
				setIcon(gDelBtn, "lucide-trash-2");
				gDelBtn.addEventListener("click", () => void this.deleteGoal(prog, single));
			}
			for (const goal of prog.goals) {
				goalsBox.appendChild(this.renderYearGoalRow(goal, prog, !single));
			}
		}

		card.createDiv({ cls: "planboard-plan-tasks-title", text: "任务" });
		// Sort by 📅 ascending; completed tasks sink to the bottom.
		const sorted = sortTasksByDue(prog.tasks);
		if (sorted.length === 0) {
			card.createDiv({ cls: "planboard-empty", text: "暂无关联任务" });
		} else {
			const ul = card.createEl("ul", { cls: "planboard-checklist planboard-plan-tasks" });
			for (const t of sorted) ul.appendChild(this.renderTaskItem(t));
		}

		// v1.7.4: 量化目标按钮已移入卡头（head-actions ＋ icon）——原底部按钮在拖拽调高时悬空（实测确认）
		return card;
	}

	/** One quantified-goal row: name + mini bar + count；多目标计划附带行内 [✏️][🗑️]（单目标时按钮在标题行）。 */
	private renderYearGoalRow(goal: PlanGoalProgress, prog: PlanProgress, withActions: boolean): HTMLElement {
		const row = createDiv({ cls: "planboard-goal-row planboard-goal-row--mini" });
		row.createDiv({ cls: "planboard-goal-name", text: goal.name });
		// v7.4: 计数挪到条尾、百分比压到条上（原来「1/8 篇」挤在条前、无百分比）
		const bar = row.createDiv({ cls: "planboard-goal-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${goal.percent}%`;
		setTier(fill, goal.percent);
		bar.setAttribute("title", `已完成 ${goal.done}/${goal.total} ${goal.unit || "个"} · ${goal.percent}%`);
		bar.createDiv({ cls: "planboard-progress-pct", text: `${goal.percent}%` });
		row.createDiv({ cls: "planboard-goal-count", text: `${goal.done}/${goal.total} ${goal.unit || "个"}` });
		if (withActions) {
			const actions = row.createDiv({ cls: "planboard-item-actions planboard-goal-actions" });
			const editBtn = actions.createEl("button", {
				cls: "planboard-icon-btn",
				attr: { "aria-label": "编辑目标", title: "编辑目标" },
			});
			editBtn.setText("✏️"); // 编辑按钮统一为彩色 emoji
			editBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void this.openGoalModal(prog.plan, goal);
			});
			const delBtn = actions.createEl("button", {
				cls: "planboard-icon-btn planboard-del-btn",
				attr: { "aria-label": "删除目标", title: "删除目标" },
			});
			setIcon(delBtn, "lucide-trash-2");
			delBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void this.deleteGoal(prog, goal);
			});
		}
		return row;
	}

	private renderPlanRateCard(rate: PlanRate): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		card.setAttribute("data-plan-name", rate.plan);
		this.applyPlanColor(card, rate.plan);
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: rate.plan });
		head.createSpan({ cls: "planboard-plan-rate", text: `${rate.done}/${rate.total} 天` });
		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${rate.percent}%`;
		card.createDiv({ cls: "planboard-plan-percent", text: `${rate.percent}%` });
		return card;
	}

	private renderTempSummaryCard(stats: PeriodStats): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: "临时任务" });
		head.createSpan({ cls: "planboard-plan-rate", text: `${stats.tempDone}/${stats.tempTotal} 完成` });
		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill planboard-progress-fill--temp" });
		fill.style.width = `${stats.tempPercent}%`;
		card.createDiv({ cls: "planboard-plan-percent", text: `${stats.tempPercent}%` });
		return card;
	}

	private renderTaskSummaryCard(stats: PeriodStats): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: "任务" });
		head.createSpan({ cls: "planboard-plan-rate", text: `${stats.taskDone}/${stats.taskTotal} 完成` });
		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${stats.taskPercent}%`;
		const pct = card.createDiv({ cls: "planboard-plan-percent" });
		pct.setText(`${stats.taskPercent}%`);
		const tier = tierFor(stats.taskDone, stats.taskTotal);
		if (tier) {
			pct.createSpan({ cls: `planboard-badge ${tier.cls}`, text: `${tier.emoji} ${tier.qualifier}` });
		}
		return card;
	}

	// -------------------------------------------------------------------------
	// Plan & goal management (v1.2: PlanEditModal / GoalEditModal / delete)
	// -------------------------------------------------------------------------

	/** Resolve the annual plan file (`{root}/{year}/年度计划.md`, falls back to `{root}/年度计划.md`). */
	private async findAnnualPlanFile(): Promise<TFile | null> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		for (const path of [annualPlanPath(root, year), annualPlanPath(root)]) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) return f;
		}
		return null;
	}

	/** Per-plan `daily` flag from the raw frontmatter (preserved on write-back). */
	private readRawDailyMap(content: string): Record<string, boolean> {
		const out: Record<string, boolean> = {};
		for (const [name, obj] of readRawPlans(content)) {
			out[name] = obj.daily === true || obj.daily === "true";
		}
		return out;
	}

	private async openPlanModal(plan: PlanDef | null): Promise<void> {
		// 新增大类默认每日打卡（大类=日常例行，例外才取消勾选）
		let daily = true;
		if (plan) {
			const file = await this.findAnnualPlanFile();
			if (file) {
				const content = await this.app.vault.cachedRead(file);
				daily = this.readRawDailyMap(content)[plan.name] ?? false;
			}
		}
		// v7.18: 传已有计划名（datalist 候选）+ 当前计划周期（起止日期回填）
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const defs = (await this.readAnnualPlanDefs(root, year)) ?? [];
		const existingNames = defs.map((d) => d.name).filter((n) => !plan || n !== plan.name);
		const period = await readPlanPeriod(this.app, root, year);
		// v7.20: today 打开弹窗时现取——视图缓存会隔天变旧（新增计划的「开始日期默认当日」
		// 与添加打卡的默认日期都依赖它，1958 用户实测停在旧日期）
		new PlanEditModal(this.app, plan, daily, existingNames, period, todayStr(), async (input) => {
			// v7.18: 新增表单里名称命中已有计划 → 不建计划，只为它新增量化目标
			//（datalist 的用途就是「在已有计划下新增量化目标」）；没填目标则明确拦截，
			// 不走 savePlan 的同名报错（那里话说不清这个场景）。
			if (!plan && defs.some((d) => d.name === input.name)) {
				if (!input.goal) {
					new Notice(`已存在同名计划「${input.name}」，请在下方量化目标段填写要新增的目标`);
					return false;
				}
				await this.writePlanPeriod(input.period ?? null);
				return await this.saveGoal(input.name, null, input.goal);
			}
			const ok = await this.savePlan(plan, input);
			// v7.16: 新增计划时顺带建量化目标（合并表单第二段；savePlan 已把计划写进
			// frontmatter，saveGoal 按名字找到它再追加 goals，故必须先 plan 后 goal）
			// v7.20: 编辑已有计划时填了量化目标段 → 同样追加（编辑表单复用新建页面）
			if (ok && input.goal) {
				const goalOk = await this.saveGoal(input.name, null, input.goal);
				if (!goalOk) return false; // 目标写失败时让表单保持打开，用户改完重试
			}
			// v7.18: 计划周期写年度计划 frontmatter 顶层 start/end（都空 = 清除回自然年）
			if (ok) await this.writePlanPeriod(input.period ?? null);
			return ok;
		}).open();
	}

	/**
	 * v7.18: 把计划周期写进年度计划 frontmatter 顶层 start/end（readPlanPeriod 的数据源）。
	 * period=null 表示清除（年度统计窗口回自然年）。只动这两行，plans 块与正文不碰。
	 */
	private async writePlanPeriod(period: { start: string; end: string } | null): Promise<void> {
		const file = await this.findAnnualPlanFile();
		if (!file) return;
		await this.withSelfWrite(async () => {
			await this.app.vault.process(file, (content) => {
				const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
				if (!fmMatch) return content;
				const lines = fmMatch[1].split("\n");
				const firstIdx = lines.findIndex((l) => /^(start|end):/.test(l));
				const kept = lines.filter((l) => !/^(start|end):/.test(l));
				if (period) {
					const ins = [`start: ${period.start}`, `end: ${period.end}`];
					// 原来有 start/end 行 → 原位插回；没有 → plans: 前；连 plans 都没有 → 末尾
					const at = firstIdx >= 0 ? firstIdx : kept.findIndex((l) => /^plans:(\s|$)/.test(l));
					if (at >= 0) kept.splice(at, 0, ...ins);
					else kept.push(...ins);
				}
				return content.replace(fmMatch[0], `---\n${kept.join("\n")}\n---`);
		});
		});
	}

	private async openGoalModal(planName: string, goal: PlanGoal | null): Promise<void> {
		// v7.21: 每日打卡段加了「计划」下拉——选项 = 当前计划排最前 + 真实计划 + 内置名
		//（与 openAddItemModal 同口径；标签对不上计划的打卡项统计会漏计）。
		const root = pfRoot(this.plugin.settings.rootPath);
		const defs = (await this.readAnnualPlanDefs(root, todayStr().slice(0, 4))) ?? [];
		const options = Array.from(new Set([planName, ...defs.map((d) => d.name), ...Object.keys(DEFAULT_PLAN_COLORS)]));
		new GoalEditModal(this.app, planName, goal, options, (input) => this.saveGoal(planName, goal, input)).open();
	}

	/** Save a new/edited plan category back to the annual frontmatter. Returns success. */
	private async savePlan(existing: PlanDef | null, input: PlanEditInput): Promise<boolean> {
		const file = await this.findAnnualPlanFile();
		if (!file) {
			new Notice("未找到年度计划文件");
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const dailyMap = this.readRawDailyMap(content);

		if (existing) {
			const def = defs.find((d) => d.name === existing.name);
			if (!def) {
				new Notice("未找到该计划");
				return false;
			}
			if (input.name !== existing.name && defs.some((d) => d.name === input.name)) {
				new Notice(`已存在同名计划「${input.name}」`);
				return false;
			}
		def.name = input.name;
		def.label = input.label;
		// v7.18: 「目标描述」栏退役——def.target 保持原值不动（老数据照常显示，
		// 新计划为空字符串，metric 行 `if (prog.target)` 自然跳过）
		if (input.color) def.color = input.color;
			dailyMap[input.name] = input.daily;
			if (input.name !== existing.name) delete dailyMap[existing.name];
		} else {
			if (defs.some((d) => d.name === input.name)) {
				new Notice(`已存在同名计划「${input.name}」`);
				return false;
			}
		defs.push({
			name: input.name,
			type: "check",
			// v7.18: 目标描述栏退役，新建计划不再写 target
			target: "",
			targetCount: 0,
				goals: [],
				// v7.6：不再写 action（原「1小时」后缀）
				action: "",
				label: input.label,
				color: input.color || rotatePlanColor(defs),
				tradingDay: false,
				daily: input.daily,
			});
			dailyMap[input.name] = input.daily;
		}

		await this.withSelfWrite(async () => {
			await writePlansToFile(this.app, file, defs, dailyMap);
			// 大类改名联动：任务池 + 每日笔记的 #计划/{旧名} → #计划/{新名}（防前缀误伤，跨年一致）
			if (existing && input.name !== existing.name) {
				const root = pfRoot(this.plugin.settings.rootPath);
				const oldTag = `#计划/${existing.name}`;
				const newTag = `#计划/${input.name}`;
				const re = new RegExp(`${escapeRegExp(oldTag)}(?=\\s|$)`, "g");
				for (const tf of this.app.vault.getFiles()) {
					if (!tf.path.startsWith(root)) continue;
					const isPool = /(^|\/)任务\.md$/.test(tf.path);
					const isDaily = /\/每日\/\d{4}-\d{2}-\d{2}\.md$/.test(tf.path);
					if (!isPool && !isDaily) continue;
					const c = await this.app.vault.cachedRead(tf);
					if (!c.includes(oldTag)) continue;
					await this.app.vault.process(tf, (data) => data.replace(re, newTag));
				}
			}
			// 新增大类(每日打卡)：今日笔记补打卡项（模板只影响新建笔记，已有今日笔记需补）
			if (!existing && input.daily) {
				const root = pfRoot(this.plugin.settings.rootPath);
				const todayPath = dailyNotePath(root, this.today);
				const todayFile = this.app.vault.getAbstractFileByPath(todayPath);
				if (todayFile instanceof TFile) {
					const todayContent = await this.app.vault.cachedRead(todayFile);
					if (!todayContent.includes(`#计划/${input.name}`)) {
						const line = buildCheckLine({
							name: input.label || input.name,
							plan: input.name,
							includeReview: false,
							date: this.today,
						});
						await this.app.vault.process(todayFile, (data) => appendCheckItem(data, line));
					}
				}
			}
		});
		new Notice("计划已保存");
		await this.refresh();
		return true;
	}

	/** Save a new/edited quantified goal back to its plan's goals array. Returns success. */
	private async saveGoal(planName: string, existing: PlanGoal | null, input: GoalInput): Promise<boolean> {
		const file = await this.findAnnualPlanFile();
		if (!file) {
			new Notice("未找到年度计划文件");
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const def = defs.find((d) => d.name === planName);
		if (!def) {
			new Notice("未找到该计划");
			return false;
		}
		const goal: PlanGoal = { name: input.name, count: input.count, unit: input.unit || "个" };
		if (input.start) goal.start = input.start;
		if (input.end) goal.end = input.end;
		if (input.daily) goal.daily = true;
		// v7.21: 每日打卡项的自定义内容（名称/计划/窗口/复盘链接）随目标落 YAML
		if (input.daily && input.dailyItem) goal.dailyItem = input.dailyItem;

		if (existing) {
			const idx = def.goals.findIndex((g) => g.name === existing.name);
			if (idx === -1) {
				new Notice("未找到该量化目标");
				return false;
			}
			if (input.name !== existing.name && def.goals.some((g) => g.name === input.name)) {
				new Notice(`同计划下已存在同名目标「${input.name}」`);
				return false;
			}
			// 改名联动：任务池中「旧名（第 N …）」任务改为新名，避免失联后重复分解
			if (input.name !== existing.name) {
				const root = pfRoot(this.plugin.settings.rootPath);
				const year = this.today.slice(0, 4);
				const pool = this.app.vault.getAbstractFileByPath(taskPoolPath(root, year));
				if (pool instanceof TFile) {
					const oldPrefix = `${existing.name}（`;
					const newPrefix = `${input.name}（`;
					await this.app.vault.process(pool, (data) => {
						if (!data.includes(oldPrefix)) return data;
						return data
							.split("\n")
							.map((l) => (l.includes(oldPrefix) ? l.replace(oldPrefix, newPrefix) : l))
							.join("\n");
					});
				}
			}
			def.goals[idx] = goal;
		} else {
			if (def.goals.some((g) => g.name === input.name)) {
				new Notice(`同计划下已存在同名目标「${input.name}」`);
				return false;
			}
			def.goals.push(goal);
		}

		await this.withSelfWrite(async () => {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
		});
		// v7.20: 勾了「量化到每日打卡」→ 今天在窗口内就立即补一条该目标的打卡项
		//（之后的日期由 buildDailyTemplate 建新日记时自动推导）；今天不在窗口则只存标志。
		// 只在保存这一刻写一次，用户事后删掉该行不会被复活。
		// v7.21: 补项内容改用可编辑段（dailyItem）——名称/计划/窗口/复盘链接都可自定义，
		// 未给则回落目标自身值（与 buildDefaultCheckItems 推导口径一致）。
		if (input.daily) {
			const di = input.dailyItem ?? { name: goal.name, plan: planName };
			const t = todayStr();
			const ws = di.start ?? goal.start ?? "";
			const we = di.due ?? goal.end ?? "";
			if ((!ws || t >= ws) && (!we || t <= we)) {
				const dailyPath = dailyNotePath(this.plugin.settings.rootPath, t);
				const df = this.app.vault.getAbstractFileByPath(dailyPath);
				if (df instanceof TFile) {
					const parsed = parseDailyContent(df, await this.app.vault.cachedRead(df), t);
					const exists = parsed.checkItems.some((i) => i.text === di.name && i.plan === di.plan);
					if (!exists) {
						const line = buildCheckLine({
							name: di.name,
							plan: di.plan,
							includeReview: di.review === true,
							date: t,
							start: di.start,
							due: di.due,
						});
						await this.withSelfWrite(async () => {
							await this.app.vault.process(df, (data) => appendCheckItem(data, line));
						});
					}
				}
			}
		}
		new Notice("量化目标已保存");
		// v1.5 联动 + 修复：编辑目标后重建分解任务；【新建目标同样触发分解】（此前新建只写文件不生成任务）
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const pool = this.app.vault.getAbstractFileByPath(taskPoolPath(root, year));
		if (existing) {
			if (pool instanceof TFile) {
				const prefix = `${existing.name}（`;
				await this.withSelfWrite(async () => {
					await this.app.vault.process(pool, (data) =>
						data
							.split("\n")
							.filter((l) => {
								const m = TASK_LINE_RE.exec(l);
								if (!m) return true;
								return !(m[3] === planName && l.includes(prefix));
							})
							.join("\n")
					);
				});
			}
			// v1.0.4: 目标重建 = 全量重生成，先清掉该目标的删除墓碑（旧名一并清，防残留）
			this.clearAutoTombstones(`${existing.name}（`);
			this.clearAutoTombstones(`${input.name}（`);
			await this.ensureAutoTasksForToday(root, year);
			new Notice("目标已更新，分解任务已按新设置重建");
		} else {
			// v1.0.4: 新建同名目标时清掉旧墓碑，避免分解被误跳过
			this.clearAutoTombstones(`${input.name}（`);
			await this.ensureAutoTasksForToday(root, year);
			new Notice("目标已保存，分解任务已生成");
		}
		await this.refresh();
		return true;
	}

	/** Delete a plan category + all of its pool tasks (incl. decomposed). */
	private async deletePlan(prog: PlanProgress): Promise<void> {
		if (!await confirmDialog(this.app, `删除计划「${prog.plan}」将同时删除其全部任务（含分解任务），确定？`, { danger: true })) return;
		const file = await this.findAnnualPlanFile();
		if (!file) {
			new Notice("未找到年度计划文件");
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const idx = defs.findIndex((d) => d.name === prog.plan);
		if (idx === -1) return;
		defs.splice(idx, 1);
		const dailyMap = this.readRawDailyMap(content);
		delete dailyMap[prog.plan];

		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		const toDelete = tasks.filter((t) => t.plan === prog.plan).sort((a, b) => b.line - a.line);

		await this.withSelfWrite(async () => {
			await writePlansToFile(this.app, file, defs, dailyMap);
			for (const t of toDelete) await deleteTask(this.app, t);
			// v1.0.4: 计划连同任务删除 → 清掉这些任务的删除墓碑
			const deletedTexts = new Set(toDelete.map((t) => t.text.trim()));
			this.plugin.settings.deletedAutoTasks = (this.plugin.settings.deletedAutoTasks ?? []).filter((n) => !deletedTexts.has(n));
			void this.plugin.saveSettings();
			// v1.4 联动：清理今日笔记中该计划的打卡行（v2.7: dailyTemplates 已废除，打卡默认项由年度计划自动推导）
			const todayFile = this.getTodayFile();
			if (todayFile) {
				const todayContent = await this.app.vault.cachedRead(todayFile);
				const lines = todayContent.split("\n");
				const keep = lines.filter((l) => {
					const m = TASK_LINE_RE.exec(l);
					return !m || (m[3] ?? null) !== prog.plan;
				});
				if (keep.length !== lines.length) {
					await this.app.vault.modify(todayFile, keep.join("\n"));
				}
			}
		});
		new Notice("计划已删除");
		await this.refresh();
	}

	/** Delete a quantified goal + its decomposed pool tasks. */
	private async deleteGoal(prog: PlanProgress, goal: PlanGoalProgress): Promise<void> {
		if (!await confirmDialog(this.app, `删除量化目标「${goal.name}」及其分解任务？`, { danger: true })) return;
		const file = await this.findAnnualPlanFile();
		if (!file) {
			new Notice("未找到年度计划文件");
			return;
		}
		const content = await this.app.vault.cachedRead(file);
		const defs = parsePlansFromFrontmatter(content);
		const def = defs.find((d) => d.name === prog.plan);
		if (!def) {
			new Notice("未找到该计划");
			return;
		}
		const idx = def.goals.findIndex((g) => g.name === goal.name);
		if (idx === -1) return;
		def.goals.splice(idx, 1);

		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		const prefix = `${goal.name}（`;
		const toDelete = tasks
			.filter((t) => t.plan === prog.plan && t.text.trim().startsWith(prefix))
			.sort((a, b) => b.line - a.line);

		await this.withSelfWrite(async () => {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
			for (const t of toDelete) await deleteTask(this.app, t);
			// v1.0.4: 目标已删除 → 其分解任务墓碑随之作废
			this.clearAutoTombstones(`${goal.name}（`);
		});
		new Notice("量化目标已删除");
		await this.refresh();
	}

	/** Whether the pool already has auto tasks named `{goal.name}（第 N …」. */
	private async goalHasDecomposedTasks(planName: string, goalName: string): Promise<boolean> {
		const root = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		return tasks.some((t) => t.plan === planName && t.text.trim().startsWith(`${goalName}（`));
	}

	// -------------------------------------------------------------------------
	// Plan color styles (settings-driven, applied via setCssProps — no <style> elements)
	// -------------------------------------------------------------------------

	/** 计划名 → 颜色变量集（setCssProps 用）。 */
	private planColorVars: Record<string, Record<string, string>> = {};

	/** 在渲染元素上应用计划色（CSS 变量方式，替代被禁的 <style> 注入）。 */
	applyPlanColor(el: HTMLElement, plan: string | undefined | null): void {
		if (!plan) return;
		const vars = this.planColorVars[plan];
		if (!vars) return;
		el.setCssProps(vars);
	}

	private async injectPlanColorStyles(): Promise<void> {
		// settings 优先，年度计划 frontmatter 的 color 字段兜底（spec v1.2 #6）。
		const colors: Record<string, string> = { ...(this.plugin.settings.planColors ?? {}) };
		const rootPath = pfRoot(this.plugin.settings.rootPath);
		const year = this.today.slice(0, 4);
		const defs = await this.readAnnualPlanDefs(rootPath, year);
		const planNames = new Set<string>();
		if (defs) {
			for (const def of defs) {
				planNames.add(def.name);
				if (def.color && !(def.name in colors)) colors[def.name] = def.color;
			}
		}
		// v1.7.2: 未配置颜色的计划 → 调色板哈希分配（卡片颜色区分）
		const PALETTE = ["#e07b5a", "#5a9e6f", "#5b8dd6", "#c77dbf", "#d6a24b", "#6fb3b8", "#b86b6b", "#7d8fd6", "#8aa65a", "#d68a5b"];
		const hashName = (s: string): number => {
			let h = 0;
			for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
			return h;
		};
		let idx = 0;
		for (const name of planNames) {
			if (!(name in colors)) {
				colors[name] = PALETTE[hashName(name) % PALETTE.length];
				// 避免相邻计划撞色：与已分配色冲突则顺延
				const used = new Set(Object.values(colors));
				let guard = 0;
				while (used.has(colors[name]) && guard++ < PALETTE.length) {
					colors[name] = PALETTE[(hashName(name) + idx++) % PALETTE.length];
				}
			}
		}
		this.planColorVars = {};
		for (const [plan, color] of Object.entries(colors)) {
			const bg = hexToRgba(color, 0.08); /* v1.7.4: 标签降饱和（0.14→0.08），降"彩虹糖"感 */
			this.planColorVars[plan] = {
				"--pb-accent": color,
				"--pb-accent-bg": bg,
				"--pb-accent-dim": hexToRgba(color, 0.28),
				"--plan-tag-color": color,
				"--plan-tag-bg": bg,
			/* v6.7（#4）：标签文字恢复计划色。v6.0 曾把标签改成素色小字，
			   颜色只留在行首色点上；用户要求分类小字各自带色，故补两档可读色。
			   浅色主题用加深版（L<=0.4），深色主题用柔化提亮版——与 banner 计划名同一套做法。 */
			"--plan-tag-text-light": deepenForText(color),
			"--plan-tag-text-dark": softenChartColor(color),
			// v7.1（#2）：甘特条不再按计划配色 —— --plan-gantt-* 五个变量与降饱和函数一并移除，
			// 四态共用参考图的单色状态色板（styles.css 侧 --pg-*）；计划的区分走任务名文字色。
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------














