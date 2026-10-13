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
import { computeMaxStreak, computeStreak } from "../src/achievements";

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

// ═══ v1.3.1 最高连续打卡记录（computeMaxStreak）═══

// ═══ 7. 断段后更早有更长段 → max 取长段（区别于 computeStreak 的 break 语义）═══
{
	const app = makeVault({
		[dayPath("2026-10-04")]: daily(true, false),
		[dayPath("2026-10-03")]: daily(true, false), // 当前连击 2 天
		[dayPath("2026-09-10")]: daily(true, false),
		[dayPath("2026-09-09")]: daily(true, false),
		[dayPath("2026-09-08")]: daily(true, false),
		[dayPath("2026-09-07")]: daily(true, false), // 9 月一段 4 天
	});
	const got7 = await computeMaxStreak(app, ROOT, "2026-10-04");
	check("断段后更早的更长段计入最高（当前 2 / 历史段 4 → max 4）", got7 === 4, got7);
}

// ═══ 8. 当前 streak 就是历史最高 → max = 当前值 ═══
{
	const app = makeVault({
		[dayPath("2026-10-04")]: daily(true, false),
		[dayPath("2026-10-03")]: daily(true, false),
		[dayPath("2026-10-02")]: daily(true, false),
	});
	check("当前 3 天即历史最长 → max 3",
		(await computeMaxStreak(app, ROOT, "2026-10-04")) === 3);
}

// ═══ 9. 全空库 → 0 ═══
{
	const app = makeVault({});
	check("无任何笔记 → max 0", (await computeMaxStreak(app, ROOT, TODAY)) === 0);
}

// ═══ 10. 60 天连续缺失提前终止：更早的段不再回看 ═══
{
	// 2026-09-01 有一天记录，距 2027-01-01 有 122 天缺失 → 超 60 天提前停 → max 0
	const app = makeVault({ [dayPath("2026-09-01")]: daily(true, false) });
	check("超过 60 天断更 → 不再回看更早段（max 0）",
		(await computeMaxStreak(app, ROOT, "2027-01-01")) === 0);
	// 对照：缺失 17 天（< 60）→ 能扫到
	const app2 = makeVault({ [dayPath("2026-12-15")]: daily(true, false) });
	check("缺失不足 60 天 → 仍能回看到更早段（max 1）",
		(await computeMaxStreak(app2, ROOT, "2027-01-01")) === 1);
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
if (failed > 0) throw new Error(`${failed} 个断言失败`);
