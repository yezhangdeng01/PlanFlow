/**
 * 手写 SVG 图表（v2.9 起零依赖实现，Obsidian CSS 变量随主题自适应）。
 *
 * 本文件由脚本从 PlanBoardView.ts 机械搬移而来（原 3871-4345 区间），**代码未作任何改写**，
 * 只是给顶层符号加了 export。搬出来的理由：
 *   ① 这 470 行是纯函数 + 常量，不碰 DOM 查询/事件/插件状态，与视图逻辑本就解耦；
 *   ② 图表必须写 element.style.fill/stroke（配色是运行时按数据插值算的：热力图绿档随主题切、
 *      柱高与扇区色按完成度插值、计划色还要再柔化），社区规范禁止 eslint-disable 注释，
 *      豁免只能走 eslint 配置——按文件是最精确的粒度，不用按行号或全局关；
 *   ③ 纯函数可脱离 Obsidian 运行时单测。
 *
 * 颜色工具（deepenForText / softenChartColor / hexToRgba）仍住在 PlanBoardView，
 * 因为主类多处直接调用；这里反向 import，不重复实现。
 */
import { deepenForText, softenChartColor } from "./colors";
import { formatDate } from "./daily";
/** v2.9 手写 SVG 图表工具（零依赖，Obsidian 变量随主题自适应）。 */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	return el;
}

/**
 * v6.3: 回顾页「打卡统计」彩色环形饼图——每个计划一个扇区，色 = 计划色柔化。
 * 与「单值进度环」不是一回事：这个是多值分布（早期那个单值版已随 KPI 行移除而退役）。
 * 用 stroke-dasharray 画弧（不做 arc path，避开大角度下的浮点误差），
 * 扇区之间留一道细缝，相邻同色计划也能分开。
 * v6.4: 每段可选带 done —— 给了就画两段（未完成淡色打底、已完成实色叠上去），
 * 年度任务卡用，否则环全年不变、只是个装饰；不给就是整段实色（打卡统计用）。
 */
export function buildDonutChartSvg(
	slices: { value: number; color: string; done?: number }[],
	centerValue: string,
	centerLabel: string,
	size = 152,
): SVGSVGElement {
	const sw = Math.round(size * 0.17);
	const r = (size - sw) / 2 - 1;
	const c = 2 * Math.PI * r;
	const mid = size / 2;
	const total = slices.reduce((s, x) => s + x.value, 0);
	const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: "100%", "aria-hidden": "true" });
	// 轨道：也当空态底环（全年 0 次时不是"什么都没有"，是一个空环 + 中心的 0）
	const track = svgEl("circle", { cx: mid, cy: mid, r, fill: "none", "stroke-width": sw });
	track.style.stroke = "var(--background-modifier-border)";
	track.style.opacity = "0.32";
	svg.append(track);
	if (total > 0) {
		const gapPx = slices.length > 1 ? Math.min(3, c * 0.01) : 0;
		// offset / len 都以弧长为单位（不是分数）
		const arc = (offset: number, len: number, color: string, opacity: number): void => {
			const seg = svgEl("circle", {
				cx: mid,
				cy: mid,
				r,
				fill: "none",
				"stroke-width": sw,
				"stroke-dasharray": `${len} ${Math.max(c - len, 0.001)}`,
				"stroke-dashoffset": String(-offset),
				transform: `rotate(-90 ${mid} ${mid})`,
			});
			seg.style.stroke = color;
			if (opacity < 1) seg.style.opacity = String(opacity);
			svg.append(seg);
		};
		let acc = 0;
		for (const s of slices) {
			if (s.value <= 0) continue;
			const frac = s.value / total;
			const len = Math.max(frac * c - gapPx, 1.5);
			const offset = acc * c;
			if (s.done === undefined) {
				arc(offset, len, s.color, 1);
			} else {
				// 底 = 该计划全部任务（淡色），面 = 其中已完成的部分（实色，从段首起算）
				// 0.45 而不是更低：再淡的话深色主题下会闷成脏色，且一眼看着像"没画东西"
				arc(offset, len, s.color, 0.45);
				const ratio = Math.max(0, Math.min(1, s.done / s.value));
				if (ratio > 0) arc(offset, Math.max(len * ratio, 1.5), s.color, 1);
			}
			acc += frac;
		}
	}
	const big = svgEl("text", {
		x: mid,
		y: mid - size * 0.015,
		"text-anchor": "middle",
		"dominant-baseline": "central",
		"font-size": Math.round(size * 0.175),
		"font-weight": "700",
	});
	big.textContent = centerValue;
	big.style.fill = "var(--text-normal)";
	svg.append(big);
	const sub = svgEl("text", {
		x: mid,
		y: mid + size * 0.135,
		"text-anchor": "middle",
		"dominant-baseline": "central",
		"font-size": Math.round(size * 0.072),
		"font-weight": "500",
		"letter-spacing": "1",
	});
	sub.textContent = centerLabel;
	sub.style.fill = "var(--text-faint)";
	svg.append(sub);
	return svg;
}

