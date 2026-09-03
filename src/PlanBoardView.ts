import { App, ButtonComponent, ItemView, MarkdownView, Menu, Modal, Notice, Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf, parseYaml } from "obsidian";
import type PlanBoardPlugin from "../main";
import type { CheckItem, DailyData } from "./daily";
import {
	appendCheckItem,
	buildCheckLine,
	buildDailyTemplate,
	buildReviewTemplate,
	moveTaskLine,
	parseDailyContent,
	parseDateString,
	removeLine,
	replaceSummary,
	TASK_LINE_RE,
	todayStr,
	toggleTaskLine,
	weekRange,
	daysInMonth,
} from "./daily";
import type { PeriodStats, PeriodType, PlanDef, PlanGoal, PlanGoalProgress, PlanProgress, PlanRate } from "./stats";
import {
	computePeriodStats,
	computeAnnualPlanProgress,
	filterTasksInRange,
	parsePlansFromFrontmatter,
	readPlanPeriod,
} from "./stats";
import type { AutoTaskPlan, NewTaskInput, PoolTask } from "./tasks";
import { addTask, DAY_MS, deleteTask, editTask, ensureAutoTasks, listTasks, planCounterUnit, toggleTask } from "./tasks";
import { badgeCounts, computeStreak, readMonthBadges, readPeriodBadges, settleMonth, settleMonthCheckin, settleWeek, settleWeekCheckin, tierFor } from "./achievements";
import { attachGanttDrag } from "./gantt-drag";
import { DEFAULT_PLAN_COLORS, type PlanTemplate } from "./settings";

/** v1.7.4: 插件改名 PlanFlow——view type 同步改（workspace 布局重新打开一次即可） */
export const VIEW_TYPE_PLANFLOW = "planflow";

type TabKey = PeriodType | "today" | "board" | "gantt";

const PERIOD_TITLES: Record<PeriodType, string> = {
	week: "本周",
	month: "本月",
	year: "年度",
};

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
	key: "monthCardHeight" | "weekCardHeight" | "checkCardHeight" | "summaryCardHeight" | "yearPlanHeights",
	linked?: { target: () => HTMLElement | null; key: "monthCardHeight" | "weekCardHeight" | "checkCardHeight" | "summaryCardHeight" },
	mapKey?: string,
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
			// v1.7.4: 自由缩放（min 80）——handle 贴底即下边框，二者相对固定；
			// 内容溢出由各卡内容容器滚动/裁剪处理（见 styles.css 年度卡 plan-tasks 滚动）
			const h = Math.min(1200, Math.max(80, startH + (ev.clientY - startY)));
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

/** Pre-filled fields for the new-task modal. */
interface TaskDefaults {
	plan?: string;
	start?: string;
	due?: string;
}

/** Fields editable in PlanEditModal (new or edit a plan category). */
interface PlanEditInput {
	name: string;
	label: string;
	action: string;
	target: string;
	color: string;
	daily: boolean;
}

/** Fields editable in GoalEditModal (new or edit a quantified goal). */
interface GoalInput {
	name: string;
	count: number;
	unit: string;
	start?: string;
	end?: string;
}

