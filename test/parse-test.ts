/**
 * Offline verification of M2 parsing logic:
 * - annual plan `plans` frontmatter parsing
 * - task pool line round-trip
 * - date-window filtering for week/month
 */
import { parsePlansFromFrontmatter, filterTasksInRange, summarizeTasks } from "../src/stats";
import { parseTaskPool, buildPoolLine, autoWeekContext, autoQuota, autoTaskNumbers, planCounterUnit, isAutoTask } from "../src/tasks";
import { toggleTaskLine, moveTaskLine, removeLine, appendCheckItem, upsertCheckLog, removeCheckLog, findCheckLineByPlan } from "../src/daily";
import { TFile } from "obsidian";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}

// --- 1. Plan frontmatter: array-of-objects ---------------------------------
const fm1 = `---
type: year
year: 2026
plans:
  - name: 写作
    type: 数量
    target: 12 篇公众号文章
  - name: 健康
    type: 打卡
    target: 每天跑步 1 小时
---
# 年度计划
`;
const defs1 = parsePlansFromFrontmatter(fm1);
console.log("defs1:", JSON.stringify(defs1));
check("array form: 2 plans", defs1.length === 2, defs1.length);
const writing = defs1.find((d) => d.name === "写作");
check("写作 is numeric", writing?.type === "numeric");
check("写作 target", writing?.target === "12 篇公众号文章");
check("写作 targetCount = 12", writing?.targetCount === 12);
const health = defs1.find((d) => d.name === "健康");
check("健康 is check", health?.type === "check", health?.type);
check("健康 targetCount = 0 (check)", health?.targetCount === 0);

// --- 2. Plan frontmatter: map-of-objects -----------------------------------
const fm2 = `---
plans:
  写作:
    type: 数量
    target: 12 篇公众号文章
  复盘:
    type: 打卡
    target: 每天复盘
---
`;
const defs2 = parsePlansFromFrontmatter(fm2);
console.log("defs2:", JSON.stringify(defs2));
check("map form: 2 plans", defs2.length === 2, defs2.length);
check("map form name", defs2.some((d) => d.name === "写作"));
check("map form check type", defs2.find((d) => d.name === "复盘")?.type === "check");

// --- 3. No type field → fallback to number-in-target -----------------------
const fm3 = `---
plans:
  - name: 学习
    target: 50 本书
  - name: 冥想
    target: 坚持每天冥想
---
`;
const defs3 = parsePlansFromFrontmatter(fm3);
console.log("defs3:", JSON.stringify(defs3));
check("fallback numeric (50 本书)", defs3.find((d) => d.name === "学习")?.type === "numeric");
check("fallback check (no number)", defs3.find((d) => d.name === "冥想")?.type === "check");

// --- 4. Task pool line round-trip ------------------------------------------
const file = new TFile() as any;
// A real pool is a flat Tasks-format file. parseTaskPool picks up every
// task line (there is no section structure in the pool file).
const poolContent = [
	"- [ ] 完成《霍去病》文章 #计划/写作 🛫 2026-08-10 📅 2026-08-16",
	"- [x] 整理 AI 画图工作流 #计划/学习 🛫 2026-08-12 📅 2026-08-14",
	"- [ ] 无计划的临时任务 📅 2026-08-11",
].join("\n");
const pool = parseTaskPool(file, poolContent);
console.log("pool:", JSON.stringify(pool.map((t) => ({ text: t.text, plan: t.plan, checked: t.checked, start: t.start, due: t.due, line: t.line }))));
check("pool parses 3 tasks", pool.length === 3, pool.length);
const t0 = pool[0];
check("task0 fields", t0.text === "完成《霍去病》文章" && t0.plan === "写作" && t0.start === "2026-08-10" && t0.due === "2026-08-16" && !t0.checked);
check("task0 line", t0.line === 0);
check("task1 checked", pool[1].checked === true);
check("task2 plan null", pool[2].plan === null && pool[2].due === "2026-08-11");

// buildPoolLine round-trip
const built = buildPoolLine({ text: "新任务", plan: "写作", start: "2026-08-10", due: "2026-08-16" });
check("buildPoolLine", built === "- [ ] 新任务 #计划/写作 🛫 2026-08-10 📅 2026-08-16", built);
const rebuilt = parseTaskPool(file, built);
check("build→parse round-trip", rebuilt.length === 1 && rebuilt[0].text === "新任务" && rebuilt[0].plan === "写作" && rebuilt[0].start === "2026-08-10" && rebuilt[0].due === "2026-08-16");