/**
 * 本月每日打卡柱状图（v3.8: 由周 7 柱改为当月 1 日至今，每日一细柱）。
 * 高度分母 = 每日打卡项总数（goalTotal）——柱满格 = 当天全部完成；
 * 动态冷暖：每根柱按完成度 t=v/goalTotal 在冷→暖色带取色（做得越满越暖）。
 * v7.4: 所有有计数的柱顶都标数值（今天加粗、历史柱常规弱化），不必逐根 hover。
 */
/**
 * 图表字号三档（v3.9.10 收敛）：原 7.5/8.5/9/9.5/10/12 六种散值统一到 9/10/12。
 * SVG 的 font-size 走 attribute（不是 CSS），无法读 CSS 变量，故在 TS 侧集中定义。
 */
export const SVG_FS = {
	micro: 11, // 日期行、月份刻度、热力图月份标签（实际 ~8.8px）
	value: 13, // 柱顶数值、末端总数（实际 ~10.4px）
	// v7.16: 15 → 17。用户 164347：图里的计划名 / 次数字号偏小。
	// SVG 文字随 viewBox 缩放（本机实测 657/720 ≈ 0.91），17 → 实际 ~15.5px，
	// 与正文 14 档同档不再显小；nameW 的「13px/字」估宽同步改 17（见 buildPlanBarsH）。
	label: 17, // 计划名、次数
} as const;

export const WEEK_BAR_RAMP = {
	cold: [111, 159, 216] as const, // #6f9fd8 底色
	mid: [176, 140, 196] as const, // #b08cc4 过渡
	warm: [226, 160, 106] as const, // #e2a06a 顶端
};