/** Palette offered in PlanEditModal (spec v1.2); empty choice = auto-rotate. */
const PLAN_COLOR_OPTIONS = ["#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

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
	/** True while the view itself is writing to a vault file (suppresses modify events). */
	private selfWrite = false;
	/** Which panel's skeleton is currently rendered in the DOM. */
	private currentPanel: TabKey | null = null;
	private summaryFocused = false;
	/** Gantt sub-mode (v1.3): week / month / year. */
	private ganttMode: "week" | "month" | "year" = "month";
	/** Board sub-mode (v1.3): group by plan category or by status. */
	private boardMode: "category" | "status" = "category";

	// Task-pool data for the current period (refreshed on vault modify).
	private weekTasks: PoolTask[] = [];
	private monthTasks: PoolTask[] = [];
	/** Latest gantt task list (drag write-back resolves tasks by pool line). */
	private ganttBarTasks: PoolTask[] = [];
	private planProgress: PlanProgress[] = [];

	// DOM refs (nullable — guard before touching)
	private panelEl: HTMLElement | null = null;
	/** 顶部日期行（v1.4）。 */
	private homeDateMainEl: HTMLElement | null = null;
	private homeDateSubEl: HTMLElement | null = null;
	private tabsEl: HTMLElement | null = null;
	private checklistEl: HTMLElement | null = null;
	private summaryEl: HTMLTextAreaElement | null = null;
	/** 打卡自动生成区（完成/未完成/鼓励语，v1.4）。 */
	private summaryAutoEl: HTMLElement | null = null;
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
		await this.injectPlanColorStyles();
		this.tabsEl = root.createDiv({ cls: "planboard-tabs" });
		this.renderTabs();
		this.panelEl = root.createDiv({ cls: "planboard-content" });
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
		// Gantt drag: event-delegated on the root (survives DOM rebuilds).
		attachGanttDrag(this.app, root, {
			resolveTask: (line) => this.ganttBarTasks.find((t) => t.line === line),
			onEdit: (task) => void this.openTaskModal(task),
			onChanged: () => void this.refresh(),
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

	private onVaultModify = (file: TAbstractFile): void => {
		if (this.selfWrite) return;
		if (file instanceof TFile && file.path.startsWith(this.plugin.settings.rootPath)) {
			this.scheduleRefresh();
		}
	};

	private onVaultDelete = (file: TAbstractFile): void => {
		if (file.path.startsWith(this.plugin.settings.rootPath)) this.scheduleRefresh();
	};

	private onVaultRename = (file: TAbstractFile, oldPath: string): void => {
		if (file.path.startsWith(this.plugin.settings.rootPath) || oldPath.startsWith(this.plugin.settings.rootPath)) {
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
		const tabs: Array<{ key: TabKey; label: string }> = [
			{ key: "today", label: "今日" },
			{ key: "week", label: "本周" },
			{ key: "month", label: "本月" },
			{ key: "year", label: "年度" },
			{ key: "board", label: "看板" },
			{ key: "gantt", label: "甘特" },
		];
		for (const t of tabs) {
			const btn = this.tabsEl.createEl("button", {
				cls: "planboard-tab" + (this.tab === t.key ? " is-active" : ""),
				text: t.label,
			});
			btn.addEventListener("click", () => void this.switchTab(t.key));
		}
	}

	private async switchTab(tab: TabKey): Promise<void> {
		if (this.tab === tab) return;
		this.tab = tab;
		this.currentPanel = null; // force skeleton rebuild
		this.renderTabs();
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.tab === "today") {
			await this.refreshToday();
		} else if (this.tab === "board") {
			await this.renderBoardPanel();
		} else if (this.tab === "gantt") {
			await this.renderGanttPanel();
		} else {
			await this.refreshPeriod(this.tab);
		}
	}

	// -------------------------------------------------------------------------
	// Today panel (home page)
	// -------------------------------------------------------------------------

	private getTodayPath(): string {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		return `${root}/${this.today.slice(0, 4)}/每日/${this.today}.md`;
	}

	private getTodayFile(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.getTodayPath());
		return f instanceof TFile ? f : null;
	}

	/** Build the home page data: year goals + month/week task windows. */
	private async buildHomeData(): Promise<void> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
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
		this.planProgress = await computeAnnualPlanProgress(
			this.app,
			root,
			this.today,
			tasks,
			yearStats.planRates
		);
	}

	/** Read the annual plan's `plans` frontmatter (year-level, root-level fallback). */
	private async readAnnualPlanDefs(root: string, year: string): Promise<PlanDef[] | null> {
		for (const path of [`${root}/${year}/年度计划.md`, `${root}/年度计划.md`]) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) {
				return parsePlansFromFrontmatter(await this.app.vault.cachedRead(f));
			}
		}
		return null;
	}

	/**
	 * v2.7: 今日打卡默认项 = 年度计划里 daily 计划的自动推导（无独立模板数据）。
	 * name = "{label} {计划名}"、duration = action、复盘计划自动带复盘链接。
	 */
	private async buildDefaultCheckItems(): Promise<PlanTemplate[]> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const defs = await this.readAnnualPlanDefs(root, this.today.slice(0, 4));
		if (!defs) return [];
		return defs
			.filter((d) => d.daily)
			.map((d) => ({
				name: `${d.label ?? ""} ${d.name}`.trim(),
				duration: d.action ?? "",
				plan: d.name,
				includeReview: d.name === "复盘" || d.tradingDay,
			}));
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
		this.selfWrite = true;
		try {
			await ensureAutoTasks(this.app, root, year, this.today, autoPlans, period.start, period.end);
		} finally {
			this.selfWrite = false;
		}
	}

	private async refreshToday(): Promise<void> {
		await this.buildHomeData();
		await this.updateStreak();
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
	}

	private buildTodaySkeleton(): void {
		if (!this.panelEl) return;
		const panel = this.panelEl;

		// v1.0.3: 本月/本周卡改为纯展示 + 目标追踪（进度条/任务列表），新建统一在年度视图——
		// 原 4 个「+ 新建」按钮（header 与空态各一）已移除。
		// 注意：monthEnd/weekStart/weekEnd 仅被这些按钮使用，随之删除。

		// --- 1. 年度目标卡 (compact one-line strip, per-plan mini bars) ---
		const goalCard = panel.createDiv({ cls: "planboard-card planboard-goal-card" });
		const goalHeader = goalCard.createDiv({ cls: "planboard-card-header planboard-goal-header" });
		goalHeader.createDiv({ cls: "planboard-card-title", text: "🎯 年度目标" });
		// v1.5: 日期+问候并入年度标题行（左侧标题，右侧日期，省一行）
		const dateWrap = goalHeader.createDiv({ cls: "planboard-home-date" });
		this.homeDateMainEl = dateWrap.createSpan({ cls: "planboard-home-date-main" });
		this.homeDateSubEl = dateWrap.createSpan({ cls: "planboard-home-date-sub" });
		this.goalListEl = goalCard.createDiv({ cls: "planboard-goal-strip" });
		this.goalEmptyEl = goalCard.createDiv({ cls: "planboard-empty", text: "年度计划未配置，请在「年度计划.md」frontmatter 定义 plans。" });

		// --- 2. 月/周任务卡 (grid, two columns) ---
		const taskGrid = panel.createDiv({ cls: "planboard-grid-2" });

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

		// --- 3. 今日打卡 + 今日总结 (grid, equal columns) ---
		const dailyGrid = panel.createDiv({ cls: "planboard-grid-2 planboard-daily-only" });

		const checkCard = dailyGrid.createDiv({ cls: "planboard-card planboard-check-card" });
		const checkHeader = checkCard.createDiv({ cls: "planboard-card-header" });
		const checkTitle = checkHeader.createDiv({ cls: "planboard-card-title planboard-check-title" });
		checkTitle.createSpan({ text: "✅ 今日打卡" });
		// v1.4: 进度数字内联到标题行（与月/周卡一致，省纵向空间）
		this.progressNumberEl = checkHeader.createSpan({ cls: "planboard-progress-number planboard-progress-number--inline" });
		this.streakEl = checkTitle.createSpan({ cls: "planboard-streak planboard-hidden" });
		// 今日打卡分档徽章（即时显示，不结算进徽章墙）
		this.todayBadgeEl = checkTitle.createSpan({ cls: "planboard-badge planboard-today-badge planboard-hidden" });
		const addBtn = checkHeader.createEl("button", { cls: "planboard-btn planboard-btn-outline planboard-add-btn", text: "+ 添加" });
		addBtn.addEventListener("click", () => this.openAddItemModal());
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
		// v1.4: 打卡自动生成区（完成/未完成/鼓励语，只读展示，不写文件）
		this.summaryAutoEl = summaryCard.createDiv({ cls: "planboard-summary-auto" });
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
		// 骨架重建后刷新日期行（refreshToday 的调用可能早于重建）
		this.updateHomeDate();
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
		item.createSpan({
			cls: "planboard-goal-name",
			// label 含名称时不重复拼接（"✍️ 写作"），纯 emoji/空时补上计划名
			text: prog.label && !prog.label.includes(prog.plan) ? `${prog.label} ${prog.plan}` : prog.label || prog.plan,
		});

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

	/** 🔥 连续打卡天数：从昨天往前数，每天全部打卡勾选才计一天。X=0 不显示。 */
	private async updateStreak(): Promise<void> {
		if (!this.streakEl) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const streak = await computeStreak(this.app, root, year, this.today);
		if (streak > 0) {
			this.streakEl.setText(`🔥 连续打卡 ${streak} 天`);
			this.streakEl.removeClass("planboard-hidden");
		} else {
			this.streakEl.setText("");
			this.streakEl.addClass("planboard-hidden");
		}
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

	private updateChecklist(): void {
		if (!this.dailyData || !this.checklistEl) return;
		this.checklistEl.empty();
		for (const item of this.dailyData.checkItems) {
			this.checklistEl.appendChild(this.renderCheckItem(item));
		}
	}

	private renderCheckItem(item: CheckItem): HTMLElement {
		const li = createEl("li", { cls: "planboard-check-item" + (item.checked ? " is-checked" : "") });
		li.setAttribute("data-line", String(item.line));

		const label = li.createEl("label", { cls: "planboard-check-label" });
		const cb = label.createEl("input", { type: "checkbox", cls: "planboard-checkbox" });
		cb.checked = item.checked;
		cb.addEventListener("change", () => void this.toggleCheckItem(item, cb.checked));
		label.createSpan({ cls: "planboard-check-text", text: item.text });
		if (item.plan) {
			const tag = label.createSpan({ cls: "planboard-plan-tag", text: item.plan });
			tag.setAttribute("data-plan", item.plan);
			this.applyPlanColor(tag, item.plan);
		}

		const actions = li.createDiv({ cls: "planboard-item-actions" });
		const upBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-move-btn", attr: { "aria-label": "上移", title: "上移" } });
		upBtn.setText("↑");
		upBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.moveCheckItem(item, -1);
		});
		const downBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-move-btn", attr: { "aria-label": "下移", title: "下移" } });
		downBtn.setText("↓");
		downBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.moveCheckItem(item, 1);
		});
		const delBtn = actions.createEl("button", { cls: "planboard-icon-btn planboard-del-btn", attr: { "aria-label": "删除", title: "删除" } });
		delBtn.setText("✕");
		delBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.deleteCheckItem(item);
		});

		return li;
	}

	private async toggleCheckItem(item: CheckItem, checked: boolean): Promise<void> {
		if (!this.dailyData) return;
		this.selfWrite = true;
		try {
			await this.app.vault.process(item.file, (data) => toggleTaskLine(data, item.line, checked, item.raw));
		} finally {
			this.selfWrite = false;
		}
		item.checked = checked;
		this.updateProgress();
		this.updateChecklist();
		this.updateSummary(); // 联动：总结区三行（✅/⬜/💪）随打卡实时刷新
	}

	private async moveCheckItem(item: CheckItem, delta: number): Promise<void> {
		if (!this.dailyData) return;
		this.selfWrite = true;
		let newContent: string;
		try {
			newContent = await this.app.vault.process(item.file, (data) => moveTaskLine(data, item.line, delta, item.raw));
		} finally {
			this.selfWrite = false;
		}
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
	}

	private async deleteCheckItem(item: CheckItem): Promise<void> {
		if (!this.dailyData) return;
		this.selfWrite = true;
		let newContent: string;
		try {
			newContent = await this.app.vault.process(item.file, (data) => removeLine(data, item.line, item.raw));
		} finally {
			this.selfWrite = false;
		}
		this.dailyData = parseDailyContent(item.file, newContent, this.today);
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
	}

	private async addCheckItem(line: string): Promise<void> {
		if (!this.dailyData) return;
		this.selfWrite = true;
		try {
			const newContent = await this.app.vault.process(this.dailyData.file, (data) => appendCheckItem(data, line));
			this.dailyData = parseDailyContent(this.dailyData.file, newContent, this.today);
		} finally {
			this.selfWrite = false;
		}
		this.updateChecklist();
		this.updateProgress();
		this.updateSummary();
	}

	// --- Summary -------------------------------------------------------------

	private updateSummary(): void {
		if (!this.dailyData || !this.summaryEl) return;
		// Don't clobber the textarea while the user is typing.
		if (document.activeElement === this.summaryEl) return;
		this.summaryEl.value = this.dailyData.summary;
		this.updateSummaryAuto();
	}

	/** v1.4: 打卡自动生成三行（✅完成数量 / ⬜未完成数量 / 💪鼓励语），只读展示不写文件。 */
	private updateSummaryAuto(): void {
		if (!this.summaryAutoEl || !this.dailyData) return;
		const checks = this.dailyData.checkItems;
		const done = checks.filter((c) => c.checked);
		const pending = checks.filter((c) => !c.checked);
		this.summaryAutoEl.empty();

		const total = checks.length;
		const doneLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-done" });
		doneLine.createSpan({ cls: "planboard-summary-auto-label", text: "✅ 已完成" });
		doneLine.createSpan({ cls: "planboard-summary-auto-text", text: `${done.length}/${total}` });

		const pendLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-pending" });
		pendLine.createSpan({ cls: "planboard-summary-auto-label", text: "⬜ 未完成" });
		pendLine.createSpan({ cls: "planboard-summary-auto-text", text: `${pending.length}/${total}` });

		const pct = total === 0 ? 0 : Math.round((done.length / total) * 100);
		let cheer: string;
		if (total === 0) cheer = "今天还没有打卡项，去添加一个吧";
		else if (pct === 100) cheer = "全勤达成！今天的你闪闪发光";
		else if (pct >= 80) cheer = `已完成 ${pct}%，快完成啦，再坚持一下！`;
		else if (pct >= 50) cheer = `已完成 ${pct}%，势头不错，继续冲！`;
		else if (pct > 0) cheer = `已完成 ${pct}%，加油突破，动起来！`;
		else cheer = "今天还没开始打卡哦，从第一项开始吧";
		const cheerLine = this.summaryAutoEl.createDiv({ cls: "planboard-summary-auto-line is-cheer" });
		cheerLine.createSpan({ cls: "planboard-summary-auto-label", text: "💪" });
		cheerLine.createSpan({ cls: "planboard-summary-auto-text", text: cheer });
	}

	private async saveSummary(): Promise<void> {
		if (!this.dailyData || !this.summaryEl) return;
		const value = this.summaryEl.value;
		if (value === this.dailyData.summary) return;
		this.selfWrite = true;
		try {
			await this.app.vault.process(this.dailyData.file, (data) => replaceSummary(data, value));
		} finally {
			this.selfWrite = false;
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
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const dir = `${root}/${this.today.slice(0, 4)}/每日`;
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
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const dir = `${root}/${this.today.slice(0, 4)}/每日`;
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
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const dir = `${root}/${this.today.slice(0, 4)}/每日`;
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
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const filePath = `${root}/复盘模板.md`;
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

	private openAddItemModal(): void {
		new AddCheckItemModal(this.app, this.plugin, this.today, (line) => void this.addCheckItem(line)).open();
	}

	// -------------------------------------------------------------------------
	// Task pool CRUD (M2)
	// -------------------------------------------------------------------------

	private async openTaskModal(task: PoolTask | null, defaults?: TaskDefaults): Promise<void> {
		const plans = await this.getTaskPlanOptions();
		new TaskModal(this.app, this.plugin, task, plans, defaults ?? {}, (input) => void this.saveTask(task, input)).open();
	}

	/** Plan options for the task modal: annual plans + defaults + daily templates. */
	private async getTaskPlanOptions(): Promise<string[]> {
		const plans = new Set<string>();
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const defs = await this.readAnnualPlanDefs(root, year);
		if (defs) {
			for (const def of defs) plans.add(def.name);
		}
		for (const p of Object.keys(DEFAULT_PLAN_COLORS)) plans.add(p);
		return Array.from(plans);
	}

	private async saveTask(existing: PoolTask | null, input: NewTaskInput): Promise<void> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		this.selfWrite = true;
		try {
			if (existing) {
				await editTask(this.app, existing, input);
			} else {
				await addTask(this.app, root, year, input);
			}
		} finally {
			this.selfWrite = false;
		}
		new Notice(existing ? "任务已更新" : "任务已添加");
		await this.refresh();
	}

	private async togglePoolTask(task: PoolTask, checked: boolean): Promise<void> {
		this.selfWrite = true;
		try {
			await toggleTask(this.app, task, checked);
		} finally {
			this.selfWrite = false;
		}
		await this.refresh();
	}

	private async deletePoolTask(task: PoolTask): Promise<void> {
		this.selfWrite = true;
		try {
			await deleteTask(this.app, task);
		} finally {
			this.selfWrite = false;
		}
		new Notice("任务已删除");
		await this.refresh();
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
		}
		const dates: string[] = [];
		if (task.start) dates.push(`🛫 ${task.start}`);
		if (task.due) dates.push(`📅 ${task.due}`);
		if (dates.length > 0) {
			meta.createSpan({ cls: "planboard-task-dates", text: dates.join("  ") });
		}
		// Clicking the text (not the checkbox) opens the edit modal.
		label.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).tagName === "INPUT") return;
			e.preventDefault();
			void this.openTaskModal(task);
		});

		const actions = li.createDiv({ cls: "planboard-item-actions" });
		const editBtn = actions.createEl("button", {
			cls: "planboard-icon-btn",
			attr: { "aria-label": "编辑", title: "编辑" },
		});
		editBtn.setText("✏️");
		editBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.openTaskModal(task);
		});
		const delBtn = actions.createEl("button", {
			cls: "planboard-icon-btn planboard-del-btn",
			attr: { "aria-label": "删除", title: "删除" },
		});
		delBtn.setText("✕");
		delBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.deletePoolTask(task);
		});

		return li;
	}

	// -------------------------------------------------------------------------
	// Board view (M3 + v1.3): category columns (all plans) or status columns
	// -------------------------------------------------------------------------

	private async renderBoardPanel(): Promise<void> {
		if (!this.panelEl) return;
		const panel = this.panelEl;
		panel.empty();
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);

		const header = panel.createDiv({ cls: "planboard-period-header" });
		header.createDiv({ cls: "planboard-period-title", text: "📋 任务看板" });
		header.createDiv({
			cls: "planboard-period-label",
			text: `${year} · ${this.boardMode === "category" ? "按计划分组" : "按状态分组"} · 共 ${tasks.length} 个任务`,
		});

		const subtabs = panel.createDiv({ cls: "planboard-subtabs" });
		const modes: Array<{ key: "category" | "status"; label: string }> = [
			{ key: "category", label: "分类" },
			{ key: "status", label: "状态" },
		];
		for (const m of modes) {
			const btn = subtabs.createEl("button", {
				cls: "planboard-subtab" + (this.boardMode === m.key ? " is-active" : ""),
				text: m.label,
			});
			btn.addEventListener("click", () => {
				this.boardMode = m.key;
				void this.refresh();
			});
		}

		if (this.boardMode === "category") {
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
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
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
			panel.createDiv({ cls: "planboard-empty", text: "任务池为空 · 在今日/本周/本月视图新建任务" });
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
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);

		const header = panel.createDiv({ cls: "planboard-period-header" });
		header.createDiv({ cls: "planboard-period-title", text: "📊 甘特图" });
		header.createDiv({ cls: "planboard-period-label", text: `${this.ganttRangeLabel()} · 任务时间条` });

		const subtabs = panel.createDiv({ cls: "planboard-subtabs" });
		const modes: Array<{ key: "week" | "month" | "year"; label: string }> = [
			{ key: "week", label: "本周" },
			{ key: "month", label: "本月" },
			{ key: "year", label: "本年" },
		];
		for (const m of modes) {
			const btn = subtabs.createEl("button", {
				cls: "planboard-subtab" + (this.ganttMode === m.key ? " is-active" : ""),
				text: m.label,
			});
			btn.addEventListener("click", () => {
				this.ganttMode = m.key;
				void this.refresh();
			});
		}

		if (this.ganttMode === "week") this.renderGanttWeek(panel, tasks);
		else if (this.ganttMode === "month") this.renderGanttMonth(panel, tasks);
		else this.renderGanttYear(panel, tasks);
		// Drag write-back needs the full task list (bars carry pool line numbers).
		this.ganttBarTasks = tasks;
	}

	/** Range label for the current gantt sub-mode (e.g. "2026-08-10 ~ 2026-08-16"). */
	private ganttRangeLabel(): string {
		if (this.ganttMode === "week") {
			const { start, end } = weekRange(this.today);
			return `${start} ~ ${end}`;
		}
		if (this.ganttMode === "month") return this.today.slice(0, 7);
		return this.today.slice(0, 4);
	}

	/** A task's effective window (🛫 ~ 📅); at least one date is guaranteed. */
	private taskWindow(t: PoolTask): { start: string; end: string } {
		return { start: t.start ?? t.due!, end: t.due ?? t.start! };
	}

	/** Day-of-week index (Monday=1 … Sunday=7) for an ISO date. */
	private dayOfWeek(date: string): number {
		return parseDateString(date).getDay() || 7;
	}

	/**
	 * Intersect a task's window with [start, end] and map it onto a 1..N axis
	 * via `unit` (day-of-month for week/month, month number for year). This is
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
	private renderGanttBar(track: HTMLElement, t: PoolTask, s: number, e: number, n: number): void {
		const bar = track.createDiv({ cls: "planboard-gantt-bar" + (t.checked ? " is-done" : "") });
		if (t.plan) {
			bar.setAttribute("data-plan", t.plan);
			this.applyPlanColor(bar, t.plan);
		}
		bar.setAttribute("data-line", String(t.line));
		bar.setAttribute("data-start", t.start ?? "");
		bar.setAttribute("data-due", t.due ?? "");
		bar.setAttribute("data-axis", this.ganttMode);
		bar.style.left = `${((s - 1) / n) * 100}%`;
		bar.style.width = `${Math.max(((e - s + 1) / n) * 100, 1.2)}%`;
		bar.createDiv({ cls: "planboard-gantt-handle is-left" });
		bar.createDiv({ cls: "planboard-gantt-handle is-right" });
		bar.setAttribute("title", `${t.text}${t.checked ? " ✓" : ""}`);
	}

	/** Shared "🗂️ 未排期任务" card below the chart. */
	private renderUnscheduled(panel: HTMLElement, tasks: PoolTask[]): void {
		if (tasks.length === 0) return;
		const uCard = panel.createDiv({ cls: "planboard-card" });
		const uHeader = uCard.createDiv({ cls: "planboard-card-header" });
		uHeader.createDiv({ cls: "planboard-card-title", text: "🗂️ 未排期任务" });
		for (const t of tasks) uCard.appendChild(this.renderTaskItem(t));
	}

	/** Week axis: 周一~周日 (7 cells), today highlighted. */
	private renderGanttWeek(panel: HTMLElement, tasks: PoolTask[]): void {
		const { start: weekStart, end: weekEnd } = weekRange(this.today);
		const inWindow = filterTasksInRange(tasks, weekStart, weekEnd);
		const unscheduled = tasks.filter((t) => !t.start && !t.due);

		const chart = panel.createDiv({ cls: "planboard-gantt" });

		const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
		const todayIndex = this.dayOfWeek(this.today);
		const axisRow = chart.createDiv({ cls: "planboard-gantt-axis" });
		for (let d = 1; d <= 7; d++) {
			const cell = axisRow.createDiv({
				cls: "planboard-gantt-axis-cell" + (d === todayIndex ? " is-today" : ""),
				text: weekdays[d - 1],
			});
			cell.style.width = `${100 / 7}%`;
		}

		if (inWindow.length === 0) {
			chart.createDiv({ cls: "planboard-empty", text: "本周没有带日期的任务" });
		}
		for (const t of inWindow) {
			const row = chart.createDiv({ cls: "planboard-gantt-row" });
			const label = row.createDiv({ cls: "planboard-gantt-label", text: t.text.slice(0, 14), attr: { title: t.text } });
			if (t.plan) label.setAttribute("data-plan", t.plan);
			const track = row.createDiv({ cls: "planboard-gantt-track" });

			const todayMark = track.createDiv({ cls: "planboard-gantt-today" });
			todayMark.style.left = `${((todayIndex - 1) / 7) * 100}%`;

			const { s, e } = this.ganttBarRange(t, weekStart, weekEnd, (d) => this.dayOfWeek(d));
			this.renderGanttBar(track, t, s, e, 7);
		}

		this.renderUnscheduled(panel, unscheduled);
	}

	/** Month axis: day-of-month cells (labels every 5th), today highlighted. */
	private renderGanttMonth(panel: HTMLElement, tasks: PoolTask[]): void {
		const [y, mo] = this.today.split("-").map(Number);
		const dim = daysInMonth(y, mo);
		const monthStart = `${this.today.slice(0, 7)}-01`;
		const monthEnd = `${this.today.slice(0, 7)}-${String(dim).padStart(2, "0")}`;
		const todayDay = Number(this.today.slice(8, 10));
		const inWindow = filterTasksInRange(tasks, monthStart, monthEnd);
		const unscheduled = tasks.filter((t) => !t.start && !t.due);

		const chart = panel.createDiv({ cls: "planboard-gantt" });

		const axisRow = chart.createDiv({ cls: "planboard-gantt-axis" });
		for (let d = 1; d <= dim; d++) {
			const cell = axisRow.createDiv({
				cls: "planboard-gantt-axis-cell" + (d === todayDay ? " is-today" : ""),
				// 隔天标一个数字（1/3/5/…），月末必标——拖拽对位更细
				text: d % 2 === 1 || d === dim ? String(d) : "",
			});
			cell.style.width = `${100 / dim}%`;
		}

		if (inWindow.length === 0) {
			chart.createDiv({ cls: "planboard-empty", text: "本月没有带日期的任务" });
		}
		for (const t of inWindow) {
			const row = chart.createDiv({ cls: "planboard-gantt-row" });
			const label = row.createDiv({ cls: "planboard-gantt-label", text: t.text.slice(0, 14), attr: { title: t.text } });
			if (t.plan) label.setAttribute("data-plan", t.plan);
			const track = row.createDiv({ cls: "planboard-gantt-track" });

			const todayMark = track.createDiv({ cls: "planboard-gantt-today" });
			todayMark.style.left = `${((todayDay - 1) / dim) * 100}%`;

			const { s, e } = this.ganttBarRange(t, monthStart, monthEnd, (d) => Number(d.slice(8, 10)));
			this.renderGanttBar(track, t, s, e, dim);
		}

		this.renderUnscheduled(panel, unscheduled);
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

		const chart = panel.createDiv({ cls: "planboard-gantt" });

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
			if (t.plan) label.setAttribute("data-plan", t.plan);
			const track = row.createDiv({ cls: "planboard-gantt-track" });

			const todayMark = track.createDiv({ cls: "planboard-gantt-today" });
			// v1.5: 今日线按天索引定位（与条同坐标系）
			todayMark.style.left = `${((dayIndexOf(this.today, yearStart) - 1) / totalDays) * 100}%`;

			// v1.5: 年视图条用天粒度（轴仍为 12 月格）——首尾相接的跨度任务不再重叠
			const { s, e } = this.ganttBarRange(t, yearStart, yearEnd, (d) => dayIndexOf(d, yearStart));
			this.renderGanttBar(track, t, s, e, totalDays);
		}

		this.renderUnscheduled(panel, unscheduled);
	}

	// -------------------------------------------------------------------------
	// Period panels (week / month / year)
	// -------------------------------------------------------------------------

	private async refreshPeriod(type: PeriodType): Promise<void> {
		this.panelEl?.empty();
		this.currentPanel = type;
		const stats = await computePeriodStats(
			this.app,
			this.plugin.settings.rootPath,
			this.today,
			type,
			this.plugin.settings.reviewWorkdays
		);
		await this.settleIfNeeded(stats);
		await this.renderPeriodPanel(stats);
	}

	/**
	 * 周/月徽章结算（reward v3）：只在有任务数据时结算，成就.md 仅由
	 * settleWeek/settleMonth 写入（幂等，该周期已记录不重复写）。
	 */
	private async settleIfNeeded(stats: PeriodStats): Promise<void> {
		if (stats.type !== "week" && stats.type !== "month") return;
		if (stats.taskDone <= 0 || stats.taskTotal <= 0) return;
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = stats.label.slice(0, 4);
		this.selfWrite = true;
		try {
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
		} finally {
			this.selfWrite = false;
		}
	}

	private async renderPeriodPanel(stats: PeriodStats): Promise<void> {
		if (!this.panelEl) return;
		const panel = this.panelEl;

		const header = panel.createDiv({ cls: "planboard-period-header" });
		header.createDiv({ cls: "planboard-period-title", text: PERIOD_TITLES[stats.type] });
		header.createDiv({ cls: "planboard-period-label", text: `${stats.label} · ${stats.rangeLabel}` });
		// --- 本周/本月徽章墙（reward v3.1：层级递进） ---
		if (stats.type === "week" || stats.type === "month") {
			const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
			const badges =
				stats.type === "week"
					? await readPeriodBadges(this.app, root, stats.label.slice(0, 4), stats.label)
					: await readMonthBadges(this.app, root, stats.label.slice(0, 4), stats.label);
			const wallCard = panel.createDiv({ cls: "planboard-card planboard-period-wall" });
			const wallHeader = wallCard.createDiv({ cls: "planboard-card-header" });
			wallHeader.createDiv({ cls: "planboard-card-title", text: stats.type === "week" ? "🏆 本周徽章墙" : "🏆 本月徽章墙" });
			if (badges.length > 0) {
				const row = wallCard.createDiv({ cls: "planboard-period-wall-row" });
				for (const b of badges) {
					const cls = b.includes("🥇") ? "is-gold" : b.includes("🥈") ? "is-silver" : "is-bronze";
					const span = row.createSpan({ cls: `planboard-badge ${cls}` });
					// v1.6: emoji 单独放大 + 去掉「（任务）/（打卡）」来源后缀
					const text = b.slice(2).replace(/（[^）]*）$/, "").trim();
					setBadgeContent(span, b.slice(0, 2), text);
				}
			} else {
				wallCard.createDiv({
					cls: "planboard-badge-wall-empty",
					text: "暂无徽章 · 本周任务完成 60%+ / 每日打卡 60%+ 即可获得",
				});
			}
		}

		if (stats.type === "year") {
			await this.renderYearPanel(panel, stats);
			return;
		}

		// --- 计划打卡率（v1.6: 2 列 grid 分栏；临时任务/任务统计卡已删除——信息在下方任务列表卡冗余） ---
		const grid = panel.createDiv({ cls: "planboard-plan-grid" });
		// v2.6: 过滤孤儿计划（历史打卡残留但当前已无定义的计划不显示，避免孤立卡无法管理）
		// v2.7: "当前计划" = 年度计划 frontmatter 里的计划（dailyTemplates 已废除，改为数据联动）
		const rootPath0 = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const defs = (await this.readAnnualPlanDefs(rootPath0, stats.label.slice(0, 4))) ?? [];
		const knownPlans = new Set(defs.map((d) => d.name));
		const liveRates = stats.planRates.filter((r) => knownPlans.has(r.plan));
		if (liveRates.length === 0) {
			grid.createDiv({ cls: "planboard-card planboard-empty-card", text: "周期内暂无打卡数据" });
		}
		const rates = [...liveRates].sort((a, b) => this.orderIndexOf(a.plan) - this.orderIndexOf(b.plan));
		for (const rate of rates) {
			const card = this.renderPlanRateCard(rate);
			grid.appendChild(card);
			this.attachPlanSortTo(card, grid, rate.plan);
		}

		const isWeek = stats.type === "week";
		const listCard = panel.createDiv({ cls: "planboard-card planboard-tasks-card" });
		const listHeader = listCard.createDiv({ cls: "planboard-card-header" });
		listHeader.createDiv({ cls: "planboard-card-title", text: isWeek ? "本周任务" : "本月任务" });
		const newBtn = listHeader.createEl("button", { cls: "planboard-btn planboard-btn-primary planboard-add-btn", text: "+ 新建任务" });
		newBtn.addEventListener("click", () => void this.openTaskModal(null));
		if (stats.tasks.length === 0) {
			listCard.createDiv({ cls: "planboard-empty", text: isWeek ? "本周暂无任务" : "本月暂无任务" });
		} else {
			const ul = listCard.createEl("ul", { cls: "planboard-checklist" });
			for (const t of stats.tasks) ul.appendChild(this.renderTaskItem(t));
		}
	}

	/** Year view: badge wall + plan detail cards (target + progress + the plan's task list). */
	private async renderYearPanel(panel: HTMLElement, stats: PeriodStats): Promise<void> {
		// v1.6: 「＋ 新增计划」按钮并入 period header（标题/日期同一行右侧）。
		const addPlanBtn = panel.createEl("button", {
			cls: "planboard-btn planboard-btn-outline planboard-year-add-btn",
			text: "＋ 新增计划",
		});
		addPlanBtn.addEventListener("click", () => void this.openPlanModal(null));
		const header = panel.querySelector<HTMLElement>(".planboard-period-header");
		if (header) {
			header.appendChild(addPlanBtn);
		} else {
			panel.appendChild(addPlanBtn);
		}

		// 徽章墙（reward v3）：计数从成就.md 读取。空状态也显示（引导用户）。
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const counts = await badgeCounts(this.app, root, stats.label);
		const totalBadges = counts.gold + counts.silver + counts.bronze;
		{
				// v1.6: 年度徽章墙与周/月同款卡片容器（宽度/样式一致）
				const wall = panel.createDiv({ cls: "planboard-card planboard-period-wall" });
				const wallHeader = wall.createDiv({ cls: "planboard-card-header" });
				wallHeader.createDiv({ cls: "planboard-card-title", text: "🏆 徽章墙" });
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
		if (stats.planProgress.length === 0) {
			panel.createDiv({
				cls: "planboard-card planboard-empty-card",
				text: "年度计划未配置，请在「年度计划.md」frontmatter 定义 plans。",
			});
		}
		// v1.7.4: 年度计划卡 JS 显式两列容器（替代 CSS columns——拖放精确：列内/跨列任意插入，
		//   不再受 columns 列平衡牵连；保留卡高自由）
		const grid = panel.createDiv({ cls: "planboard-plan-grid is-masonry" });
		const cols = [grid.createDiv({ cls: "planboard-plan-col" }), grid.createDiv({ cls: "planboard-plan-col" })];
		const progs = [...stats.planProgress].sort((a, b) => this.orderIndexOf(a.plan) - this.orderIndexOf(b.plan));
		const colH = [0, 0]; // 贪心分列：每次放进较矮列（含 saved 高度）
		for (const prog of progs) {
			const card = this.renderYearPlanCard(prog);
			// v1.7.2: 卡下边缘拖拽调整高度（每卡独立持久化）
			// v1.7.4: 任意保存值生效（含小于内容的——任务列表滚动承接，见 styles.css）
			const saved = this.plugin.settings.yearPlanHeights[prog.plan] ?? 0;
			if (saved > 0) card.style.height = `${saved}px`;
			const idx = colH[0] <= colH[1] ? 0 : 1;
			cols[idx].appendChild(card);
			colH[idx] += card.offsetHeight + 12; // 12 = 列内 gap
			this.attachPlanSortTo(card, grid, prog.plan, cols);
			attachResizeHandle(card, card, this.plugin, "yearPlanHeights", undefined, prog.plan);
		}

		// v1.6: 打卡统计卡整行展示（内部按计划分栏）
		const checkCard = panel.createDiv({ cls: "planboard-card planboard-plan-card" });
		checkCard.createDiv({ cls: "planboard-card-title", text: "打卡统计" });
		// v2.6: 只显示当前年度计划里存在的计划（过滤历史打卡残留的孤儿计划，如测试数据）
		const liveRates = stats.planRates.filter((r) => stats.planProgress.some((p) => p.plan === r.plan));
		if (liveRates.length === 0) {
			checkCard.createDiv({ cls: "planboard-empty", text: "暂无打卡数据" });
		} else {
			const statsGrid = checkCard.createDiv({ cls: "planboard-check-stats-grid" });
			for (const rate of liveRates) {
				const row = statsGrid.createDiv({ cls: "planboard-goal-row" });
				const head = row.createDiv({ cls: "planboard-goal-head" });
				head.createSpan({ cls: "planboard-plan-name", text: rate.plan });
				head.createSpan({ cls: "planboard-goal-target", text: `${rate.done}/${rate.total} 天` });
				const bar = row.createDiv({ cls: "planboard-progress-bar" });
				const fill = bar.createDiv({ cls: "planboard-progress-fill" });
				fill.style.width = `${rate.percent}%`;
				row.createDiv({ cls: "planboard-goal-meta", text: `${rate.percent}%` });
			}
		}
	}

	private renderYearPlanCard(prog: PlanProgress): HTMLElement {
		if (!this.panelEl) return createDiv();
		const card = this.panelEl.createDiv({ cls: "planboard-card planboard-plan-card" });
		card.setAttribute("data-plan-name", prog.plan);
		this.applyPlanColor(card, prog.plan);

		// 卡头：名称 + [＋ 新增量化目标]；计划编辑/删除移入右键菜单（v1.7.4，与"编辑用右键"标准一致）
		const head = card.createDiv({ cls: "planboard-plan-head" });
		head.createSpan({ cls: "planboard-plan-name", text: prog.label ? `${prog.label} ${prog.plan}` : prog.plan });
		head.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((item) => item.setTitle("编辑计划").setIcon("pencil").onClick(() => void this.openPlanModal(toPlanDef(prog))));
			menu.addItem((item) => item.setTitle("删除计划").setIcon("trash").onClick(() => void this.deletePlan(prog)));
			menu.showAtMouseEvent(e);
		});
		const headActions = head.createDiv({ cls: "planboard-head-actions" });
		const goalBtn = headActions.createEl("button", {
			cls: "planboard-btn planboard-btn-outline planboard-goal-add-btn",
			attr: { "aria-label": "新增量化目标", title: "新增量化目标" },
		});
		goalBtn.setText("＋ 新增量化目标");
		goalBtn.addEventListener("click", () => void this.openGoalModal(prog.plan, null));

		if (prog.target) card.createDiv({ cls: "planboard-plan-target-line", text: prog.target });

		const bar = card.createDiv({ cls: "planboard-progress-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${prog.percent}%`;
		setTier(fill, prog.percent);

		const meta = card.createDiv({ cls: "planboard-goal-meta" });
		if (prog.isNumeric) {
			meta.setText(`已完成 ${prog.doneCount}/${prog.targetCount} · ${prog.percent}%`);
		} else {
			meta.setText(`打卡率 ${prog.checkDone}/${prog.checkTotal} 天 · ${prog.percent}%`);
		}

		// 量化目标区（仅数量型且有 goals 的计划；打卡型不显示）。
		if (prog.isNumeric && prog.goals.length > 0) {
			const goalsBox = card.createDiv({ cls: "planboard-goals-box" });
			goalsBox.createDiv({ cls: "planboard-goals-title", text: "🎯 量化目标" });
			for (const goal of prog.goals) {
				goalsBox.appendChild(this.renderYearGoalRow(goal, prog));
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

	/** One quantified-goal row inside the year plan card: name + count + mini bar + [✏️][🗑️]. */
	private renderYearGoalRow(goal: PlanGoalProgress, prog: PlanProgress): HTMLElement {
		const row = createDiv({ cls: "planboard-goal-row planboard-goal-row--mini" });
		row.createDiv({ cls: "planboard-goal-name", text: goal.name });
		row.createDiv({ cls: "planboard-goal-count", text: `${goal.done}/${goal.count} ${goal.unit || "个"}` });
		const bar = row.createDiv({ cls: "planboard-goal-bar" });
		const fill = bar.createDiv({ cls: "planboard-progress-fill" });
		fill.style.width = `${goal.percent}%`;
		setTier(fill, goal.percent);
		const actions = row.createDiv({ cls: "planboard-item-actions planboard-goal-actions" });
		const editBtn = actions.createEl("button", {
			cls: "planboard-icon-btn",
			attr: { "aria-label": "编辑目标", title: "编辑目标" },
		});
		editBtn.setText("✏️");
		editBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.openGoalModal(prog.plan, goal);
		});
		const delBtn = actions.createEl("button", {
			cls: "planboard-icon-btn planboard-del-btn",
			attr: { "aria-label": "删除目标", title: "删除目标" },
		});
		delBtn.setText("🗑️");
		delBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.deleteGoal(prog, goal);
		});
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
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		for (const path of [`${root}/${year}/年度计划.md`, `${root}/年度计划.md`]) {
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
		new PlanEditModal(this.app, plan, daily, (input) => this.savePlan(plan, input)).open();
	}

	private async openGoalModal(planName: string, goal: PlanGoal | null): Promise<void> {
		new GoalEditModal(this.app, planName, goal, (input) => this.saveGoal(planName, goal, input)).open();
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
			def.action = input.action;
			def.target = input.target;
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
				target: input.target,
				targetCount: 0,
				goals: [],
				action: input.action,
				label: input.label,
				color: input.color || rotatePlanColor(defs),
				tradingDay: false,
				daily: input.daily,
			});
			dailyMap[input.name] = input.daily;
		}

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, dailyMap);
			// 大类改名联动：任务池 + 每日笔记的 #计划/{旧名} → #计划/{新名}（防前缀误伤，跨年一致）
			if (existing && input.name !== existing.name) {
				const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
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
				const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
				const todayPath = `${root}/${this.today.slice(0, 4)}/每日/${this.today}.md`;
				const todayFile = this.app.vault.getAbstractFileByPath(todayPath);
				if (todayFile instanceof TFile) {
					const todayContent = await this.app.vault.cachedRead(todayFile);
					if (!todayContent.includes(`#计划/${input.name}`)) {
						const line = buildCheckLine({
							name: input.label || input.name,
							duration: input.action,
							plan: input.name,
							includeReview: false,
							date: this.today,
						});
						await this.app.vault.process(todayFile, (data) => appendCheckItem(data, line));
					}
				}
			}
		} finally {
			this.selfWrite = false;
		}
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
				const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
				const year = this.today.slice(0, 4);
				const pool = this.app.vault.getAbstractFileByPath(`${root}/${year}/任务.md`);
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

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
		} finally {
			this.selfWrite = false;
		}
		new Notice("量化目标已保存");
		// v1.5 联动 + 修复：编辑目标后重建分解任务；【新建目标同样触发分解】（此前新建只写文件不生成任务）
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const pool = this.app.vault.getAbstractFileByPath(`${root}/${year}/任务.md`);
		if (existing) {
			if (pool instanceof TFile) {
				const prefix = `${existing.name}（`;
				this.selfWrite = true;
				try {
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
				} finally {
					this.selfWrite = false;
				}
			}
			await this.ensureAutoTasksForToday(root, year);
			new Notice("目标已更新，分解任务已按新设置重建");
		} else {
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

		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		const toDelete = tasks.filter((t) => t.plan === prog.plan).sort((a, b) => b.line - a.line);

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, dailyMap);
			for (const t of toDelete) await deleteTask(this.app, t);
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
		} finally {
			this.selfWrite = false;
		}
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

		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
		const year = this.today.slice(0, 4);
		const tasks = await listTasks(this.app, root, year);
		const prefix = `${goal.name}（`;
		const toDelete = tasks
			.filter((t) => t.plan === prog.plan && t.text.trim().startsWith(prefix))
			.sort((a, b) => b.line - a.line);

		this.selfWrite = true;
		try {
			await writePlansToFile(this.app, file, defs, this.readRawDailyMap(content));
			for (const t of toDelete) await deleteTask(this.app, t);
		} finally {
			this.selfWrite = false;
		}
		new Notice("量化目标已删除");
		await this.refresh();
	}

	/** Whether the pool already has auto tasks named `{goal.name}（第 N …」. */
	private async goalHasDecomposedTasks(planName: string, goalName: string): Promise<boolean> {
		const root = this.plugin.settings.rootPath.replace(/\/+$/, "");
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
		const rootPath = this.plugin.settings.rootPath.replace(/\/+$/, "");
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
			const barBg = hexToRgba(color, 0.55);
			this.planColorVars[plan] = {
				"--pb-accent": color,
				"--pb-accent-bg": bg,
				"--pb-accent-dim": hexToRgba(color, 0.28),
				"--plan-tag-color": color,
				"--plan-tag-bg": bg,
				"--plan-gantt-bg": barBg,
				"--plan-gantt-border": color,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarize(tasks: PoolTask[]): { total: number; done: number; percent: number } {
	const total = tasks.length;
	const done = tasks.filter((t) => t.checked).length;
	return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Derive a task's status column (spec v1.3). Undated, unchecked tasks → "todo". */
function taskStatus(t: PoolTask, today: string): "todo" | "doing" | "done" {
	if (t.checked) return "done";
	if (t.start && today >= t.start && (!t.due || today <= t.due)) return "doing";
	return "todo";
}

/** Sort pool tasks by due date ascending; completed tasks sink to the bottom. */
function sortTasksByDue(tasks: PoolTask[]): PoolTask[] {
	return [...tasks].sort((a, b) => {
		if (a.checked !== b.checked) return a.checked ? 1 : -1;
		const ad = a.due ?? "9999-12-31";
		const bd = b.due ?? "9999-12-31";
		return ad < bd ? -1 : ad > bd ? 1 : 0;
	});
}

/** Modal for adding a check-in item (PRD §4). */
class AddCheckItemModal extends Modal {
	private plugin: PlanBoardPlugin;
	private today: string;
	private onSubmit: (line: string) => void;
	private nameEl!: HTMLInputElement;
	private durationEl!: HTMLInputElement;
	private planEl!: HTMLSelectElement;
	private reviewEl!: HTMLInputElement;

	constructor(app: App, plugin: PlanBoardPlugin, today: string, onSubmit: (line: string) => void) {
		super(app);
		this.plugin = plugin;
		this.today = today;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: "添加打卡项" });

		new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：阅读 30 分钟");
		});

		new Setting(contentEl).setName("计划").addDropdown((dropdown) => {
			this.planEl = dropdown.selectEl;
			const options = this.getPlanOptions();
			for (const plan of options) dropdown.addOption(plan, plan);
			dropdown.setValue(options[0]);
		});

		new Setting(contentEl).setName("时长").addText((text) => {
			this.durationEl = text.inputEl;
			text.setPlaceholder("例如：1小时");
		});

		new Setting(contentEl).setName("含复盘链接").addToggle((toggle) => {
			// Obsidian's typings type toggleEl as HTMLElement; at runtime it is an input.
			this.reviewEl = toggle.toggleEl as HTMLInputElement;
		});

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());

		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "添加" });
		ok.addEventListener("click", () => {
			const name = this.nameEl.value.trim();
			if (!name) {
				new Notice("请输入打卡名称");
				return;
			}
			const line = buildCheckLine({
				name,
				duration: this.durationEl.value.trim(),
				plan: this.planEl.value,
				includeReview: this.reviewEl.checked,
				date: this.today,
			});
			this.onSubmit(line);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private getPlanOptions(): string[] {
		const plans = new Set<string>(Object.keys(DEFAULT_PLAN_COLORS));
		return Array.from(plans);
	}
}

/** Modal for creating / editing a pool task (M2). */
class TaskModal extends Modal {
	private plugin: PlanBoardPlugin;
	private existing: PoolTask | null;
	private planOptions: string[];
	private defaults: TaskDefaults;
	private onSubmit: (input: NewTaskInput) => void;
	private textEl!: HTMLTextAreaElement;
	private planEl!: HTMLSelectElement;
	private startEl!: HTMLInputElement;
	private dueEl!: HTMLInputElement;

	constructor(
		app: App,
		plugin: PlanBoardPlugin,
		existing: PoolTask | null,
		planOptions: string[],
		defaults: TaskDefaults,
		onSubmit: (input: NewTaskInput) => void
	) {
		super(app);
		this.plugin = plugin;
		this.existing = existing;
		this.planOptions = planOptions;
		this.defaults = defaults;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: this.existing ? "编辑任务" : "新建任务" });

		new Setting(contentEl).setName("任务内容").addTextArea((ta) => {
			this.textEl = ta.inputEl;
			ta.setPlaceholder("例如：完成《霍去病》文章");
		});

		new Setting(contentEl).setName("关联计划").addDropdown((dropdown) => {
			this.planEl = dropdown.selectEl;
			dropdown.addOption("", "（不关联）");
			for (const plan of this.planOptions) dropdown.addOption(plan, plan);
		});

		new Setting(contentEl).setName("🛫 开始日期").addText((text) => {
			this.startEl = text.inputEl;
			this.startEl.type = "date";
			text.setPlaceholder("2026-08-10");
		});

		new Setting(contentEl).setName("📅 截止日期").addText((text) => {
			this.dueEl = text.inputEl;
			this.dueEl.type = "date";
			text.setPlaceholder("2026-08-16");
		});

		this.textEl.value = this.existing?.text ?? "";
		this.planEl.value = this.existing?.plan ?? this.defaults.plan ?? "";
		this.startEl.value = this.existing?.start ?? this.defaults.start ?? "";
		this.dueEl.value = this.existing?.due ?? this.defaults.due ?? "";

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());

		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => {
			const text = this.textEl.value.trim();
			if (!text) {
				new Notice("请输入任务内容");
				return;
			}
			this.onSubmit({
				text,
				plan: this.planEl.value || null,
				start: this.startEl.value || null,
				due: this.dueEl.value || null,
			});
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Modal for creating / editing a plan category (v1.2, spec #4). */
class PlanEditModal extends Modal {
	private existing: PlanDef | null;
	private daily: boolean;
	private onSubmit: (input: PlanEditInput) => Promise<boolean>;
	private nameEl!: HTMLInputElement;
	private labelEl!: HTMLInputElement;
	private actionEl!: HTMLInputElement;
	private targetEl!: HTMLTextAreaElement;
	private colorEl!: HTMLSelectElement;

	private dailyVal = true;
	/** emoji 选择浮层的点击外关闭监听与清理（v2.4.1）。 */
	private emojiPopDocDown: ((e: PointerEvent) => void) | null = null;
	private emojiClosePop: (() => void) | null = null;

	constructor(
		app: App,
		existing: PlanDef | null,
		daily: boolean,
		onSubmit: (input: PlanEditInput) => Promise<boolean>
	) {
		super(app);
		this.existing = existing;
		this.daily = daily;
		this.dailyVal = daily;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: this.existing ? "编辑大类" : "新增大类" });

		new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：写作");
		});
		// v2.4: 图标字段 emoji 选择器（v2.4.1 改浮动弹层——点「选择…」在按钮旁弹出，不占 Modal 空间）
		const EMOJI_GROUPS: [string, string[]][] = [
			["运动", ["🏃", "🚶", "💪", "🏋️", "🧘", "⚽", "🏀", "🚴", "🏊", "🥾", "🎾", "⛰️"]],
			["学习", ["📖", "📚", "✍️", "🖋️", "🎓", "💡", "🧠", "🔬", "📝", "🗣️", "🎵", "📐"]],
			["健康", ["🥗", "🍎", "💊", "🩺", "😴", "🛌", "🌿", "💧", "🏥", "🥦", "🍵", "🧖"]],
			["工作", ["💼", "🖥️", "⌨️", "📈", "🗂️", "📊", "💻", "✉️", "🤝", "📅", "🛠️", "⚙️"]],
			["其他", ["🎯", "⭐", "🔥", "🎨", "📷", "🌱", "✨", "❤️", "🆕", "🌙", "☀️", "🚀"]],
		];
		const closeEmojiPop = (): void => {
			document.querySelector(".planflow-emoji-pop")?.remove();
			document.removeEventListener("pointerdown", this.emojiPopDocDown!, true);
			this.emojiPopDocDown = null;
		};
		this.emojiClosePop = closeEmojiPop;
		const showEmojiPop = (anchor: HTMLElement): void => {
			closeEmojiPop();
			const pop = document.body.createDiv({ cls: "planflow-emoji-pop" });
			for (const [label, emojis] of EMOJI_GROUPS) {
				const group = pop.createDiv({ cls: "planflow-emoji-group" });
				group.createSpan({ cls: "planflow-emoji-group-label", text: label });
				const row = group.createDiv({ cls: "planflow-emoji-row" });
				for (const emoji of emojis) {
					const b = row.createEl("button", { cls: "planflow-emoji-option", attr: { type: "button" } });
					b.setText(emoji);
					b.addEventListener("click", () => {
						this.labelEl.value = emoji;
						closeEmojiPop();
					});
				}
			}
			// 视口定位：按钮下方，左右不越界；下方空间不足则向上弹
			const r = anchor.getBoundingClientRect();
			const W = 340;
			const H = pop.offsetHeight || 340;
			let left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
			let top = r.bottom + 6;
			if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 6);
			pop.style.left = `${left}px`;
			pop.style.top = `${top}px`;
			pop.style.maxHeight = `${Math.min(380, window.innerHeight - 16)}px`;
			// 点击浮层外关闭
			this.emojiPopDocDown = (e: PointerEvent) => {
				if (!pop.contains(e.target as Node)) closeEmojiPop();
			};
			document.addEventListener("pointerdown", this.emojiPopDocDown, true);
		};
		new Setting(contentEl)
			.setName("图标")
			.setDesc("显示在计划名称前，如 ✍️ 📖 🏃")
			.addText((text) => {
				this.labelEl = text.inputEl;
				text.setPlaceholder("✍️");
			})
			.addButton((btn) => {
				btn.setButtonText("选择…").setTooltip("从常用 emoji 中选择").onClick(() => {
					showEmojiPop(btn.buttonEl);
				});
			});
		new Setting(contentEl).setName("动作").setDesc("每日打卡动作，如 1小时").addText((text) => {
			this.actionEl = text.inputEl;
			text.setPlaceholder("1小时");
		});
		new Setting(contentEl).setName("目标描述").addTextArea((ta) => {
			this.targetEl = ta.inputEl;
			ta.setPlaceholder("例如：发布 12 篇公众号文章");
		});
		new Setting(contentEl).setName("颜色").addDropdown((dropdown) => {
			this.colorEl = dropdown.selectEl;
			dropdown.addOption("", "（自动）");
			for (const c of PLAN_COLOR_OPTIONS) dropdown.addOption(c, c);
		});
		new Setting(contentEl).setName("每日打卡").setDesc("勾选后作为每日例行行动").addToggle((toggle) => {
			toggle.setValue(this.dailyVal);
			toggle.onChange((v) => {
				this.dailyVal = v;
			});
		});

		this.nameEl.value = this.existing?.name ?? "";
		this.labelEl.value = this.existing?.label ?? "";
		this.actionEl.value = this.existing?.action ?? "";
		this.targetEl.value = this.existing?.target ?? "";
		this.colorEl.value = this.existing?.color ?? "";

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => {
			void (async () => {
				const name = this.nameEl.value.trim();
				if (!name) {
					new Notice("请输入大类名称");
					return;
				}
				const saved = await this.onSubmit({
					name,
					label: this.labelEl.value.trim(),
					action: this.actionEl.value.trim(),
					target: this.targetEl.value.trim(),
					color: this.colorEl.value,
					daily: this.dailyVal,
				});
				if (saved) this.close();
			})();
		});
	}

	onClose(): void {
		this.emojiClosePop?.(); // v2.4.1: 关闭 Modal 时清理浮动 emoji 选择层
		this.contentEl.empty();
	}
}

