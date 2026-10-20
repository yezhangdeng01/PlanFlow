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

/**
 * v8.11 按名原地替换（「保存」覆盖当前方案）；返回新数组。
 * 保持原位置——否则覆盖后下拉选项顺序会跳动，用户会觉得方案"换了地方"。
 */
export function replaceScheme(schemes: CustomSkinScheme[], s: CustomSkinScheme): CustomSkinScheme[] {
	return schemes.map((x) => (x.name === s.name ? s : x));
}

/** 应用方案 = 得到应写入 settings 的 skin 与 customSkin（调用方 save + applySkinToViews）。 */
export function applyScheme(s: CustomSkinScheme): { skin: PlanFlowSkin; customSkin: CustomSkinOverride } {
	return { skin: s.base, customSkin: { accent: s.accent, ink: s.ink } };
}

/** 皮肤下拉的当前外观快照（= settings.skin + settings.customSkin）。 */
export interface SkinSelectionInput {
	skin: PlanFlowSkin;
	customSkin: CustomSkinOverride | null;
}

/**
 * v8.10：决定「皮肤主题」下拉该显示哪一项（纯决策，无副作用，便于单测）。
 *
 * 三层优先级：
 * ① 外观恰好等于某个已存方案（base + 主色 + 墨色全等）→ 显示该方案；
 * ② 外观已被微调、不再等于任何方案，但 remembered（上次选中/正在编辑的方案）
 *    仍存在 → **仍显示它**。用户正在「青空」上改颜色，名字不该突然跳回预设；
 * ③ 否则回落基底预设。
 *
 * ②是 v8.10 修的 bug：原先改色后下拉直接回落基底预设，用户以为自己的方案丢了。
 * 注意 ② 只在 customSkin 非空时生效——纯预设外观不该顶着方案名。
 */
export function resolveSkinSelection(
	schemes: CustomSkinScheme[],
	current: SkinSelectionInput,
	remembered: string | null,
): { kind: "scheme"; name: string } | { kind: "preset"; skin: PlanFlowSkin } {
	const c = current.customSkin;
	if (c) {
		const hit = schemes.find((s) => s.base === current.skin && s.accent === c.accent && s.ink === c.ink);
		if (hit) return { kind: "scheme", name: hit.name };
		if (remembered && schemes.some((s) => s.name === remembered)) {
			return { kind: "scheme", name: remembered };
		}
	}
	return { kind: "preset", skin: current.skin };
}

type RGB = [number, number, number];

/** 浅态配方（全部必需——deriveTokens 不做 optional 兜底，缺字段直接编译期暴露）。 */
interface SkinLightRecipe {
	/** banner 末档 → 中档、中档 → 顶档 的混合比例（默认向白混；bannerBase 可改成向深色混）。 */
	bannerMix: [number, number];
	/**
	 * v8.15：banner 混合目标色，缺省 = 白。
	 * 夜阑这类「深底 + 亮墨」皮肤必须向夜色混——否则主色越深、顶栏反而越亮，
	 * 墨一改亮就整片糊在一起（v8.14 之前的假设是「顶栏恒亮、墨恒暗」）。
	 */
	bannerBase?: RGB;
	/** ink → ink-hover 混合比例：正 = 混黑，**负 = 混白**（亮墨皮肤的 hover 要更亮，不是更暗）。 */
	inkHover: number;
	/**
	 * ink → ink-active 混合比例；null = 不派生。
	 * 夜阑的活动页签落在**浅色开口**上（开口色本就不派生），墨必须压回深色，
	 * 无法从烛光墨推出来 ⇒ 交回预设手配，与「开口色不派生」的规矩一致。
	 */
	inkActive: number | null;
	/** ink → period-ink 混白比例；null = 不派生（亮墨皮肤的 period 只能往暗里调，交回预设）。 */
	periodMix: number | null;
	/** tab-hair / open-shadow = rgba(ink, alpha)。 */
	hairAlpha: number;
	shadowAlpha: number;
	/** ink → pfs-sub 混白比例；null = 该预设 pfs-sub 非墨色系（sky 冷灰 / midnight 亮墨），不覆盖。 */
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
		// v8.15：夜阑是全套里唯一的**夜肤**——顶栏向夜色混（不再向白混），墨是烛光。
		// bannerMix 越大越深；bannerBase 是夜色底（不用纯黑，留一点蓝紫）。
		// inkHover 取负 = 混白（烛芯拨亮）；inkActive/periodMix/subMix 都不派生，交回预设手配。
		light: { bannerMix: [0.3, 0.26], bannerBase: [20, 26, 46], inkHover: -0.05, inkActive: null, periodMix: null, hairAlpha: 0.16, shadowAlpha: 0.34, subMix: null },
		// 深态：darkInkMix 压到 0.12——烛光墨本身已经够亮，再混白就洗成中性白、丢掉暖意
		dark: { bannerAlphas: [0.42, 0.24, 0.38], hoverMix: 0.3, activeMix: 0.12, periodAlpha: 0.58, darkInkMix: 0.12, inkAlpha: 0.86, subDarkMix: 0.34 },
	},
	pine: {
		light: { bannerMix: [0.34, 0.42], inkHover: 0.26, inkActive: 0.18, periodMix: 0.11, hairAlpha: 0.18, shadowAlpha: 0.1, subMix: 0.22 },
		dark: { bannerAlphas: [0.4, 0.22, 0.34], hoverMix: 0.3, activeMix: 0.12, periodAlpha: 0.6, darkInkMix: 0.87, inkAlpha: 0.82, subDarkMix: 0.32 },
	},
};

