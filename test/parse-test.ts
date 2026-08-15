/**
 * Offline verification of M2 parsing logic:
 * - annual plan `plans` frontmatter parsing
 * - task pool line round-trip
 * - date-window filtering for week/month
 */
import { parsePlansFromFrontmatter, filterTasksInRange, summarizeTasks } from "../src/stats";
import { parseTaskPool, buildPoolLine, autoWeekContext, autoQuota, autoTaskNumbers, planCounterUnit, isAutoTask } from "../src/tasks";
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

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