/** 在冷→暖三段色带上取 t∈[0,1] 处的颜色。 */
export function weekBarRampColor(t: number): string {
	const c = Math.max(0, Math.min(1, t));
	const [a, b, k] = c < 0.52 ? [WEEK_BAR_RAMP.cold, WEEK_BAR_RAMP.mid, c / 0.52] : [WEEK_BAR_RAMP.mid, WEEK_BAR_RAMP.warm, (c - 0.52) / 0.48];
	const ch = [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
	return `#${ch.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function buildMonthBarsSvg(done: number[], goalTotal = 0, slots = 0): SVGSVGElement {
	const W = 720;
	const H = 116;
	const pad = 8;
	const gap = 2;
	const labelH = 12; // 今日数值行预留
	const dateH = 14; // v3.9: 底部日期行预留
	// v3.8.1: 格数 = 整月天数（未来日期留空位）——月初柱子不会过宽，整月柱宽恒定
	const n = Math.max(slots || done.length, 1);
	const cw = (W - pad * 2 - gap * (n - 1)) / n;
	// v6.0: 柱只占槽宽的 62%，左右各留 19% 的气口——30 根满宽柱太密，是"不清爽"的大头
	const bw = Math.max(2, cw * 0.62);
	const bx = (i: number): number => pad + i * (cw + gap) + (cw - bw) / 2;
	const full = goalTotal > 0 ? goalTotal : Math.max(...done, 1);
	const base = H - pad - dateH;
	const todayIdx = done.length - 1; // 序列 = 本月 1 日至今，最后一根即今天（slots 为整月格数）
	// 固定渲染高度（preserveAspectRatio none 随卡宽缩放），配合可拖拽卡高
	const svg = svgEl("svg", {
		viewBox: `0 0 ${W} ${H}`,
		width: "100%",
		height: "108",
		preserveAspectRatio: "none",
		"aria-hidden": "true",
	});
	const defs = svgEl("defs", {});
	done.forEach((v, i) => {
		// v3.9.8: 零完成日画"幽灵槽"——空图不再像坏了，月份结构始终可见（P1 空状态引导）
		if (v === 0) {
			const gx = bx(i);
			const ghost = svgEl("rect", { x: gx, y: base - 4, width: bw, height: 4, rx: 2 });
			ghost.style.fill = "var(--background-modifier-border)";
			ghost.style.opacity = "0.6"; // v6.0: 0.9 → 0.6，空槽不再像一排小黑块
			svg.append(ghost);
		}
		// 每柱一条动态渐变——顶部颜色随完成度在冷→暖色带上爬升
		const t = full > 0 ? Math.max(0, Math.min(1, v / full)) : 0;
		const grad = svgEl("linearGradient", { id: `pf-bar-${i}`, x1: "0", y1: "0", x2: "0", y2: "1" });
		const stopTop = svgEl("stop", { offset: "0%" });
		stopTop.style.stopColor = weekBarRampColor(t);
		const stopMid = svgEl("stop", { offset: "52%" });
		stopMid.style.stopColor = weekBarRampColor(t * 0.5);
		const stopBottom = svgEl("stop", { offset: "100%" });
		stopBottom.style.stopColor = weekBarRampColor(0);
		grad.append(stopTop, stopMid, stopBottom);
		defs.append(grad);
	});
	svg.append(defs);
	done.forEach((v, i) => {
		const t = full > 0 ? Math.max(0, Math.min(1, v / full)) : 0;
		const h = t * (base - pad - labelH);
		const x = bx(i);
		const rect = svgEl("rect", { x, y: base - h, width: bw, height: Math.max(h, v > 0 ? 2 : 0), rx: 2 });
		rect.setAttribute("fill", `url(#pf-bar-${i})`);
		if (i !== todayIdx) rect.style.opacity = "0.85"; // v6.0: 0.7 → 0.85，整排不再发灰
		const tip = svgEl("title", {});
		tip.textContent = `${i + 1} 日 · ${v} 完成`;
		rect.append(tip);
		svg.append(rect);
	});
	// v7.4: 所有有计数的柱顶都标数值（v3.9: 底部已有日期行，柱底圆点取消避免重叠）；
	// 今天加粗、历史柱常规字重稍弱化——一眼看到"哪天做了多少"。
	done.forEach((v, i) => {
		if (v <= 0) return;
		const t = full > 0 ? Math.max(0, Math.min(1, v / full)) : 0;
		const h = t * (base - pad - labelH);
		const label = svgEl("text", {
			x: bx(i) + bw / 2,
			y: Math.max(12, base - h - 3),
			"text-anchor": "middle",
			"font-size": SVG_FS.value,
			"font-weight": i === todayIdx ? "700" : "400",
		});
		label.textContent = String(v);
		label.style.fill = "var(--text-normal)";
		if (i !== todayIdx) label.style.opacity = "0.8";
		svg.append(label);
	});
	// v3.9: 底部日期 1..N（已过日期正常色、今天加粗、未来日期弱化）
	for (let d = 0; d < n; d++) {
		const dx = pad + d * (cw + gap) + Math.max(2, cw) / 2;
		const dt = svgEl("text", {
			x: dx,
			y: base + 12,
			"text-anchor": "middle",
			"font-size": SVG_FS.micro,
			"font-weight": d === todayIdx ? "700" : "400",
		});
		dt.textContent = String(d + 1);
		dt.style.fill = d === todayIdx ? "var(--text-normal)" : "var(--text-faint)";
		if (d > todayIdx) dt.style.opacity = "0.6";
		svg.append(dt);
	}
	return svg;
}

/** GitHub 式打卡热力图：53 列（周）× 7 行（周一到周日），颜色按完成数分 5 档。
 *  v3.9.10b: W 由 720 改为 1180——热力图只在回顾页通栏（实测渲染宽 ~1187px），
 *  原 720 会让横向缩放达 1.65×，月份标签被放大到 18px（比正文还大）。
 *  改宽后 scale≈1，SVG 字号即实际像素。 */