// buildPoolLine without plan/dates
const built2 = buildPoolLine({ text: "简单任务", plan: null, start: null, due: null });
check("buildPoolLine minimal", built2 === "- [ ] 简单任务", built2);

// --- 5. Window filtering ----------------------------------------------------
const tasks = pool;
// Week 2026-W33: Mon 8/10 – Sun 8/16 → all three tasks overlap (t2 due 8/11).
const week = filterTasksInRange(tasks, "2026-08-10", "2026-08-16");
check("week filter includes all 3", week.length === 3, week.map((t) => t.text));
const month = filterTasksInRange(tasks, "2026-08-01", "2026-08-31");
check("month filter includes all dated", month.length === 3, month.map((t) => t.text));
const none = filterTasksInRange(tasks, "2026-09-01", "2026-09-30");
check("sep filter empty", none.length === 0, none.length);
check("summarize", JSON.stringify(summarizeTasks(tasks)) === '{"total":3,"done":1,"percent":33}', JSON.stringify(summarizeTasks(tasks)));

// --- 6. Tasks without dates are excluded from windows -----------------------
const undated = parseTaskPool(file, "- [ ] 未安排日期\n");
check("undated excluded", filterTasksInRange(undated, "2026-08-10", "2026-08-16").length === 0);

// --- 7. Single-key map form --------------------------------------------------
const fm7 = `---
plans:
  写作: 12 篇公众号文章
  健康: 每天跑步
---
`;
const defs7 = parsePlansFromFrontmatter(fm7);
console.log("defs7:", JSON.stringify(defs7));
check("single-key map 2 plans", defs7.length === 2, defs7.length);
check("single-key 写作 numeric", defs7.find((d) => d.name === "写作")?.type === "numeric");
check("single-key 健康 check", defs7.find((d) => d.name === "健康")?.type === "check");

// --- 8. v1.2 auto-task helpers ---------------------------------------------
check("planCounterUnit 篇", planCounterUnit("12 篇公众号文章") === "篇");
check("planCounterUnit 天", planCounterUnit("144 天") === "天");
check("planCounterUnit default", planCounterUnit("每天跑步") === "篇");

// Cumulative quota (DEV.md v1.2): ceil(N × weekIndex / totalWeeks)
check("autoQuota w1 (12/52)", autoQuota(12, 1, 52) === 1, autoQuota(12, 1, 52));
check("autoQuota w26 (12/52)", autoQuota(12, 26, 52) === 6, autoQuota(12, 26, 52));
check("autoQuota w52 (12/52)", autoQuota(12, 52, 52) === 12, autoQuota(12, 52, 52));
check("autoQuota target 0", autoQuota(0, 5, 52) === 0);
check("autoQuota increments ≤ 2", Array.from({ length: 52 }, (_, i) => autoQuota(12, i + 1, 52) - autoQuota(12, i, 52)).every((d) => d >= 0 && d <= 2));

// ISO week context
const ctx1 = autoWeekContext("2026-01-01", "2026-12-31", "2026-01-05");
console.log("ctx1:", JSON.stringify(ctx1));
check("weekContext full-year totalWeeks = 53 (2026 has 53 ISO weeks)", ctx1?.totalWeeks === 53, ctx1?.totalWeeks);
// Plan starts 2026-01-01 (Thu, ISO week 1). 2026-01-05 is Monday of the next ISO week → index 2.
check("weekContext first week index = 2", ctx1?.weekIndex === 2, ctx1?.weekIndex);
check("weekContext before plan start → null", autoWeekContext("2026-08-10", "2026-12-31", "2026-08-01") === null);
check("weekContext after plan end → null", autoWeekContext("2026-08-10", "2026-12-31", "2027-01-04") === null);
// Plan starts 2026-08-12 (Wed); today 2026-08-10 (Mon, same ISO week but before start) → skip.
check("weekContext same week before start → null", autoWeekContext("2026-08-12", "2026-12-31", "2026-08-10") === null);

const ctx2 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-10");
check("weekContext mid-plan totalWeeks", ctx2?.totalWeeks === 21, ctx2?.totalWeeks);
check("weekContext mid-plan week1", ctx2?.weekIndex === 1, ctx2?.weekIndex);
const ctx3 = autoWeekContext("2026-08-10", "2026-12-31", "2026-08-17");
check("weekContext mid-plan week2", ctx3?.weekIndex === 2, ctx3?.weekIndex);

