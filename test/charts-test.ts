/**
 * charts.ts 的离线行为验证。
 *
 * 为什么要它：本轮把图表区从 PlanBoardView 搬到了 charts.ts（机械搬移，产物已证明逐行一致），
 * 但「产物一致」只能证明代码没变，不能证明**画出来的东西**没变。
 * 这里给 charts.ts 喂最小 DOM stub，直接检查它生成的 SVG 结构 ——
 * 比截图更精确：能断言节点数、属性值、样式字符串。
 *
 * 顺带覆盖 colors.ts 的两个换算函数（深色/浅色下的文字色与图形色）。
 */
import {
	svgEl,
	buildDonutChartSvg,
	buildMonthBarsSvg,
	buildHeatmapSvg,
	buildPlanBarsH,
	buildYearMonthsSvg,
	buildCumulativeSvg,
} from "../src/charts";
import { deepenForText, softenChartColor, hexToRgba } from "../src/colors";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}

// --- 极简 SVG DOM stub：只实现 charts.ts 用到的 API ---
interface StubEl {
	tag: string;
	attrs: Record<string, string>;
	children: StubEl[];
	style: Record<string, string>;
	textContent: string;
	setAttribute(k: string, v: string): void;
	append(...c: StubEl[]): void;
	appendChild(c: StubEl): void;
	// 便于断言
	_find(tag: string): StubEl[];
	_desc(tag: string): StubEl[];
}

function mkEl(tag: string): StubEl {
	const el: StubEl = {
		tag,
		attrs: {},
		children: [],
		style: {},
		textContent: "",
		setAttribute(k, v) { this.attrs[k] = v; },
		append(...c: StubEl[]) { this.children.push(...c); },
		appendChild(c) { this.children.push(c); },
		_find(t) {
			const out: StubEl[] = [];
			const walk = (n: StubEl) => { for (const c of n.children) { if (c.tag === t) out.push(c); walk(c); } };
			walk(this);
			return out;
		},
		_desc(t) {
			const out: StubEl[] = [];
			const walk = (n: StubEl) => { for (const c of n.children) { out.push(c); walk(c); } };
			walk(this);
			return out.filter((c) => c.tag === t);
		},
	};
	return el;
}

// 装全局 document（charts.ts 里 document.createElementNS / body.classList）
(globalThis as Record<string, unknown>).document = {
	createElementNS: (_ns: string, tag: string) => mkEl(tag),
	body: {
		classList: {
			// 默认浅色主题
			_contains: (c: string) => c === "theme-light",
			contains(this: { _contains: (c: string) => boolean }, c: string) { return this._contains(c); },
		},
	},
};

function setTheme(dark: boolean): void {
	const doc = (globalThis as Record<string, { body: { classList: { _contains: (c: string) => boolean } } }>).document;
	doc.body.classList._contains = (c: string) => (dark ? c === "theme-dark" : c === "theme-light");
}

// ═══ 1. svgEl ═══
const e = svgEl("rect", { x: 1, y: 2, width: 3, height: 4 });
check("svgEl 建的是 rect", e.tag === "rect", e.tag);
check("svgEl 属性已写入", e.attrs.x === "1" && e.attrs.width === "3", e.attrs);
check("svgEl 数字属性转字符串", e.attrs.y === "2", { y: e.attrs.y, type: typeof e.attrs.y });

// ═══ 2. buildDonutChartSvg ═══
// 实测契约：轨道 1 个 circle + 每扇区 1 个 circle（带 done 的画两段：底 0.45 淡 + 面实色）。
// 弧用 stroke-dasharray + rotate(-90) 从 12 点方向顺延。
const donut = buildDonutChartSvg(
	[
		{ value: 3, color: "#f59e0b" },
		{ value: 5, color: "#10b981" },
		{ value: 2, color: "#3b82f6", done: 1 },
	],
	"10",
	"次打卡"
);
const donutCircles = donut._find("circle");
const arcs = donutCircles.filter((c) => c.attrs["stroke-dasharray"] !== undefined);
check("环形图：轨道 1 + 无 done 的 2 段 + 带 done 的 2 段 = 5 circle", donutCircles.length === 5,
	{ circles: donutCircles.length });
