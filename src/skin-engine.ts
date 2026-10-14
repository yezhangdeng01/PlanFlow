/**
 * v8.1 自定义皮肤派生引擎（用户「在预设上微调 + 一键复原」）。
 * --------------------------------------------------------------------------
 * 设计约束（踩过坑换来的，改前必读）：
 * ① 用户只能覆盖两个主色：accent 皮肤色（banner 家族；v8.6 起开口色/画布膜
 *    也随它联动）、ink 墨色（文字家族）。
 *    画布膜 / 开口色 / 业务强调色（--pfs-accent 等）**不作为独立输入开放**——
 *    --pf-tab-open-bg 必须等于合成画布色（v7.2/v8.0 两次翻车都是估错它）。
 *    v8.6 起开口色/画布膜改为从 --pf-banner-3（= 皮肤色的现成载体，预设与
 *    自定义都写它）按固定公式派生（styles.css v8.6 节）：用户改皮肤色，
 *    banner、开口、页面画布同步换相且保持浅淡，且开口 ≡ 页面恒成立——
 *    用户不再可能「碰坏」画布色，故仍无需开放直接输入。
 *    所以派生只重算 CUSTOM_TOKEN_KEYS 列出的令牌：
 *      浅色：banner-1/2/3、tab-ink/hover/active、tab-hair、tab-open-shadow、
 *            period-ink、pfs-sub（仅墨色系预设）
 *      深色：banner-1/2/3、tab-ink/hover/active、period-ink、pfs-sub（仅墨色系预设）
 *    深色的 tab-hair/open-shadow 是白/黑基（与主色无关），保持预设不动。
 * ② 生效方式 = 把派生令牌以 **inline CSS 变量**写到 .planboard-root 元素上
 *    （PlanBoardView.applySkin）。inline 优先级压过一切样式表规则，无需管
 *    特异度/注入顺序；深浅态不会自动跟着切，由 main.ts 监听 Obsidian 的
 *    css-change 事件重应用（官方事件，勿自己观察 body class）。
 *    customSkin = null 时一个变量都不写 ⇒ 预设外观零风险（回退只要清字段）。
 *    为什么不生成 <style> 注入：Obsidian 市场 lint 禁运行时创建 style 元素。
 * ③ 🔴 本文件的 SKIN_RECIPES 数值从 styles.css v8.0 各肤变量块拟合而来——
 *    改 styles.css 的皮肤变量块后，必须回来重新拟合（单测只保浅色复现度，
 *    保不了「改没改」这件事本身）。PRESET_DEFAULTS 的 accent/ink  likewise。
 * ④ 深色 banner 用「用户主色 × 预设 alpha 三元组」：各预设深色 banner 的 alpha
 *    手感（.4/.22/.36 等）是逐肤调过的，沿用；RGB 换成用户主色——
 *    用户自定义时他们的主色在深态也可见，这是预期行为而非 bug。
 */

import type { PlanFlowSkin } from "./settings";

/** 用户自定义覆盖（base 预设取 settings.skin，不冗余存储）。 */
export interface CustomSkinOverride {
	/** 主色（顶栏 banner 家族），#rrggbb。 */
	accent: string;
	/** 墨色（标签 / 周期文字 / 次级文字），#rrggbb。 */
	ink: string;
}

/**
 * v8.2 命名方案（用户「保存为方案」的产物）：把某一刻的
 * 「基底预设 + 主色 + 墨色」定格存库，随时应用/删除。
 * 与 customSkin 的分工：customSkin = 当前生效的微调；skinSchemes = 方案仓库。
 */
export interface CustomSkinScheme {
	/** 用户填的方案名（trim 后非空、列表内唯一）。 */
	name: string;
	/** 保存时定格基底预设。 */
	base: PlanFlowSkin;
	accent: string;
	ink: string;
}

/** 校验并规范化 hex；非法返回 null（调用方给 Notice 并忽略本次输入）。 */
export function normalizeHex(input: string): string | null {
	const m = /^#?([0-9a-fA-F]{6})$/.exec((input ?? "").trim());
	return m ? "#" + m[1].toLowerCase() : null;
}

/** 校验单个方案（名称非空 + hex 合法 + base 合法）；非法返回 null。 */
export function normalizeScheme(s: unknown): CustomSkinScheme | null {
	if (!s || typeof s !== "object") return null;
	const o = s as Record<string, unknown>;
	if (typeof o.name !== "string" || !o.name.trim()) return null;
	if (!["sky", "paper", "midnight", "pine"].includes(o.base as string)) return null;
	const accent = typeof o.accent === "string" ? normalizeHex(o.accent) : null;
	const ink = typeof o.ink === "string" ? normalizeHex(o.ink) : null;
	if (!accent || !ink) return null;
	return { name: o.name.trim(), base: o.base as PlanFlowSkin, accent, ink };
}