// Auto-task detection (name pattern «label（第 N 篇）»; manual tasks ignored)
const autoPool = parseTaskPool(
	file,
	[
		"- [ ] 写作（第 1 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16",
		"- [x] 写作（第 2 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16",
		"- [ ] 完成《霍去病》文章 #计划/写作 🛫 2026-08-10 📅 2026-08-16",
		"- [ ] 学习（第 1 本） #计划/学习 🛫 2026-08-10 📅 2026-08-16",
	].join("\n")
);
check("isAutoTask 第1篇", autoPool[0].plan === "写作" && isAutoTask(autoPool[0]));
check("isAutoTask 第2篇 checked", autoPool[1].plan === "写作" && isAutoTask(autoPool[1]));
check("manual task not auto", autoPool[2].plan === "写作" && !isAutoTask(autoPool[2]));
check("isAutoTask 第1本 (book unit)", autoPool[3].plan === "学习" && isAutoTask(autoPool[3]));

// Number selection: continue from highest, skip existing names, cap at target.
const autoWriting = autoPool.filter((t) => t.plan === "写作");
const nums1 = autoTaskNumbers(autoWriting, 1, 12, "写作", "篇");
check("autoTaskNumbers continue from maxN", JSON.stringify(nums1) === "[3]", nums1);
const gapPool = parseTaskPool(
	file,
	["- [ ] 写作（第 1 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16", "- [ ] 写作（第 3 篇） #计划/写作 🛫 2026-08-10 📅 2026-08-16"].join("\n")
);
const numsGap = autoTaskNumbers(gapPool, 2, 12, "写作", "篇");
check("autoTaskNumbers skip deleted middle", JSON.stringify(numsGap) === "[4,5]", numsGap);
check("autoTaskNumbers need 0", autoTaskNumbers(autoWriting, 0, 12, "写作", "篇").length === 0);
const numsCap = autoTaskNumbers(autoWriting, 5, 2, "写作", "篇");
check("autoTaskNumbers capped at targetCount", JSON.stringify(numsCap) === "[]", numsCap);
const numsEmpty = autoTaskNumbers([], 2, 12, "写作", "篇");
check("autoTaskNumbers from scratch", JSON.stringify(numsEmpty) === "[1,2]", numsEmpty);

// --- 6. Line-level mutations: bounds safety (regression for the idx/target order bug) ---
// 背景：这些函数按行号改内容，但行号会被外部改动冲歪，于是靠 expectedRaw 兜底重定位。
// 重定位失败时 idx=-1——早先 moveTaskLine 先算 `idx+delta` 再判越界，delta=1 得到 target=0，
// 骗过 `target>=0` 检查后拿 lines[0] 去交换，静默改错数据。removeLine 则会 splice(-1,1) 删掉最后一行。
const DOC = ["## ✅ 今日打卡", "", "- [ ] 任务甲", "- [ ] 任务乙", "- [ ] 任务丙"].join("\n");

// 正例：行号正确时行为不变（下移 = idx 与 idx+1 交换；上移 = idx 与 idx-1 交换）
const DOWN = moveTaskLine(DOC, 2, 1).split("\n");
check("moveTaskLine 下移：甲下沉一位", DOWN[2] === "- [ ] 任务乙" && DOWN[3] === "- [ ] 任务甲", DOWN.slice(2, 4));
const UP = moveTaskLine(DOC, 3, -1).split("\n");
check("moveTaskLine 上移：乙升到甲的位置", UP[2] === "- [ ] 任务乙" && UP[3] === "- [ ] 任务甲", UP.slice(2, 4));

// 回归：expectedRaw 找不到 → 必须原样返回，一个字节都不能动
const GHOST = "- [ ] 早已删除的任务";
check("moveTaskLine 重定位失败原样返回", moveTaskLine(DOC, 2, 1, GHOST) === DOC);
check("removeLine 重定位失败原样返回", removeLine(DOC, 2, GHOST) === DOC);
check("toggleTaskLine 重定位失败原样返回", toggleTaskLine(DOC, 2, true, GHOST) === DOC);

// 回归：idx 越界的直接入参（不只 -1，还包括 >=length 与负数）
check("moveTaskLine idx=-1 不越界写", moveTaskLine(DOC, -1, 1) === DOC);
check("moveTaskLine idx=-1 delta=-1 不越界写", moveTaskLine(DOC, -1, -1) === DOC);
check("moveTaskLine idx 越界(>=len) 不动", moveTaskLine(DOC, 999, 1) === DOC);
check("removeLine idx=-1 不删最后一行", removeLine(DOC, -1) === DOC);
check("removeLine idx 越界不动", removeLine(DOC, 999) === DOC);
check("toggleTaskLine idx 越界不动", toggleTaskLine(DOC, 999, true) === DOC);