/** Modal for creating / editing a quantified goal under a plan (v1.2, spec #4). */
class GoalEditModal extends Modal {
	private planName: string;
	private existing: PlanGoal | null;
	private onSubmit: (input: GoalInput) => Promise<boolean>;
	private nameEl!: HTMLInputElement;
	private countEl!: HTMLInputElement;
	private unitEl!: HTMLInputElement;
	private startEl!: HTMLInputElement;
	private endEl!: HTMLInputElement;

	constructor(
		app: App,
		planName: string,
		existing: PlanGoal | null,
		onSubmit: (input: GoalInput) => Promise<boolean>
	) {
		super(app);
		this.planName = planName;
		this.existing = existing;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", {
			text: this.existing ? `编辑量化目标（${this.planName}）` : `新增量化目标（${this.planName}）`,
		});

		new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：公众号文章");
		});
		new Setting(contentEl).setName("数量").addText((text) => {
			this.countEl = text.inputEl;
			this.countEl.type = "number";
			this.countEl.min = "1";
			text.setPlaceholder("例如：12");
		});
		new Setting(contentEl).setName("单位").addText((text) => {
			this.unitEl = text.inputEl;
			text.setPlaceholder("个");
		});
		new Setting(contentEl).setName("开始日期").addText((text) => {
			this.startEl = text.inputEl;
			this.startEl.type = "date";
			this.startEl.addClass("planboard-date-btn");
		});
		new Setting(contentEl).setName("结束日期").addText((text) => {
			this.endEl = text.inputEl;
			this.endEl.type = "date";
			this.endEl.addClass("planboard-date-btn");
		});

		this.nameEl.value = this.existing?.name ?? "";
		this.countEl.value = this.existing ? String(this.existing.count) : "";
		this.unitEl.value = this.existing?.unit ?? "个";
		this.startEl.value = this.existing?.start ?? "";
		this.endEl.value = this.existing?.end ?? "";

		// 弹窗打开即聚焦名称输入（Obsidian modal 不默认聚焦；迟延兜底动画期间点击失效）
		this.nameEl.focus();
		window.setTimeout(() => {
			if (this.contentEl.isConnected) this.nameEl.focus();
		}, 120);

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => {
			void (async () => {
				const name = this.nameEl.value.trim();
				if (!name) {
					new Notice("请输入目标名称");
					return;
				}
				const count = parseInt(this.countEl.value, 10);
				if (Number.isNaN(count) || count <= 0) {
					new Notice("请输入有效的数量");
					return;
				}
				const input: GoalInput = { name, count, unit: this.unitEl.value.trim() || "个" };
				if (this.startEl.value) input.start = this.startEl.value;
				if (this.endEl.value) input.end = this.endEl.value;
				const saved = await this.onSubmit(input);
				if (saved) this.close();
			})();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function hexToRgba(hex: string, alpha: number): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Parse the raw `plans` frontmatter into name → raw object (all layouts). */
function readRawPlans(content: string): Map<string, Record<string, unknown>> {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return new Map();
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return new Map();
	}
	const raw = data?.plans;
	const map = new Map<string, Record<string, unknown>>();
	if (Array.isArray(raw)) {
		for (const el of raw) {
			if (!el || typeof el !== "object") continue;
			const obj = el as Record<string, unknown>;
			const name = obj.name ?? obj.plan ?? obj["名称"] ?? obj["计划"];
			if (typeof name === "string") {
				map.set(name, obj);
			} else {
				const key = Object.keys(obj)[0];
				if (key) {
					const val = obj[key];
					map.set(key, val && typeof val === "object" ? (val as Record<string, unknown>) : {});
				}
			}
		}
	} else if (raw !== null && typeof raw === "object") {
		for (const key of Object.keys(raw)) {
			const val = (raw as Record<string, unknown>)[key];
			map.set(key, val && typeof val === "object" ? (val as Record<string, unknown>) : {});
		}
	}
	return map;
}