/** 方案名在列表中是否已存在（大小写不敏感）。 */
export function schemeNameTaken(schemes: CustomSkinScheme[], name: string): boolean {
	const n = name.trim().toLowerCase();
	return schemes.some((s) => s.name.toLowerCase() === n);
}

/** 追加方案（调用方负责先查重）；返回新数组，不改原数组。 */
export function addScheme(schemes: CustomSkinScheme[], s: CustomSkinScheme): CustomSkinScheme[] {
	return [...schemes, s];
}

/** 按名删除；返回新数组。 */
export function removeScheme(schemes: CustomSkinScheme[], name: string): CustomSkinScheme[] {
	return schemes.filter((s) => s.name !== name);
}

/** 应用方案 = 得到应写入 settings 的 skin 与 customSkin（调用方 save + applySkinToViews）。 */
export function applyScheme(s: CustomSkinScheme): { skin: PlanFlowSkin; customSkin: CustomSkinOverride } {
	return { skin: s.base, customSkin: { accent: s.accent, ink: s.ink } };
}

type RGB = [number, number, number];

/** 浅态配方（全部必需——deriveTokens 不做 optional 兜底，缺字段直接编译期暴露）。 */
interface SkinLightRecipe {
	/** banner 末档 → 中档、中档 → 顶档 的混白比例。 */
	bannerMix: [number, number];
	/** ink → ink-hover / ink-active 混黑比例。 */
	inkHover: number;
	inkActive: number;
	/** ink → period-ink 混白比例。 */
	periodMix: number;
	/** tab-hair / open-shadow = rgba(ink, alpha)。 */
	hairAlpha: number;
	shadowAlpha: number;
	/** ink → pfs-sub 混白比例；null = 该预设 pfs-sub 非墨色系（sky 冷灰），不覆盖。 */
	subMix: number | null;
}

/** 深态配方。hair/shadow 是白/黑基（与主色无关）不在表内 ⇒ 保持预设不覆盖。 */
interface SkinDarkRecipe {
	/** banner 三档 = rgba(用户主色, alpha) 三元组（逐肤调过的手感）。 */
	bannerAlphas: [number, number, number];
	/** 深态墨 → hover / active 再混白。 */
	hoverMix: number;
	activeMix: number;
	/** period-ink = rgba(深态墨, alpha)。 */
	periodAlpha: number;
	/** ink → 深态墨 RGB 混白比例。 */
	darkInkMix: number;
	/** tab-ink = rgba(深态墨, alpha)。 */
	inkAlpha: number;
	/** 深态墨 → pfs-sub 混黑；null = 不覆盖。 */
	subDarkMix: number | null;
}

export interface SkinRecipe {
	light: SkinLightRecipe;
	dark: SkinDarkRecipe;
}

/**
 * 四预设配方。拟合源 = styles.css v8.0 变量块（行号见 PROGRESS.md v8.0 节）：
 *   sky     默认块 5644-5683｜paper 5812-5867｜midnight 5870-5923｜pine 5926-5979
 */
export const SKIN_RECIPES: Record<PlanFlowSkin, SkinRecipe> = {
	sky: {
		light: { bannerMix: [0.4, 0.49], inkHover: 0.22, inkActive: 0.24, periodMix: 0.12, hairAlpha: 0.18, shadowAlpha: 0.1, subMix: null },
		dark: { bannerAlphas: [0.4, 0.22, 0.36], hoverMix: 0.3, activeMix: 0.12, periodAlpha: 0.72, darkInkMix: 0.95, inkAlpha: 0.8, subDarkMix: null },
	},
	paper: {
		light: { bannerMix: [0.37, 0.42], inkHover: 0.26, inkActive: 0.33, periodMix: 0.13, hairAlpha: 0.2, shadowAlpha: 0.12, subMix: 0.16 },
		dark: { bannerAlphas: [0.36, 0.2, 0.3], hoverMix: 0.3, activeMix: 0.12, periodAlpha: 0.6, darkInkMix: 0.84, inkAlpha: 0.82, subDarkMix: 0.32 },
	},
	midnight: {
		light: { bannerMix: [0.39, 0.41], inkHover: 0.26, inkActive: 0.27, periodMix: 0.14, hairAlpha: 0.18, shadowAlpha: 0.1, subMix: 0.2 },
		dark: { bannerAlphas: [0.42, 0.24, 0.38], hoverMix: 0.3, activeMix: 0.12, periodAlpha: 0.6, darkInkMix: 0.9, inkAlpha: 0.82, subDarkMix: 0.31 },
	},
	pine: {
		light: { bannerMix: [0.34, 0.42], inkHover: 0.26, inkActive: 0.18, periodMix: 0.11, hairAlpha: 0.18, shadowAlpha: 0.1, subMix: 0.22 },
		dark: { bannerAlphas: [0.4, 0.22, 0.34], hoverMix: 0.3, activeMix: 0.12, periodAlpha: 0.6, darkInkMix: 0.87, inkAlpha: 0.82, subDarkMix: 0.32 },
	},
};