// 旧 bug 的精确复现：首行就是任务行，且传入一个不存在的 expectedRaw。
// 旧写法：idx=-1 → target = -1+1 = 0 → 骗过 `target>=0` → 拿 lines[0] 交换 → 静默改错数据。
// 新写法：resolveLineIndex 返回 -1 → 直接原样返回。
const HEAD_TASK = ["- [ ] 首行任务", "- [ ] 次行任务"].join("\n");
check("moveTaskLine 不拿 lines[0] 顶替（旧 bug 精确复现）",
	moveTaskLine(HEAD_TASK, 0, 1, "- [ ] 不存在的行") === HEAD_TASK, moveTaskLine(HEAD_TASK, 0, 1, "- [ ] 不存在的行"));

// 边界：只能与真实任务行交换，不能与非任务行（标题/空行）交换
check("moveTaskLine 不与空行交换", moveTaskLine(DOC, 2, -1) === DOC);
check("moveTaskLine 不与标题行交换", moveTaskLine(HEAD_TASK, 0, -1) === HEAD_TASK);
check("moveTaskLine 越出末尾不动", moveTaskLine(DOC, 4, 1) === DOC);
check("moveTaskLine 越出开头不动", moveTaskLine(DOC, 0, -1) === DOC);

// 正例：removeLine / toggleTaskLine 正常路径
check("removeLine 删指定行", removeLine(DOC, 2) === ["## ✅ 今日打卡", "", "- [ ] 任务乙", "- [ ] 任务丙"].join("\n"));
check("toggleTaskLine 勾选", toggleTaskLine(DOC, 2, true).split("\n")[2] === "- [x] 任务甲");
check("toggleTaskLine 取消勾选", toggleTaskLine(DOC, 2, false).split("\n")[2] === "- [ ] 任务甲");
check("toggleTaskLine 非任务行不动", toggleTaskLine(DOC, 0, true) === DOC);

// --- 7. Check-log round-trip (打卡记录的写入 / 改时长 / 撤销) -----------------
// 记录行真实格式：`- {日期} · {项名} · {用时}`（`·` 分隔，见 logAnchor）。
// 记录区从 `## ⏱ 打卡记录` 标题开始，到下一个 `##` 标题（或文末）为止。
const LOG_LINE = "- 2026-10-04 · 写作 · 30 分钟";
const LOG_DOC = ["## ✅ 今日打卡", "", "- [ ] 写作 30分钟", "", "## ⏱ 打卡记录", "", LOG_LINE].join("\n");

const NO_LOG = ["## ✅ 今日打卡", "", "- [ ] 写作 30分钟"].join("\n");
const FRESH = upsertCheckLog(NO_LOG, "2026-10-04", "写作", "30 分钟");
check("upsertCheckLog 无记录区则新建区", FRESH.includes("## ⏱ 打卡记录") && FRESH.includes(LOG_LINE), FRESH);

const LOGGED = upsertCheckLog(LOG_DOC, "2026-10-04", "写作", "30 分钟");
check("upsertCheckLog 同 key 同 detail 幂等（不刷屏）", LOGGED === LOG_DOC);
const RETIMED = upsertCheckLog(LOG_DOC, "2026-10-04", "写作", "60 分钟");
check("upsertCheckLog 改时长是整行替换而非追加",
	RETIMED.includes("- 2026-10-04 · 写作 · 60 分钟") && !RETIMED.includes("30 分钟"), RETIMED.split("\n").pop());
const REPEATED = upsertCheckLog(LOG_DOC, "2026-10-04", "写作", "30 分钟");
check("upsertCheckLog 重复打卡不产生第二条记录",
	REPEATED.split("\n").filter((l) => l.includes("2026-10-04 · 写作")).length === 1);

const UNLOGGED = removeCheckLog(LOG_DOC, "2026-10-04", "写作");
check("removeCheckLog 撤销后记录行消失", !UNLOGGED.includes(LOG_LINE), UNLOGGED);
check("removeCheckLog 撤销不伤打卡勾选状态", UNLOGGED.includes("- [ ] 写作 30分钟"));
check("removeCheckLog 对不存在的 key 是 no-op", removeCheckLog(LOG_DOC, "2026-10-05", "写作") === LOG_DOC);
check("removeCheckLog 对不存在的项名是 no-op", removeCheckLog(LOG_DOC, "2026-10-04", "阅读") === LOG_DOC);