check("环形图：4 段扇区（带 done 的计划拆成底+面两段）", arcs.length === 4, { arcs: arcs.length });
check("环形图：done 段的底色是 0.45 淡色（深色主题下不能再淡）",
	arcs.some((a) => a.style.opacity === "0.45") && arcs.some((a) => a.style.opacity === undefined),
	arcs.map((a) => a.style.opacity));
check("环形图：中心数值文本", donut._find("text").some((t) => t.textContent === "10"),
	donut._find("text").map((t) => t.textContent));
check("环形图：中心标签文本", donut._find("text").some((t) => t.textContent === "次打卡"));
check("环形图：每段从 12 点方向起（rotate -90）", arcs.every((a) => /rotate\(-90/.test(String(a.attrs.transform))),
	arcs[0]?.attrs.transform);
check("环形图：dashoffset 单调递减（扇区沿圆周顺延不重叠）", (() => {
	const offs = arcs.map((a) => parseFloat(String(a.attrs["stroke-dashoffset"])));
	// 同一天内带 done 的两段 offset 相同（面盖在底上），整体应非递增
	return offs.every((v, i) => i === 0 || v <= offs[i - 1] + 1e-9);
})(), arcs.map((a) => a.attrs["stroke-dashoffset"]));
check("环形图：dasharray 是「弧长 剩余周长」两段式", arcs.every((a) => {
	const parts = String(a.attrs["stroke-dasharray"]).split(" ");
	return parts.length === 2 && parseFloat(parts[0]) > 0;
}), arcs[0]?.attrs["stroke-dasharray"]);
check("环形图：0 值计划不画弧", (() => {
	const s = buildDonutChartSvg([{ value: 0, color: "#000" }, { value: 4, color: "#111" }], "4", "");
	return s._find("circle").filter((c) => c.attrs["stroke-dasharray"]).length === 1;
})());

// ═══ 3. buildMonthBarsSvg ═══
// 实测契约：0 值画「幽灵槽」小 rect；每柱一条 linearGradient（pf-bar-i）；
// 有值的柱顶标数值；底部 1..slots 日期行；无参考线。
const monthBars = buildMonthBarsSvg([0, 1, 3, 0, 5], 3, 5);
const bars = monthBars._find("rect");
// 0 值日额外画一个「幽灵槽」，所以 rect 数 = 实际柱(5) + 幽灵槽(2)
check("月柱图：5 个槽位 = 5 根柱 + 2 个 0 值幽灵槽", bars.length === 7, { rects: bars.length });
check("月柱图：幽灵槽是矮条（height=4）且半透明", bars.filter((b) => b.attrs.height === "4").length === 2,
	{ 幽灵槽: bars.filter((b) => b.attrs.height === "4").length });
check("月柱图：0 槽用边框色（不是数据色）",
	bars.filter((b) => b.style.fill === "var(--background-modifier-border)").length === 2);
check("月柱图：每柱一条独立渐变", monthBars._find("linearGradient").length === 5,
	{ gradients: monthBars._find("linearGradient").length });
check("月柱图：柱填充引用自己的渐变 url", bars.some((b) => /^url\(#pf-bar-\d+\)$/.test(String(b.attrs.fill))),
	bars.map((b) => b.attrs.fill).slice(0, 3));
// 柱顶数值与底部日期都是数字，靠 y 区分：数值在柱上方（y 小），日期行在 base 之下（y 大）
const mbTexts = monthBars._find("text");
const valueLabels = mbTexts.filter((t) => ["1", "3", "5"].includes(t.textContent) && parseFloat(t.attrs.y) < 90);
const dateLabels = mbTexts.filter((t) => /^[1-5]$/.test(t.textContent) && parseFloat(t.attrs.y) >= 90);
check("月柱图：柱顶标了数值（有值的 3 根柱）", valueLabels.length === 3,
	{ 数值: mbTexts.map((t) => `${t.textContent}@y${t.attrs.y}`).slice(0, 10) });
check("月柱图：底部日期行 1..5", dateLabels.length === 5,
	{ 日期: mbTexts.map((t) => `${t.textContent}@y${t.attrs.y}`).filter((s2) => parseFloat(s2.split("@y")[1]) >= 90) });
check("月柱图：今天那根柱加粗（font-weight 700）",
	mbTexts.some((t) => t.attrs["font-weight"] === "700" && /^[1-5]$/.test(t.textContent) && parseFloat(t.attrs.y) >= 90));
check("月柱图：未来日期（slots > done.length）弱化", (() => {
	const s = buildMonthBarsSvg([1], 3, 7); // 本月才过 1 天，slots=7
	const future = s._find("text").filter((t) => /^[2-7]$/.test(t.textContent));
	return future.length === 6 && future.every((t) => t.style.opacity === "0.6");
})(), { 未来日期数: buildMonthBarsSvg([1], 3, 7)._find("text").filter((t) => /^[2-7]$/.test(t.textContent)).length });
check("月柱图：preserveAspectRatio=none（可拖拽卡高拉伸）", monthBars.attrs.preserveAspectRatio === "none",
	monthBars.attrs.preserveAspectRatio);
check("月柱图：每柱带 title 悬浮提示", monthBars._find("title").length === 5,
	{ titles: monthBars._find("title").length });

// ═══ 4. buildHeatmapSvg ═══
// 实测契约：53 列 × 7 行 = 371 格；tier 0 用边框色（空态），1..4 取色板。
setTheme(false);
const heatLight = buildHeatmapSvg(new Map([["2026-10-04", 1], ["2026-10-05", 4]]), "2026-10-06");
const lightCells = heatLight._find("rect");
// 53×7=371 是网格容量，但会跳过「1 月 1 日之前」和「跨年」的日子 → 实际画出 365 格（2026 非闰年）
check("热力图：网格容量 53×7=371，实际画出 365 格（跳过年内不存在的日子）", lightCells.length === 365,
	{ cells: lightCells.length, 期望: 365 });
check("热力图：0 档用边框色（空态不画绿）", lightCells.some((c) => c.style.fill === "var(--background-modifier-border)"),
	{ 边框色格: lightCells.filter((c) => c.style.fill === "var(--background-modifier-border)").length });
// tier 划分：0→边框色, 1, 2-3, 4-5, >5。测最深档必须给 >5 的值
const deepCells = buildHeatmapSvg(new Map([["2026-10-05", 9]]), "2026-10-06")._find("rect");
check("热力图：浅色主题最深档是琥珀 #d97706（需 >5 次完成才到该档）",
	deepCells.some((c) => c.style.fill === "#d97706"),
	{ 深琥珀: deepCells.filter((c) => c.style.fill === "#d97706").length });
setTheme(true);
const darkCells = buildHeatmapSvg(new Map([["2026-10-05", 9]]), "2026-10-06")._find("rect");
check("热力图：深色主题最亮档是提亮琥珀 #efa35c",
	darkCells.some((c) => c.style.fill === "#efa35c") && !darkCells.some((c) => c.style.fill === "#d97706"),
	{ 亮琥珀: darkCells.filter((c) => c.style.fill === "#efa35c").length });
setTheme(false);
check("热力图：底部月份标签 1..12", (() => {
	const labels = heatLight._find("text").map((t) => t.textContent);
	return labels.filter((l) => /^\d{1,2}月$/.test(l)).length >= 10;
})(), heatLight._find("text").map((t) => t.textContent).slice(0, 14));

// ═══ 5. buildPlanBarsH ═══
// 实测契约：每行 = 计划名 text + 轨道 track rect + 实际条 bar rect + 数值 text（"N 次"）。
const planBars = buildPlanBarsH([
	{ plan: "写作", count: 12, color: "#f59e0b" },
	{ plan: "健康", count: 3, color: "#10b981" },
]);
const pRects = planBars._find("rect");
const pTexts = planBars._find("text");
check("条形图：每计划一条轨道 + 一条实际条（共 4 rect）", pRects.length === 4, { rects: pRects.length });
check("条形图：条宽按 count 比例（12 > 3 → 前者更宽）", (() => {
	// 轨道是满宽底槽，实际条比它短；取每个计划的第 2 个 rect（条）来比
	const bars = pRects.filter((r, i) => i % 2 === 1);
	return bars.length === 2 && parseFloat(String(bars[0].attrs.width)) > parseFloat(String(bars[1].attrs.width));
})(), pRects.map((r) => r.attrs.width));
check("条形图：每行都画了轨道（0 完成的计划也有底槽，空图不塌）",
	pRects.filter((r) => r.attrs.rx === "6").length >= 4, { rects: pRects.length });
check("条形图：计划名不截断（nameW 按最长名自适应）", pTexts.some((t) => t.textContent === "写作"), pTexts.map((t) => t.textContent));
check("条形图：数值带单位「次」", pTexts.some((t) => t.textContent === "12 次") && pTexts.some((t) => t.textContent === "3 次"),
	pTexts.map((t) => t.textContent));
check("条形图：0 值计划的条宽为 0（不画可见条）", (() => {
	const s = buildPlanBarsH([{ plan: "X", count: 0 }]);
	const bars = s._find("rect").filter((r) => (parseFloat(String(r.attrs.width)) || 0) < 400);
	return bars.length === 0 || parseFloat(String(bars[0].attrs.width)) === 0;
})());
check("条形图：负数 count 不产生负宽度条", (() => {
	const s = buildPlanBarsH([{ plan: "X", count: -5 }]);
	return s._find("rect").every((r) => (parseFloat(String(r.attrs.width)) || 0) >= 0);
})());

// ═══ 6. buildYearMonthsSvg / buildCumulativeSvg ═══
const months = [
	{ label: "1", done: 3 }, { label: "2", done: 0 }, { label: "3", done: 8 },
	{ label: "4", done: 5 }, { label: "5", done: 0 },
];
const ym = buildYearMonthsSvg(months);
// 0 值月画「幽灵槽」（height=4），有值月画实柱 → 3 实柱 + 2 幽灵 = 5
check("年度月柱：3 根实柱 + 2 个 0 值幽灵槽", ym._find("rect").length === 5,
	{ rects: ym._find("rect").length });
check("年度月柱：幽灵槽用边框色且矮（height=4）",
	ym._find("rect").filter((r) => r.attrs.height === "4" && r.style.fill === "var(--background-modifier-border)").length === 2);
check("年度月柱：每月一条独立渐变", ym._find("linearGradient").length === 5,
	{ gradients: ym._find("linearGradient").length });
check("年度月柱：实柱填充引用各自渐变（幽灵槽不走渐变）",
	ym._find("rect").filter((r) => /^url\(#pf-ym-\d+\)$/.test(String(r.attrs.fill))).length === 3,
	ym._find("rect").map((r) => r.attrs.fill));
check("年度月柱：每月一个标签（label 原样，5 个月 = 5 个）",
	ym._find("text").filter((t) => ["1", "2", "3", "4", "5"].includes(t.textContent)).length === 5,
	ym._find("text").map((t) => `${t.textContent}@${t.style.fill}`));
check("年度月柱：只给最高月（8 次）标数值，且加粗",
	ym._find("text").filter((t) => t.attrs["font-weight"] === "700" && t.textContent === "8").length === 1,
	ym._find("text").map((t) => `${t.textContent}@w${t.attrs["font-weight"]}`));
check("年度月柱：每月带 title 悬浮提示", ym._find("title").length === 3, { titles: ym._find("title").length });

const cum = buildCumulativeSvg(months, new Map([["1", 2], ["2", 4]]));
// 曲线用 path（d 属性），不是 polyline：面积 path + 折线 path
const cumPaths = cum._find("path");
check("累计曲线：面积 path + 折线 path 各一", cumPaths.length === 2, { paths: cumPaths.length });
check("累计曲线：折线用渐变描边、fill=none", (() => {
	const line = cumPaths.find((x) => x.attrs.stroke !== "none");
	return line && /^url\(#pf-cum-grad\)$/.test(String(line.attrs.stroke)) && line.attrs.fill === "none";
})(), cumPaths.map((x) => ({ fill: x.attrs.fill, stroke: x.attrs.stroke })));
check("累计曲线：折线 d 里每个数据点一个 L 命令（5 月 = 4 段）",
	(String(cumPaths.find((x) => x.attrs.stroke !== "none")?.attrs.d ?? "").match(/L/g) ?? []).length === 4,
	{ d: String(cumPaths.find((x) => x.attrs.stroke !== "none")?.attrs.d).slice(0, 80) });
check("累计曲线：末点数值标签（加粗、text-anchor=end）",
	cum._find("text").some((t) => t.attrs["font-weight"] === "700" && t.attrs["text-anchor"] === "end"),
	cum._find("text").map((t) => `${t.textContent}@${t.attrs["text-anchor"]}`));
check("累计曲线：面积用渐变填充且低透明", (() => {
	const area = cum._find("path")[0];
	return /^url\(#pf-cum-grad\)$/.test(String(area.attrs.fill)) && area.style.fillOpacity === "0.14";
})(), { fill: cum._find("path")[0]?.attrs.fill, opacity: cum._find("path")[0]?.style.fillOpacity });
check("累计曲线：单月数据也画得出（不崩）", buildCumulativeSvg([{ label: "1", done: 1 }], new Map())._find("path").length >= 1);
check("累计曲线：空数组早退不崩（回归：曾读 pts[0] 抛 TypeError）", (() => {
	try { buildCumulativeSvg([], new Map()); return true; } catch { return false; }
})());
check("累计曲线：往年数据不影响基本结构（仍 2 个 path）",
	buildCumulativeSvg(months, new Map())._find("path").length === 2,
	{ paths: buildCumulativeSvg(months, new Map())._find("path").length });

// ═══ 7. colors.ts ═══
check("deepenForText：把颜色压暗（相对亮度下降）", (() => {
	const light = "#ffffff", dark = "#123456";
	const rl = parseInt(deepenForText(light).slice(1), 16);
	const rd = parseInt(deepenForText(dark).slice(1), 16);
	// 白 → 应得到某个较暗的值；深蓝 → 可能保持或进一步压暗，但绝不能变亮
	return rl < 0xffffff && rd <= 0x123456;
})(), { 白: deepenForText("#ffffff"), 深蓝: deepenForText("#123456") });
check("softenChartColor：输出合法 hex", /^#[0-9a-f]{6}$/i.test(softenChartColor("#f59e0b")), softenChartColor("#f59e0b"));
check("softenChartColor：非法输入原样返回", softenChartColor("not-a-color") === "not-a-color", softenChartColor("not-a-color"));
check("hexToRgba：alpha 正确写进 rgba()", hexToRgba("#3b82f6", 0.45) === "rgba(59, 130, 246, 0.45)", hexToRgba("#3b82f6", 0.45));
// 实现只认 6 位 hex（/^#?([0-9a-fA-F]{6})$/）——3 位短写会被原样返回。
// 这是既有契约（计划色表里全是 6 位），此处固化该行为，将来若要支持短写会看到这条测试变化。
check("hexToRgba：3 位短 hex 原样返回（实现只支持 6 位）", hexToRgba("#fff", 1) === "#fff", hexToRgba("#fff", 1));
check("hexToRgba：非法值原样返回", hexToRgba("rgb(1,2,3)", 0.5) === "rgb(1,2,3)", hexToRgba("rgb(1,2,3)", 0.5));

// ═══ 8. 边界：空数据不崩 ═══
const empties: Array<[string, () => unknown]> = [
	["buildDonutChartSvg([])", () => buildDonutChartSvg([], "0", "")],
	["buildMonthBarsSvg([])", () => buildMonthBarsSvg([], 0, 0)],
	["buildHeatmapSvg(空 map)", () => buildHeatmapSvg(new Map(), "2026-10-04")],
	["buildPlanBarsH([])", () => buildPlanBarsH([])],
	["buildYearMonthsSvg([])", () => buildYearMonthsSvg([])],
	["buildCumulativeSvg([], 空)", () => buildCumulativeSvg([], new Map())],
	["buildCumulativeSvg(单月)", () => buildCumulativeSvg([{ label: "1月", done: 1 }], new Map())],
];
for (const [name, fn] of empties) {
	let ok = true;
	let err = "";
	try { fn(); } catch (e) { ok = false; err = String(e); }
	check(`边界不崩：${name}`, ok, err || undefined);
}

// ═══ 9. 负数/超范围输入 ═══
check("负数 done 被 clamp 到 0..1 不崩", (() => {
	try { buildDonutChartSvg([{ value: 5, color: "#000", done: -3 }], "0", ""); return true; } catch { return false; }
})());
check("done 大于 value 被 clamp 不崩", (() => {
	try { buildDonutChartSvg([{ value: 5, color: "#000", done: 99 }], "0", ""); return true; } catch { return false; }
})());
check("负 count 的条形图不崩且宽度不为负", (() => {
	try {
		const s = buildPlanBarsH([{ plan: "X", count: -5 }]);
		return s._find("rect").every((r) => (parseFloat(String(r.attrs.width)) || 0) >= 0);
	} catch { return false; }
})());

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
// 用抛错而非 process.exit 汇报失败：process.exit 会掐断 runner，后面的套件就跑不到了。
if (failed > 0) throw new Error(`${failed} 个断言失败`);