/** 各预设的主色/墨色默认值（= 浅态 banner-3 与 tab-ink；设置面板默认显示它们）。 */
export const PRESET_DEFAULTS: Record<PlanFlowSkin, CustomSkinOverride> = {
	// v8.12（用户 20261020）：晴空预设吸收原自定义「青空」的配色——
	// 旧 #b2d2ea 饱和度仅 57% 偏灰，用户要求「用青空的配色替换原来的晴空天蓝，名字不变」。
	// 新 accent = #95d0fe（饱和度 98%）；ink = #8a5f1f（深古铜金，白底 5.7:1 / 顶栏 3.4:1）。
	// ⚠️ 改这里必须同步 styles.css 的 sky 令牌块（浅色 + 深色 banner），否则预设与
	// 「以预设为基础的自定义」会两套色，复现度测试（LIGHT_EXPECT.sky）也会失败。
	sky: { accent: "#95d0fe", ink: "#8a5f1f" },
	paper: { accent: "#e7dcc3", ink: "#4d4335" },
	// v8.15（用户 20261020）：「用符合名字的更深一点的配色，更静谧一点…主色深了，墨色反而可以用烛光」。
	// 全流程：石板灰蓝 #c4d0de →（v8.13）深靛紫 #a9a0e2 →（v8.14）群青 #9aa4dc →
	// （v8.16 定版）**深夜靛底 + 烛光墨**：主色压到 #2c3258（L26），墨色翻成烛光 #ffe0ae（H37 S100 L84）。
	// 这是四套里唯一的「深底亮墨」皮肤 ⇒ 顶栏配方改为向夜色混（bannerBase），
	// 活动页签落在浅色开口上、墨压回深靛（inkActive 不派生，见 styles.css）。
	// 对比度：烛光墨 / 顶栏顶档 #212744 ≈ 11.9、/ 末档 #2c3258 ≈ 9.9（要求 4.5）。
	midnight: { accent: "#2c3258", ink: "#ffe0ae" },
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
	// v8.17：画布膜/开口色的色源（自定义主色时现算，覆盖皮肤块的预设值）
	"--pf-tint-accent",
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
/** 感知亮度（Rec.601）> 140 视为「亮墨」：夜阑的烛光墨就属于这一类。 */
const isLightColor = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 140;

/** RGB → [色相 0..360, 饱和度 0..1]（膜色源只关心这两项，明度另行定档）。 */
function rgbHueSat(c: RGB): [number, number] {
	const r = c[0] / 255;
	const g = c[1] / 255;
	const b = c[2] / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	if (d === 0) return [0, 0];
	let h: number;
	if (max === r) h = ((g - b) / d) % 6;
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	h *= 60;
	if (h < 0) h += 360;
	const s = Math.min(1, d / (1 - Math.abs(2 * l - 1))); // l=0/1 时除零 → 钳到 1
	return [h, s];
}

/** HSL → RGB（h 0..360、s/l 0..1）。 */
function hslToRgb(h: number, s: number, l: number): RGB {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const t: RGB =
		h < 60 ? [c, x, 0] :
		h < 120 ? [x, c, 0] :
		h < 180 ? [0, c, x] :
		h < 240 ? [0, x, c] :
		h < 300 ? [x, 0, c] :
		[c, 0, x];
	return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
}

/**
 * v8.17 膜色源（--pf-tint-accent）：主色 → 「同色相 + 中明度」的一支。
 * 画布两层膜 / 描边 / 开口色全由 styles.css 按**固定浓度**从它合成
 * （浅 7.5% / 5.5% / 10%，深 5% / 7% / 16%），四套预设与自定义走同一条链。
 *
 * 🔴 铁律（v8.16b 实测）：不是「主色 × 固定系数」。固定系数对深主色会塌成黑——
 * 夜阑主色 L26×0.53 = L14，6% 叠在白上只剩 Δ(B-R)=5 的灰，用户原话
 * 「怎么看不出来」。改成「先拉到中明度再上膜」才四套通用。
 * 明度定档：浅 0.44（四套预设校准值的均值落 42~47）、深 0.66；
 * 饱和度按档钳制：免得纯高饱和主色做出彩膜。**主色本身近乎无色时不钳制**——
 * 那不是「膜太淡」，是用户就选了灰，凭空造色相会变成红膜（HSL 里灰的 h=0）。
 */
function tintAccent(accent: RGB, dark: boolean): string {
	const [h, s] = rgbHueSat(accent);
	const l = dark ? 0.66 : 0.44;
	// 主色近乎无色（用户就是选了灰）⇒ 不凭空造色相：HSL 里灰色的 h 是 0（红），
	// 按饱和度下限硬拉会做出红膜。这种情况保持中性膜。
	if (s < 0.06) return toHex(hslToRgb(0, 0, l));
	const lo = dark ? 0.35 : 0.18;
	const hi = dark ? 0.8 : 0.85;
	return toHex(hslToRgb(h, Math.min(hi, Math.max(lo, s)), l));
}


/**
 * 派生自定义令牌表（只含 CUSTOM_TOKEN_KEYS 范围内的可重算令牌）。
 * v8.17：画布膜/开口色已并入本表——不再是「styles.css 从 banner-3 反推」，
 * 而是本函数算出 --pf-tint-accent（见 tintAccent），CSS 只负责按固定浓度合成。
 * 业务强调色（--pfs-accent 等）仍不在表内，保持预设。
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
		const bannerBase = r.bannerBase ?? ([255, 255, 255] as RGB);
		const b2 = mix(accent, bannerBase, m1);
		const b1 = mix(b2, bannerBase, m2);
		out["--pf-banner-1"] = toHex(b1);
		out["--pf-banner-2"] = toHex(b2);
		out["--pf-banner-3"] = toHex(accent);
		out["--pf-tab-ink"] = toHex(ink);
		// inkHover 允许负数 = 往白里提（亮墨皮肤 hover 要更亮）；mix 的 clamp255 会兜住溢出
		out["--pf-tab-ink-hover"] = toHex(mix(ink, [0, 0, 0], r.inkHover));
		if (r.inkActive != null) out["--pf-tab-ink-active"] = toHex(mix(ink, [0, 0, 0], r.inkActive));
		out["--pf-tab-hair"] = rgba(ink, r.hairAlpha);
		// v8.15：墨本身是亮色（夜阑烛光墨）时开口阴影必须走黑——rgba(亮墨, α) 是发光不是阴影
		out["--pf-tab-open-shadow"] = rgba(isLightColor(ink) ? [0, 0, 0] : ink, r.shadowAlpha);
		if (r.periodMix != null) out["--pf-period-ink"] = toHex(mix(ink, [255, 255, 255], r.periodMix));
		if (r.subMix != null) out["--pfs-sub"] = toHex(mix(ink, [255, 255, 255], r.subMix));
		// v8.17：画布膜/开口色的色源（预设用实测校准值，自定义走这条统一规则）
		out["--pf-tint-accent"] = tintAccent(accent, false);
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
		// v8.17：深态膜色源（同色相、提到 L66——暗底上的膜要亮的一支才看得出）
		out["--pf-tint-accent"] = tintAccent(accent, true);
	}
	return out;
}