// --- 8. appendCheckItem 插到打卡区末尾 --------------------------------------
const APPENDED = appendCheckItem(DOC, "- [ ] 任务丁");
// 插在**最后一条任务之后**：原最后一行「任务丙」在 idx 4 → insertIdx=5 → 丁落在 idx 5
check("appendCheckItem 追加到最后一条任务后", APPENDED.split("\n")[5] === "- [ ] 任务丁"
	&& APPENDED.split("\n")[4] === "- [ ] 任务丙", APPENDED);
const APPENDED2 = appendCheckItem(APPENDED, "- [ ] 任务戊");
check("appendCheckItem 连续追加保持顺序（后加的在后面）",
	APPENDED2.split("\n").indexOf("- [ ] 任务丁") < APPENDED2.split("\n").indexOf("- [ ] 任务戊"), APPENDED2);
check("appendCheckItem 不动打卡区以外的行", APPENDED.startsWith("## ✅ 今日打卡\n"), APPENDED);
check("appendCheckItem 原有任务不被改写", APPENDED.includes("- [ ] 任务甲") && APPENDED.includes("- [ ] 任务丙"));
// 无打卡区标题时**主动补建标题**（容错，不是 bug）——老模板/手写笔记也接得住
const NO_HEADING = appendCheckItem("随便一行", "- [ ] x");
check("appendCheckItem 无标题则补建标题", NO_HEADING.includes("## ✅ 今日打卡") && NO_HEADING.includes("- [ ] x"), NO_HEADING);
check("appendCheckItem 补建时保留原内容", NO_HEADING.startsWith("随便一行"), NO_HEADING);

// --- 9. findCheckLineByPlan 跨文件定位（补卡的唯一可靠锚点） -----------------
// 补卡写的是「另一篇」文件，行号完全不同，所以只能按计划名定位。
// 下面这组是 v7.22 真实踩坑的固化：老笔记行带 "1小时" 后缀、复盘行带 [[链接]]，
// 按显示名匹配会全部对不上，必须按 #计划/ 标签逐字比。
const LEGACY = [
	"## ✅ 今日打卡",
	"",
	"- [ ] ✍️ 写作 1小时 #计划/写作", // ← 老行：带时长后缀
	"- [ ] 📈 复盘 复盘+次日计划 → [[2026-10-01 复盘]] #计划/复盘", // ← 老行：带复盘链接
	"- [ ] 手写项", // ← 无计划标签，走显示名回退
	"",
].join("\n");
check("findCheckLineByPlan 命中带时长后缀的老行", findCheckLineByPlan(LEGACY, "写作", "✍️ 写作") === 2, findCheckLineByPlan(LEGACY, "写作", "✍️ 写作"));
check("findCheckLineByPlan 命中带复盘链接的老行", findCheckLineByPlan(LEGACY, "复盘", "📈 复盘") === 3, findCheckLineByPlan(LEGACY, "复盘", "📈 复盘"));
check("findCheckLineByPlan 无标签行走显示名回退", findCheckLineByPlan(LEGACY, null, "手写项") === 4, findCheckLineByPlan(LEGACY, null, "手写项"));
check("findCheckLineByPlan 找不到返回 -1", findCheckLineByPlan(LEGACY, "不存在的计划", "不存在") === -1);
// ⚠️ 计划名优先：即使显示名能匹配到别的行，也以 #计划/ 标签为准
// （前提是同一计划在同一天只有一个打卡项——这正是插件的数据模型，见函数注释）
check("findCheckLineByPlan 计划名优先于显示名", findCheckLineByPlan(LEGACY, "写作", "手写项") === 2, findCheckLineByPlan(LEGACY, "写作", "手写项"));
check("findCheckLineByPlan 不跨越打卡区（打卡区外同文本不算）",
	findCheckLineByPlan(["## 📝 今日总结", "", "- [ ] 写作 #计划/写作", "", "## ✅ 今日打卡", "", "- [ ] 阅读 #计划/阅读"].join("\n"), "写作", "写作") === -1);

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
// 用抛错而非 process.exit 汇报失败：process.exit 会掐断 runner，后面的套件就跑不到了。
if (failed > 0) throw new Error(`${failed} 个断言失败`);
