/**
 * 颜色工具：计划色 → 文字色 / 图形色的两套换算。
 *
 * 与 charts.ts / PlanBoardView.ts 的关系：两边都要用这些函数，
 * 所以独立成模块 —— charts.ts 若反向 import PlanBoardView 会形成循环依赖
 * （PlanBoardView 已 import charts），独立后两边都单向依赖本文件。
 *
 * 代码为从 PlanBoardView.ts 机械搬移，未作逻辑改动。
 */
/**
 * v3.1: 图表用色降饱和——同色相，S×0.62、亮度向 0.72 微收。
 * 计划色直接来自用户设置（可能很艳），图表填充统一过这道"柔化"，
 * 呼应"容器克制，数据鲜艳但不荧光"。
 */
/** v3.6: 计划名文字用色——同色相压暗到可读区间（浅色主题白底上 ≥4.5:1 量级）。 */
export function deepenForText(hex: string): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return hex;
	const num = parseInt(m[1], 16);
	const r = ((num >> 16) & 255) / 255;
	const g = ((num >> 8) & 255) / 255;
	const b = (num & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h /= 6;
	}
	const s2 = Math.min(0.92, Math.max(s, 0.45));
	const l2 = Math.min(l, 0.4);
	const hue2rgb = (p: number, q: number, t: number): number => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	let r2: number;
	let g2: number;
	let b2: number;
	if (s2 === 0) {
		r2 = g2 = b2 = l2;
	} else {
		const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2;
		const p = 2 * l2 - q;
		r2 = hue2rgb(p, q, h + 1 / 3);
		g2 = hue2rgb(p, q, h);
		b2 = hue2rgb(p, q, h - 1 / 3);
	}
	const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
	return `#${to(r2)}${to(g2)}${to(b2)}`;
}

export function softenChartColor(hex: string): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return hex;
	const num = parseInt(m[1], 16);
	const r = ((num >> 16) & 255) / 255;
	const g = ((num >> 8) & 255) / 255;
	const b = (num & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h /= 6;
	}
	// v5.0 备注：曾试把系数 0.62 降到 0.50，实测**方向错误**——绿/蓝之所以在纸墨页面上跳，
	// 是**色相**问题（青绿、天蓝），降饱和治不了；且低饱和输入会被压成灰
	// （大地四色经 0.50 后变成 #a37765/#818769/#74838a/#ad906c，四者几乎不可辨）。
	// ⇒ 保持 0.62 原值：不做无收益的改动。要真正协调，应改计划色本身（settings）。
	s = Math.max(0, s * 0.62);
	const l2 = Math.min(0.78, l + (0.72 - l) * 0.18);
	const hue2rgb = (p: number, q: number, t: number): number => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	let r2: number;
	let g2: number;
	let b2: number;
	if (s === 0) {
		r2 = g2 = b2 = l2;
	} else {
		const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
		const p = 2 * l2 - q;
		r2 = hue2rgb(p, q, h + 1 / 3);
		g2 = hue2rgb(p, q, h);
		b2 = hue2rgb(p, q, h - 1 / 3);
	}
	const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
	return `#${to(r2)}${to(g2)}${to(b2)}`;
}

export function hexToRgba(hex: string, alpha: number): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Parse the raw `plans` frontmatter into name → raw object (all layouts). */