/** 各预设的主色/墨色默认值（= 浅态 banner-3 与 tab-ink；设置面板默认显示它们）。 */
export const PRESET_DEFAULTS: Record<PlanFlowSkin, CustomSkinOverride> = {
	sky: { accent: "#b2d2ea", ink: "#1f4a72" },
	paper: { accent: "#e7dcc3", ink: "#4d4335" },
	midnight: { accent: "#c4d0de", ink: "#33475e" },
	pine: { accent: "#abc9ae", ink: "#2c4a3a" },
};

/**
 * 派生可能写入的全部令牌键（浅态 ∪ 深态）。
 * 用途：applySkin 切回纯预设时按这张表**逐个 removeProperty**——
 * 不能只删上一次写的键（上次深态写的 pfs-sub 这次浅态不写，会残留）。
 */
export const CUSTOM_TOKEN_KEYS: readonly string[] = [
	"--pf-banner-1", "--pf-banner-2", "--pf-banner-3",
	"--pf-tab-ink", "--pf-tab-ink-hover", "--pf-tab-ink-active",
	"--pf-tab-hair", "--pf-tab-open-shadow",
	"--pf-period-ink", "--pfs-sub",
];

function hexToRgb(hex: string): RGB {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** a → b 混 t（t=0 全 a，1 全 b）。 */
function mix(a: RGB, b: RGB, t: number): RGB {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const toHex = (c: RGB) => "#" + c.map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");
const rgba = (c: RGB, a: number) => `rgba(${clamp255(c[0])}, ${clamp255(c[1])}, ${clamp255(c[2])}, ${a})`;

/**
 * 派生自定义令牌表（只含 CUSTOM_TOKEN_KEYS 范围内的可重算令牌）。
 * 开口色/画布膜不在表内——它们由 styles.css v8.6 从 --pf-banner-3 派生
 * （本函数写 banner-3 即间接驱动），无需在此重算。
 * dark=true 走深态配方。输入 hex 假定已过 normalizeHex。
 */
export function deriveTokens(base: PlanFlowSkin, ov: CustomSkinOverride, dark: boolean): Record<string, string> {
	const recipe = SKIN_RECIPES[base];
	const accent = hexToRgb(ov.accent);
	const ink = hexToRgb(ov.ink);
	const out: Record<string, string> = {};
	if (!dark) {
		const r: SkinLightRecipe = recipe.light;
		const [m1, m2] = r.bannerMix;
		const b2 = mix(accent, [255, 255, 255], m1);
		const b1 = mix(b2, [255, 255, 255], m2);
		out["--pf-banner-1"] = toHex(b1);
		out["--pf-banner-2"] = toHex(b2);
		out["--pf-banner-3"] = toHex(accent);
		out["--pf-tab-ink"] = toHex(ink);
		out["--pf-tab-ink-hover"] = toHex(mix(ink, [0, 0, 0], r.inkHover));
		out["--pf-tab-ink-active"] = toHex(mix(ink, [0, 0, 0], r.inkActive));
		out["--pf-tab-hair"] = rgba(ink, r.hairAlpha);
		out["--pf-tab-open-shadow"] = rgba(ink, r.shadowAlpha);
		out["--pf-period-ink"] = toHex(mix(ink, [255, 255, 255], r.periodMix));
		if (r.subMix != null) out["--pfs-sub"] = toHex(mix(ink, [255, 255, 255], r.subMix));
	} else {
		const r: SkinDarkRecipe = recipe.dark;
		const [a1, a2, a3] = r.bannerAlphas;
		out["--pf-banner-1"] = rgba(accent, a1);
		out["--pf-banner-2"] = rgba(accent, a2);
		out["--pf-banner-3"] = rgba(accent, a3);
		const dInk = mix(ink, [255, 255, 255], r.darkInkMix);
		out["--pf-tab-ink"] = rgba(dInk, r.inkAlpha);
		out["--pf-tab-ink-hover"] = toHex(mix(dInk, [255, 255, 255], r.hoverMix));
		out["--pf-tab-ink-active"] = toHex(mix(dInk, [255, 255, 255], r.activeMix));
		out["--pf-period-ink"] = rgba(dInk, r.periodAlpha);
		if (r.subDarkMix != null) out["--pfs-sub"] = toHex(mix(dInk, [0, 0, 0], r.subDarkMix));
	}
	return out;
}