/**
 * Write the `plans` list back into the annual note's frontmatter (spec v1.2 #5).
 * The plans block is re-serialized manually (no js-yaml); every other frontmatter
 * field and the note body are preserved. Callers manage `selfWrite`.
 */
async function writePlansToFile(
	app: App,
	file: TFile,
	plans: PlanDef[],
	dailyByPlan?: Record<string, boolean>
): Promise<void> {
	await app.vault.process(file, (content) => {
		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
		if (!fmMatch) return content;
		const inner = fmMatch[1];
		const lines = inner.split("\n");
		const plansIdx = lines.findIndex((l) => /^plans:(\s|$)/.test(l));
		let newInner: string;
		if (plansIdx === -1) {
			// 无 plans 键：插到 frontmatter 顶部。
			const ser = serializePlans(plans, dailyByPlan).replace(/\n$/, "");
			newInner = ser + (inner ? "\n" + inner : "");
		} else {
			// 定位 plans 块结束：下一行非空且不缩进（顶层 key），或 inner 末尾。
			let end = lines.length;
			for (let i = plansIdx + 1; i < lines.length; i++) {
				if (lines[i].length > 0 && !/^\s/.test(lines[i])) {
					end = i;
					break;
				}
			}
			const before = lines.slice(0, plansIdx).join("\n");
			const after = lines.slice(end).join("\n");
			const ser = serializePlans(plans, dailyByPlan).replace(/\n$/, "");
			newInner = (before ? before + "\n" : "") + ser + (after ? "\n" + after : "");
		}
		return content.replace(fmMatch[0], `---\n${newInner}\n---`);
	});
}

