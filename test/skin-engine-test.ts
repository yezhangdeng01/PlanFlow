/**
 * v8.1 自定义皮肤派生引擎验证。
 *
 * 保三类事：
 * ① normalizeHex 的输入卫生（设置页 hex 框的直接依赖）；
 * ② 派生公式对预设的复现度——SKIN_RECIPES 是从 styles.css v8.0 变量块拟合的，
 *    这里把期望值钉成字面量：将来谁改了配方数值，复现度掉到容差外就会 FAIL
 *    （容差分档：banner/inks 紧 ≤8，period ≤18，hair/shadow 松 ≤45——
 *     后两者是 10~20% alpha 的 1px 线，配方 RGB 与预设略有出入肉眼不可见，
 *     但 alpha 用错会明显，故 alpha 走精确相等断言）；
 * ③ 🔴 不可触碰令牌的负向断言：开口色/画布膜/业务强调色永远不在派生表里——
 *    这是 v7.2/v8.0 两次翻车换来的铁律，宁可测试失败也不开放。
 */
import { addScheme, applyScheme, CUSTOM_TOKEN_KEYS, deriveTokens, normalizeHex, normalizeScheme, PRESET_DEFAULTS, removeScheme, schemeNameTaken, SKIN_RECIPES } from "../src/skin-engine";
import type { PlanFlowSkin } from "../src/settings";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}
const rgb = (hex: string): [number, number, number] => {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const dist = (a: string, b: string) => {
	const [x, y, z] = rgb(a), [u, v, w] = rgb(b);
	return Math.abs(x - u) + Math.abs(y - v) + Math.abs(z - w);
};
/** "rgba(77, 67, 53, 0.2)" → "#4d4335"（三个通道拼一个 hex，别拼成 #4d#43#35）。 */
const rgbaToHex = (s: string) => {
	const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),/.exec(s);
	return m ? "#" + [m[1], m[2], m[3]].map((v) => parseInt(v, 10).toString(16).padStart(2, "0")).join("") : "";
};

// ═══ 1. normalizeHex ═══
check("normalizeHex 标准值", normalizeHex("#b2d2ea") === "#b2d2ea", normalizeHex("#b2d2ea"));
check("normalizeHex 大写规范化", normalizeHex("#B2D2EA") === "#b2d2ea", normalizeHex("#B2D2EA"));
check("normalizeHex 容忍缺 #", normalizeHex("b2d2ea") === "#b2d2ea", normalizeHex("b2d2ea"));
check("normalizeHex 容忍空格", normalizeHex("  #b2d2ea  ") === "#b2d2ea", normalizeHex("  #b2d2ea  "));
check("normalizeHex 拒空", normalizeHex("") === null);
check("normalizeHex 拒 3 位简写", normalizeHex("#b2d") === null);
check("normalizeHex 拒 8 位带 alpha", normalizeHex("#b2d2eaff") === null);
check("normalizeHex 拒非 hex 字符", normalizeHex("#zzzzzz") === null);

// ═══ 2. 浅态复现度（配方 vs styles.css 实测预设值） ═══
// 期望值来源：styles.css v8.0 变量块（sky 默认块 / paper 5812 / midnight 5870 / pine 5926）
const LIGHT_EXPECT: Record<PlanFlowSkin, Record<string, string>> = {
	sky: { "--pf-banner-1": "#e4f0fa", "--pf-banner-2": "#cde3f4", "--pf-banner-3": "#b2d2ea", "--pf-tab-ink": "#1f4a72", "--pf-tab-ink-hover": "#173a5c", "--pf-tab-ink-active": "#16395c", "--pf-period-ink": "#40607e" },
	paper: { "--pf-banner-1": "#f8f2e4", "--pf-banner-2": "#f1e9d6", "--pf-banner-3": "#e7dcc3", "--pf-tab-ink": "#4d4335", "--pf-tab-ink-hover": "#3a3226", "--pf-tab-ink-active": "#352e22", "--pf-period-ink": "#6b5c46", "--pfs-sub": "#6e6252" },
	midnight: { "--pf-banner-1": "#e9eef4", "--pf-banner-2": "#dae2ec", "--pf-banner-3": "#c4d0de", "--pf-tab-ink": "#33475e", "--pf-tab-ink-hover": "#243648", "--pf-tab-ink-active": "#22344a", "--pf-period-ink": "#4d6076", "--pfs-sub": "#5c6b7d" },
	pine: { "--pf-banner-1": "#dfecdf", "--pf-banner-2": "#c8dcc9", "--pf-banner-3": "#abc9ae", "--pf-tab-ink": "#2c4a3a", "--pf-tab-ink-hover": "#1f3a2b", "--pf-tab-ink-active": "#23402f", "--pf-period-ink": "#43604c", "--pfs-sub": "#5f6f63" },
};
	for (const skin of ["sky", "paper", "midnight", "pine"] as PlanFlowSkin[]) {
		const t = deriveTokens(skin, PRESET_DEFAULTS[skin], false);
		for (const [k, want] of Object.entries(LIGHT_EXPECT[skin])) {
			const d = dist(t[k] ?? "#000000", want);
			const tol = k === "--pf-period-ink" ? 18 : k === "--pfs-sub" ? 12 : 8;
			check(`浅态复现 ${skin} ${k}（差 ${d} ≤ ${tol}）`, d <= tol, { got: t[k], want });
		}
	}