export function buildHeatmapSvg(map: Map<string, number>, today: string): SVGSVGElement {
	const W = 1180;
	const H = 98;
	const pad = 14;
	const gap = 2;
	const cols = 53;
	const rows = 7;
	const cw = (W - pad * 2 - gap * (cols - 1)) / cols;
	const rh = (H - pad * 2 - gap * (rows - 1)) / rows;
	const year = Number(today.slice(0, 4));
	const jan1 = new Date(year, 0, 1);
	const jan1Dow = jan1.getDay() === 0 ? 7 : jan1.getDay(); // ISO 周一=1..周日=7
	// v1.0.5.1: 档色按用户拍板改 **暖色系**（琥珀/赭，与计划色轮换里的 #f59e0b 同族）。
	// 语义沿用 GitHub 式 5 档：tier0 空 = 边框色（var()，空态随主题），tier1..4 随完成数
	// 浅色主题「越多越深」、深色主题「越多越亮」。palette[0] 占位不用。
	const isDark = document.body.classList.contains("theme-dark");
	const palette = isDark
		? ["#42291a", "#42291a", "#6b4423", "#a3702c", "#efa35c"]
		: ["#fbe4d0", "#fbe4d0", "#f6bd8a", "#ef9548", "#d97706"];
	// v3.9: preserveAspectRatio none——高度拖拽只拉伸格子高度，宽度始终铺满卡（不会再缩到中间）
	const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" });
	svg.style.width = "100%";
	svg.style.height = "100%";
	svg.style.display = "block";
	for (let c = 0; c < cols; c++) {
		for (let r = 0; r < rows; r++) {
			const dIdx = c * 7 + r - (jan1Dow - 1);
			if (dIdx < 0) continue;
			const d = new Date(year, 0, 1);
			d.setDate(d.getDate() + dIdx);
			if (d.getFullYear() !== year) continue;
			const dStr = formatDate(d);
			const n = map.get(dStr) ?? 0;
			const tier = n === 0 ? 0 : n <= 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 3 : 4;
			const rect = svgEl("rect", {
				x: pad + c * (cw + gap),
				y: pad + r * (rh + gap),
				width: cw,
				height: rh,
				rx: 1.5,
			});
			// v3.0: 空档主题自适应（深色主题下亮灰 #ebedf0 太刺眼，改用边框色变量）
			rect.style.fill = tier === 0 ? "var(--background-modifier-border)" : palette[tier];
			if (dStr === today) {
				rect.setAttribute("stroke", "#3572a8");
				rect.setAttribute("stroke-width", "1.5");
			}
			const tip = svgEl("title", {});
			tip.textContent = `${dStr} · ${n} 完成`;
			rect.append(tip);
			svg.append(rect);
		}
	}
	// 月份标签（每月初所在列画 1 次）
	const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
	for (let m = 0; m < 12; m++) {
		const first = new Date(year, m, 1);
		const dIdx = Math.round((first.getTime() - jan1.getTime()) / 86400000);
		const col = Math.floor((dIdx + (jan1Dow - 1)) / 7);
		if (col >= cols) break;
		const txt = svgEl("text", {
			x: pad + col * (cw + gap),
			y: H - 6,
			"font-size": SVG_FS.micro,
		});
		txt.style.fill = "var(--text-muted)"; // SVG attr 不认 CSS 变量，必须走 style
		txt.textContent = monthNames[m];
		svg.append(txt);
	}
	return svg;
}

/**
 * 本月各计划打卡横向条形（v3.9.4 方案 A）：每计划一根条，长度相对最大值，
 * 计划色 = 设置里的计划色（柔化后），右侧标"n 次"。行序按计划排序。
 */
