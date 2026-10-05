/**
 * 连续打卡（v1.1.1 放宽口径）行为验证。
 *
 * 为什么测这个：口径从「当天全部勾选才算」放宽为「当天完成 ≥1 项就算，
 * 今天完成过也先计 1 天」——必须固化新语义的所有边界：
 *   ① 部分完成的日子计入（旧口径下这类天直接归 0，正是用户报的 bug）；
 *   ② 今天完成 ≥1 项 → 立即 +1（否则刚勾完仍显示 0，像没生效）；
 *   ③ 断链三态：笔记缺失 / 无打卡项 / 一项都没完成；
 *   ④ 跨年边界（12-31 → 01-01）不断链。
 */
import { App, TFile } from "obsidian";
import { computeStreak } from "../src/achievements";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}

function mkFile(path: string, basename: string): TFile {
	const f = new TFile();
	return Object.assign(f, { path, name: `${basename}.md`, basename, stat: { mtime: 0 } }) as TFile;
}

const ROOT = "raw/计划";
const TODAY = "2026-10-04";

/** 每日笔记内容生成：done 数组按 [写作, 健康] 指定勾选状态。 */
function daily(writing: boolean, health: boolean): string {
	return `## ✅ 今日打卡\n- [${writing ? "x" : " "}] ✍️ 写作 #计划/写作\n- [${health ? "x" : " "}] 🏃 健康 #计划/健康\n`;
}

/** 假 vault：files 映射路径 → 每日笔记内容。 */
function makeVault(files: Record<string, string>): App {
	const entries = Object.entries(files).map(([p, c]) => mkFile(p, p.split("/").pop()!));
	const readOne = (f: TFile): string => files[f.path] ?? "";
	return {
		vault: {
			getAbstractFileByPath: (p: string) => entries.find((e) => e.path === p) ?? null,
			async cachedRead(f: TFile) {
				return readOne(f);
			},
		},
	} as unknown as App;
}

const dayPath = (ds: string) => `${ROOT}/${ds.slice(0, 4)}/每日/${ds}.md`;

// ═══ 1. 部分完成计入：昨天只勾 1/2 项 → 连击 1（旧口径下是 0）═══
{
	const app = makeVault({ [dayPath("2026-10-03")]: daily(true, false) });
	check("部分完成的日子计入连击（昨天 1/2 项 → 1 天）",
		(await computeStreak(app, ROOT, "2026", TODAY)) === 1);
}

// ═══ 2. 今天完成 ≥1 项 → 立即 +1 ═══
{
	const app = makeVault({
		[dayPath(TODAY)]: daily(false, true), // 今天勾了 1 项
		[dayPath("2026-10-03")]: daily(true, true),
		[dayPath("2026-10-02")]: daily(true, false),
	});
	check("今天完成 ≥1 项先计 1 天，再累计昨天（1+1+1 → 3 天）",
		(await computeStreak(app, ROOT, "2026", TODAY)) === 3);
}

// ═══ 3. 今天没勾不算今天，但昨天起照样累计 ═══
{
	const app = makeVault({
		[dayPath(TODAY)]: daily(false, false),
		[dayPath("2026-10-03")]: daily(true, false),
	});
	check("今天没勾不计今天（昨天部分完成 → 1 天）",
		(await computeStreak(app, ROOT, "2026", TODAY)) === 1);
}

// ═══ 4. 断链三态 ═══
{
	// a. 往前某天一项都没完成
	const app = makeVault({
		[dayPath("2026-10-03")]: daily(true, true),
		[dayPath("2026-10-02")]: daily(false, false), // 0 完成 → 断
		[dayPath("2026-10-01")]: daily(true, true),
	});
	check("某天一项都没完成 → 在该天断链（→ 1 天）",
		(await computeStreak(app, ROOT, "2026", TODAY)) === 1);
}
{
	// b. 往前某天笔记缺失
	const app = makeVault({
		[dayPath("2026-10-03")]: daily(true, true),
		[dayPath("2026-10-01")]: daily(true, true), // 10-02 缺失 → 断
	});
	check("某天笔记缺失 → 在该天断链（→ 1 天）",
		(await computeStreak(app, ROOT, "2026", TODAY)) === 1);
}
{
	// c. 往前某天笔记存在但无打卡项
	const app = makeVault({
		[dayPath("2026-10-03")]: daily(true, true),
		[dayPath("2026-10-02")]: "## 其它\n没有打卡区\n",
	});
	check("某天无打卡项 → 在该天断链（→ 1 天）",
		(await computeStreak(app, ROOT, "2026", TODAY)) === 1);
}

// ═══ 5. 跨年不断链（12-31 → 前一年 12-30）═══
{
	const app = makeVault({
		[dayPath("2026-01-01")]: daily(true, false),
		[dayPath("2025-12-31")]: daily(true, false),
		[dayPath("2025-12-30")]: daily(false, true),
	});
	check("跨年边界不断链（含今天 3 天）",
		(await computeStreak(app, ROOT, "2026", "2026-01-01")) === 3);
}

// ═══ 6. 全空库 → 0 ═══
{
	const app = makeVault({});
	check("无任何笔记 → 0 天", (await computeStreak(app, ROOT, "2026", TODAY)) === 0);
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
if (failed > 0) throw new Error(`${failed} 个断言失败`);