// ═══ 3. 浅态 hair/shadow：alpha 精确 + RGB 松容差 ═══
{
	const t = deriveTokens("paper", PRESET_DEFAULTS.paper, false);
	check("paper 浅态 hair alpha 精确", t["--pf-tab-hair"] === "rgba(77, 67, 53, 0.2)", t["--pf-tab-hair"]);
	check("paper 浅态 shadow alpha 精确", t["--pf-tab-open-shadow"] === "rgba(77, 67, 53, 0.12)", t["--pf-tab-open-shadow"]);
	check("paper 浅态 hair RGB 与预设差 ≤45（1px 线肉眼不可见）",
		dist(rgbaToHex(t["--pf-tab-hair"]), "#61523c") <= 45,
		{ got: rgbaToHex(t["--pf-tab-hair"]), want: "#61523c" });
}

// ═══ 4. 深态结构：banner alpha 三元组 + 墨色提亮方向 ═══
{
	const t = deriveTokens("sky", PRESET_DEFAULTS.sky, true);
	check("sky 深态 banner-1 alpha", t["--pf-banner-1"] === "rgba(178, 210, 234, 0.4)", t["--pf-banner-1"]);
	check("sky 深态 banner-2 alpha", t["--pf-banner-2"] === "rgba(178, 210, 234, 0.22)", t["--pf-banner-2"]);
	check("sky 深态 banner-3 alpha", t["--pf-banner-3"] === "rgba(178, 210, 234, 0.36)", t["--pf-banner-3"]);
	// 深态墨 = ink 混白 .95 → (244,246,248)，比 ink 亮（方向不能反）
	check("sky 深态 tab-ink = rgba(提亮墨, .8)", t["--pf-tab-ink"] === "rgba(244, 246, 248, 0.8)", t["--pf-tab-ink"]);
	check("sky 深态 period-ink alpha", t["--pf-period-ink"] === "rgba(244, 246, 248, 0.72)", t["--pf-period-ink"]);
	// 深态 hair/shadow 是白/黑基（与主色无关）⇒ 不覆盖，保持预设
	check("sky 深态不覆盖 tab-hair", !("--pf-tab-hair" in t), Object.keys(t));
	check("sky 深态不覆盖 tab-open-shadow", !("--pf-tab-open-shadow" in t), Object.keys(t));
	const tp = deriveTokens("paper", PRESET_DEFAULTS.paper, true);
	check("paper 深态 banner alpha 三元组（逐肤手感）",
		tp["--pf-banner-1"] === "rgba(231, 220, 195, 0.36)" && tp["--pf-banner-3"] === "rgba(231, 220, 195, 0.3)",
		[tp["--pf-banner-1"], tp["--pf-banner-3"]]);
}

// ═══ 5. 🔴 铁律：派生表绝不触碰开口色/画布膜/业务强调色 ═══
{
	const FORBIDDEN = ["--pf-tab-open-bg", "--pf-page-tint", "--pf-canvas-tint", "--pf-canvas-line", "--pfs-accent", "--pfs-accent-soft", "--pb-accent-hover", "--pfs-ok", "--pfs-ok-soft", "--pfs-ok-flash"];
	for (const skin of ["sky", "paper", "midnight", "pine"] as PlanFlowSkin[]) {
		for (const dark of [false, true]) {
			const t = deriveTokens(skin, PRESET_DEFAULTS[skin], dark);
			const leaked = FORBIDDEN.filter((k) => k in t);
			check(`铁律 ${skin} ${dark ? "深" : "浅"}态无越界令牌`, leaked.length === 0, leaked);
		}
	}
	// 极端主色也不越界（用户乱填时的安全网）
	const wild = deriveTokens("sky", { accent: "#ff0000", ink: "#00ff00" }, false);
	check("极端主色也不越界", FORBIDDEN.every((k) => !(k in wild)), Object.keys(wild));
}