export function buildPlanBarsH(rows: { plan: string; count: number; color?: string }[], maxCount = 0): SVGSVGElement {
	const W = 720;
	const rowH = 30; // v6.0: 34 → 30
	const padTop = 6;
	// v3.9.6: 名称列宽随最长计划名自适应（中文字宽 ≈ 字号，v7.16 起字号 17）
	// v7.16: 13px/字 → 17px/字、上限 220 → 248 —— 字号提到 17 后旧估宽会让
	// 6 字以上的计划名压到轨道上（实测「公众号文章第 2 篇」级别的名字）。
	const longest = Math.max(...rows.map((r) => r.plan.length), 2);
	const nameW = Math.min(248, longest * 17 + 16);
	const valW = 78; // 右侧数值列宽
	// v3.9.7: 轨道填满剩余行宽（名称列已自适应，右侧不再留白）
	const barMax = W - nameW - valW - 10;
	const H = padTop + Math.max(rows.length, 1) * rowH + 6;
	// v3.9.5: 分母 = 整月天数（用户预期"31 次才满条"）——1 次约 3% 长度，成长空间可见
	const max = maxCount > 0 ? maxCount : Math.max(...rows.map((r) => r.count), 1);
	const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", "aria-hidden": "true" });
	rows.forEach((r, i) => {
		const y = padTop + i * rowH;
		// 计划名（带计划色，与 banner 同款加深保证可读）
		const name = svgEl("text", { x: 0, y: y + 14, "font-size": SVG_FS.label, "font-weight": "600" });
		name.textContent = r.plan;
		name.style.fill = r.color ? deepenForText(r.color) : "var(--text-normal)";
		svg.append(name);
		// 轨道 + 计划色条
		const track = svgEl("rect", { x: nameW, y: y + 5, width: barMax, height: 12, rx: 6 });
		track.style.fill = "var(--background-modifier-border)";
		track.style.opacity = "0.28"; // v6.0: 0.45 → 0.28
		svg.append(track);
		const w = Math.max((r.count / max) * barMax, r.count > 0 ? 8 : 0);
		if (w > 0) {
			const bar = svgEl("rect", { x: nameW, y: y + 5, width: w, height: 12, rx: 6 });
			bar.style.fill = r.color ? softenChartColor(r.color) : "#3572a8";
			svg.append(bar);
		}
		// 右侧次数
		const val = svgEl("text", { x: nameW + barMax + 10, y: y + 15, "font-size": SVG_FS.label, "font-weight": "500" });
		val.textContent = `${r.count} 次`;
		val.style.fill = r.count > 0 ? "var(--text-muted)" : "var(--text-faint)";
		svg.append(val);
	});
	return svg;
}

/**
 * 年度总结图表（v3.9.8）：12 根月度柱，动态冷暖色带（相对全年最大月），
 * 柱下 1-12 月份标签，最高月柱顶标数值。回顾·年粒度专用。
 */
export function buildYearMonthsSvg(months: { label: string; done: number }[]): SVGSVGElement {
	const W = 720;
	const H = 104;
	const pad = 8;
	const gap = 6;
	const labelH = 14;
	const valH = 12;
	const n = Math.max(months.length, 1);
	const cw = (W - pad * 2 - gap * (n - 1)) / n;
	const max = Math.max(...months.map((m) => m.done), 1);
	const base = H - pad - labelH;
	const maxIdx = months.findIndex((m) => m.done === max);
	const svg = svgEl("svg", {
		viewBox: `0 0 ${W} ${H}`,
		width: "100%",
		height: "96",
		preserveAspectRatio: "none",
		"aria-hidden": "true",
	});
	const defs = svgEl("defs", {});
	months.forEach((m, i) => {
		const t = Math.max(0, Math.min(1, m.done / max));
		const grad = svgEl("linearGradient", { id: `pf-ym-${i}`, x1: "0", y1: "0", x2: "0", y2: "1" });
		const s1 = svgEl("stop", { offset: "0%" });
		s1.style.stopColor = weekBarRampColor(t);
		const s2 = svgEl("stop", { offset: "100%" });
		s2.style.stopColor = weekBarRampColor(0);
		grad.append(s1, s2);
		defs.append(grad);
	});
	svg.append(defs);
	months.forEach((m, i) => {
		const t = Math.max(0, Math.min(1, m.done / max));
		const h = t * (base - pad - valH);
		const x = pad + i * (cw + gap);
		if (m.done > 0) {
			const rect = svgEl("rect", { x, y: base - h, width: cw, height: Math.max(h, 3), rx: 2 });
			rect.setAttribute("fill", `url(#pf-ym-${i})`);
			const tip = svgEl("title", {});
			tip.textContent = `${m.label} 月 · ${m.done} 完成`;
			rect.append(tip);
			svg.append(rect);
		} else {
			const ghost = svgEl("rect", { x, y: base - 4, width: cw, height: 4, rx: 1 });
			ghost.style.fill = "var(--background-modifier-border)";
			svg.append(ghost);
		}
		// 最高月柱顶标数值
		if (i === maxIdx && m.done > 0) {
			const val = svgEl("text", { x: x + cw / 2, y: Math.max(13, base - h - 3), "text-anchor": "middle", "font-size": SVG_FS.value, "font-weight": "700" });
			val.textContent = String(m.done);
			val.style.fill = "var(--text-normal)";
			svg.append(val);
		}
		const lbl = svgEl("text", { x: x + cw / 2, y: base + 11, "text-anchor": "middle", "font-size": SVG_FS.micro });
		lbl.textContent = m.label;
		lbl.style.fill = i === maxIdx ? "var(--text-normal)" : "var(--text-muted)";
		svg.append(lbl);
	});
	return svg;
}