/** Manually serialize the `plans:` frontmatter block (2-space indent, spec v1.2 #5). */
function serializePlans(plans: PlanDef[], dailyByPlan?: Record<string, boolean>): string {
	const lines: string[] = ["plans:"];
	for (const p of plans) {
		lines.push(`  ${yamlScalar(p.name)}:`);
		if (p.label) lines.push(`    label: ${yamlScalar(p.label)}`);
		if (p.action) lines.push(`    action: ${yamlScalar(p.action)}`);
		lines.push(`    daily: ${dailyByPlan?.[p.name] ?? (p.type === "check")}`);
		if (p.target) lines.push(`    target: ${yamlScalar(p.target)}`);
		if (p.tradingDay) lines.push("    tradingDay: true");
		if (p.color) lines.push(`    color: ${yamlScalar(p.color)}`);
		if (p.goals.length > 0) {
			lines.push("    goals:");
			for (const g of p.goals) {
				lines.push(`      - name: ${yamlScalar(g.name)}`);
				lines.push(`        count: ${g.count}`);
				if (g.unit) lines.push(`        unit: ${yamlScalar(g.unit)}`);
				if (g.start) lines.push(`        start: ${yamlScalar(g.start)}`);
				if (g.end) lines.push(`        end: ${yamlScalar(g.end)}`);
			}
		}
	}
	return lines.join("\n") + "\n";
}