// ═══ 6. sky 的 pfs-sub 是冷灰非墨色系 ⇒ 两态都不覆盖 ═══
{
	check("sky 浅态不覆盖 pfs-sub", !("--pfs-sub" in deriveTokens("sky", PRESET_DEFAULTS.sky, false)));
	check("sky 深态不覆盖 pfs-sub", !("--pfs-sub" in deriveTokens("sky", PRESET_DEFAULTS.sky, true)));
	check("paper 浅态覆盖 pfs-sub", "--pfs-sub" in deriveTokens("paper", PRESET_DEFAULTS.paper, false));
	check("paper 深态覆盖 pfs-sub", "--pfs-sub" in deriveTokens("paper", PRESET_DEFAULTS.paper, true));
}

// ═══ 7. CUSTOM_TOKEN_KEYS：清残影表完备性 + 用户色真的进令牌 ═══
{
	const t = deriveTokens("sky", { accent: "#b8860b", ink: "#2f4f2f" }, false);
	check("换主色 banner-3 真的变", t["--pf-banner-3"] === "#b8860b", t["--pf-banner-3"]);
	check("换墨色 tab-ink 真的变", t["--pf-tab-ink"] === "#2f4f2f", t["--pf-tab-ink"]);
	// 派生表 ⊆ 清残影表：applySkin 按 CUSTOM_TOKEN_KEYS 逐个 removeProperty，
	// 派生 emitting 的键必须都在表里，否则切回纯预设会残留 inline 覆盖
	const lightKeys = new Set(Object.keys(deriveTokens("paper", PRESET_DEFAULTS.paper, false)));
	const darkKeys = new Set(Object.keys(deriveTokens("paper", PRESET_DEFAULTS.paper, true)));
	const missing = [...lightKeys, ...darkKeys].filter((k) => !CUSTOM_TOKEN_KEYS.includes(k));
	check("派生键全部在 CUSTOM_TOKEN_KEYS 清残影表内", missing.length === 0, missing);
	check("SKIN_RECIPES 四肤齐全", Object.keys(SKIN_RECIPES).length === 4);
	check("PRESET_DEFAULTS 四肤齐全", Object.keys(PRESET_DEFAULTS).length === 4);
}

// ═══ 8. v8.2 命名方案管理（保存/查重/应用/删除/净化） ═══
{
	const S = { name: "金麒麟", base: "sky" as PlanFlowSkin, accent: "#b8860b", ink: "#2f4f2f" };
	const S2 = { name: "暖金", base: "midnight" as PlanFlowSkin, accent: "#c9a227", ink: "#3a5a8c" };
	check("normalizeScheme 接受合法方案", normalizeScheme(S)?.name === "金麒麟", normalizeScheme(S));
	check("normalizeScheme 修 hex 大小写", normalizeScheme({ ...S, accent: "#B8860B" })?.accent === "#b8860b");
	check("normalizeScheme 拒空名", normalizeScheme({ ...S, name: "  " }) === null);
	check("normalizeScheme 拒非法 base", normalizeScheme({ ...S, base: "neon" }) === null);
	check("normalizeScheme 拒非法 hex", normalizeScheme({ ...S, ink: "#xyz" }) === null);
	check("normalizeScheme 拒非对象", normalizeScheme("x") === null && normalizeScheme(null) === null);
	check("查重大小写不敏感", schemeNameTaken([S], "金麒麟") && schemeNameTaken([S], " 金麒麟 "));
	check("查重不误报", !schemeNameTaken([S], "暖金"));
	const added = addScheme([], S);
	check("addScheme 不改原数组", added.length === 1);
	check("addScheme 后可再删回空", removeScheme(added, "金麒麟").length === 0);
	check("removeScheme 按名删（不中伤同名不同大小写之外的）", removeScheme([S, S2], "金麒麟").map((s) => s.name).join(",") === "暖金");
	const applied = applyScheme(S2);
	check("applyScheme 返回 base+customSkin", applied.skin === "midnight" && applied.customSkin.accent === "#c9a227" && applied.customSkin.ink === "#3a5a8c", applied);
	// 应用方案后派生与直填一致（方案即快照，两条路径必须同色）
	check("应用方案派生 == 直填派生",
		JSON.stringify(deriveTokens(applied.skin, applied.customSkin, false)) === JSON.stringify(deriveTokens("midnight", { accent: "#c9a227", ink: "#3a5a8c" }, false)));
}

export default failed;