/**
 * 年度累计打卡曲线（v3.9.9）：12 个月逐月累加，面积+折线，
 * 折线纵向走冷→暖色带（斜率即节奏）；末段标注全年总数。
 */
export function buildCumulativeSvg(months: { label: string; done: number }[], yearMap: Map<string, number>): SVGSVGElement {
	const W = 720;
	const H = 96;
	const pad = 10;
	const n = months.length;
	// 空数据早退：下面拼面积路径时要用 pts[0] 与 pts[n-1]，n=0 会读到 undefined 直接崩。
	// 当前调用方（回顾页）恒传 12 项，但同文件的其它图表都做了空值保护，这里保持一致。
	if (n === 0) return svgEl("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
	const total = months.reduce((s, m) => s + m.done, 0);
	const cum: number[] = [];
	let acc = 0;
	for (const m of months) {
		acc += m.done;
		cum.push(acc);
	}
	const max = Math.max(total, 1);
	const cw = (W - pad * 2) / Math.max(n - 1, 1);
	const base = H - pad;
	const pts = months.map((_, i) => [pad + i * cw, base - (cum[i] / max) * (H - pad * 2)] as const);
	const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: "72", preserveAspectRatio: "none", "aria-hidden": "true" });
	const defs = svgEl("defs", {});
	const grad = svgEl("linearGradient", { id: "pf-cum-grad", x1: "0", y1: "0", x2: "0", y2: "1" });
	const s1 = svgEl("stop", { offset: "0%" });
	s1.style.stopColor = weekBarRampColor(1);
	const s2 = svgEl("stop", { offset: "100%" });
	s2.style.stopColor = weekBarRampColor(0);
	grad.append(s1, s2);
	defs.append(grad);
	svg.append(defs);
	const areaD = `M ${pts[0][0]} ${base} ` + pts.map((p) => `L ${p[0]} ${p[1]}`).join(" ") + ` L ${pts[n - 1][0]} ${base} Z`;
	const area = svgEl("path", { d: areaD, fill: "url(#pf-cum-grad)", stroke: "none" });
	area.style.fillOpacity = "0.14";
	svg.append(area);
	const lineD = `M ${pts[0][0]} ${pts[0][1]} ` + pts.slice(1).map((p) => `L ${p[0]} ${p[1]}`).join(" ");
	const line = svgEl("path", { d: lineD, fill: "none", stroke: "url(#pf-cum-grad)", "stroke-width": "2", "stroke-linejoin": "round" });
	svg.append(line);
	// 月份刻度 1..12
	months.forEach((_, i) => {
		const t = svgEl("text", { x: pad + i * cw, y: H - 5, "text-anchor": "middle", "font-size": SVG_FS.micro });
		t.textContent = String(i + 1);
		t.style.fill = "var(--text-muted)";
		svg.append(t);
	});
	// 末端总数徽标
	const end = svgEl("text", { x: pts[n - 1][0] - 4, y: Math.max(13, pts[n - 1][1] - 5), "text-anchor": "end", "font-size": SVG_FS.value, "font-weight": "700" });
	end.textContent = `${total} 次`;
	end.style.fill = "var(--text-normal)";
	svg.append(end);
	void yearMap;
	return svg;
}

/** 字段级错误提示：把校验错误显示在输入框正下方（M4，2026-09-09）。
 *  替代远离视线的新 Notice toast；用户输入时自动清除。返回 show/clear。 */