/** Quote a YAML scalar only when plain style could be misread (spec: 中文冒号无需引号). */
function yamlScalar(value: string): string {
	const v = value.trim();
	if (v === "") return '""';
	if (
		/^[-?!&*#{[|>'"%@`]/.test(v) || // leading YAML indicator
		/:\s/.test(v) || // "key: value" ambiguity
		/:\s*$/.test(v) || // trailing colon
		/ #/.test(v) || // comment after space
		/[[\]{} ,]/.test(v) // flow indicators / space separators
	) {
		return JSON.stringify(v);
	}
	return v;
}

/** Pick the next free palette color for a new plan (spec v1.2 #4: 轮换默认色). */
function rotatePlanColor(defs: PlanDef[]): string {
	const used = new Set<string>(defs.map((d) => d.color).filter(Boolean));
	for (const c of PLAN_COLOR_OPTIONS) {
		if (!used.has(c)) return c;
	}
	return PLAN_COLOR_OPTIONS[defs.length % PLAN_COLOR_OPTIONS.length];
}

/** Build a PlanDef from a PlanProgress for editing (PlanProgress lacks type/targetCount). */
function toPlanDef(prog: PlanProgress): PlanDef {
	return {
		name: prog.plan,
		type: prog.isNumeric ? "numeric" : "check",
		target: prog.target,
		targetCount: prog.targetCount,
		goals: prog.goals.map((g) => ({ name: g.name, count: g.count, unit: g.unit, start: g.start, end: g.end })),
		action: prog.action,
		label: prog.label,
		color: prog.color,
		tradingDay: prog.tradingDay,
		daily: true,
	};
}

