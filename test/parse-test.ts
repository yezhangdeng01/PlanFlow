/**
 * Offline verification of M2 parsing logic:
 * - annual plan `plans` frontmatter parsing
 * - task pool line round-trip
 * - date-window filtering for week/month
 */
import { parsePlansFromFrontmatter, filterTasksInRange, summarizeTasks } from "../src/stats";
import { serializePlans } from "../src/plan-file";
import { parseTaskPool, buildPoolLine, autoWeekContext, autoQuota, autoTaskNumbers, planCounterUnit, isAutoTask } from "../src/tasks";
import { toggleTaskLine, moveTaskLine, removeLine, appendCheckItem, upsertCheckLog, removeCheckLog, findCheckLineByPlan, parseDailyContent, extractSummary, autoCheckItemName, renameAutoCheckLines, withPlanIcon, collapseAutoSuffix } from "../src/daily";
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

// --- 10. 新用户骨架：`plans: {}` 必须解析出 0 个计划，且不抛错 ----------------
// v1.1.6回归：buildYearPlanTemplate 曾硬编码「写作/健康/学习/复盘」四个个人计划名，
// 随插件分发进每个用户 vault。改为空 plans 后，这条断言守住「骨架不含任何预置计划」。
const EMPTY_TPL = `---
type: yearly
period: 2026
start: 2026-01-01
end: 2026-12-31
plans: {}
---
# 🏆 2026 年度计划
`;
let emptyDefs: ReturnType<typeof parsePlansFromFrontmatter> | null = null;
let emptyThrew: unknown = null;
try {
	emptyDefs = parsePlansFromFrontmatter(EMPTY_TPL);
} catch (e) {
	emptyThrew = e;
}
check("空 plans 骨架不抛错", emptyThrew === null, emptyThrew === null ? undefined : String(emptyThrew));
check("空 plans 骨架解析出 0 个计划", (emptyDefs?.length ?? -1) === 0, emptyDefs?.length);

// 反向锁死：骨架里绝不能再出现作者个人的计划名
const PSONEAL_PLAN_NAMES = ["写作", "健康", "学习", "复盘"];
const tplFront = /^---\n([\s\S]*?)\n---/.exec(EMPTY_TPL)?.[1] ?? "";
for (const name of PSONEAL_PLAN_NAMES) {
	check(`骨架不含个人计划名「${name}」`, !tplFront.includes(name));
}
// 有内容的老用户文件不受影响（别把正常计划也一起拦掉）
const USER_TPL = `---
type: yearly
period: 2026
plans:
  写作:
    label: ✍️
    daily: true
---
`;
check("老用户含实际计划的文件仍正常解析", parsePlansFromFrontmatter(USER_TPL).length === 1);

// --- 11. 交易复盘特化已彻底移除（反向断言，防复辟）--------------------------
// v1.1.6：原先有两条交易相关特化——①`plan === "复盘"` 硬编码决定打卡率分母；
// ②frontmatter 的 `tradingDay: true` 标记 + 设置页「复盘按工作日统计」开关。
// 两者都服务于作者本人那个 A 股复盘计划（交易日不含周末），不是通用需求。
// 这里用**反向断言**锁死：旧字段即使还留在用户文件里，插件也不再读它、不再写它。
const legacyTd = parsePlansFromFrontmatter(`---
plans:
  每日复盘:
    label: 📈
    daily: true
    tradingDay: true
  收盘复盘:
    label: 📊
    daily: true
    tradingDay: true
---
`);
check("旧文件的 tradingDay 不再被识别（字段已移除）", legacyTd.every((d) => !("tradingDay" in d)));
check("旧字段不影响计划本身解析", legacyTd.length === 2 && legacyTd[0].name === "每日复盘");

// 序列化时不应再写出 tradingDay 行（否则每次保存计划都把它固化进用户文件）
const NO_TD_WRITE = !serializePlans([
	{ name: "任意计划", type: "check", target: "", targetCount: 0, goals: [], action: "", label: "🎯", color: "", daily: true },
]).includes("tradingDay");
check("序列化不再写 tradingDay", NO_TD_WRITE);

// 分母口径统一：所有计划都用自然天，不再有「按工作日」的旁路
check("PlanDef 上已无 tradingDay 字段", !("tradingDay" in (legacyTd[0] as unknown as Record<string, unknown>)));

// --- 12. 损坏文件自愈：重复打卡项去重 ------------------------------------
// v1.1.7 回归：这组样本是**用户真库 `2026-10-06.md` 的逐字节内容**（两套完整日记被
// 拼进同一文件：同步插件两端都改同一天时各保留双方）。原症状：界面显示 8 项、
// 进度算成 3/8，而用户实际只打了 2 个卡。
const CORRUPTED = [
	"---", "date: 2026-10-06", "type: daily", "---", "# 📅 2026-10-06 星期二", "",
	"## ✅ 今日打卡",
	"- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-06 📅 2026-10-06",
	"- [x] 🏃 健康 #计划/健康 🛫 2026-10-06 📅 2026-10-06",
	"- [x] 📖 学习 #计划/学习 🛫 2026-10-06 📅 2026-10-06",
	"- [ ] 📈 复盘 → [[2026-10-06 复盘]] #计划/复盘 🛫 2026-10-06 📅 2026-10-06",
	"", "## 📝 今日总结",
	"---", "date: 2026-10-06", "type: daily", "---", "# 📅 2026-10-06 星期二", "",
	"## ✅ 今日打卡",
	"- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-06 📅 2026-10-06",
	"- [ ] 🏃 健康 #计划/健康 🛫 2026-10-06 📅 2026-10-06",
	"- [x] 📖 学习 #计划/学习 🛫 2026-10-06 📅 2026-10-06",
	"- [ ] 📈 复盘 → [[2026-10-06 复盘]] #计划/复盘 🛫 2026-10-06 📅 2026-10-06",
	"", "## ⏱ 打卡记录", "",
	"- 2026-10-06 · 📖 学习 · 用时 30 分钟",
	"- 2026-10-06 · 🏃 健康 · 用时 30 分钟",
	"", "## 📝 今日总结", "",
].join("\n");
const parsedCorrupt = parseDailyContent(file, CORRUPTED, "2026-10-06");
check("损坏文件去重后只剩 4 项（原 8 项）", parsedCorrupt.checkItems.length === 4, parsedCorrupt.checkItems.length);
check("去重后全是带计划标签的正常项", parsedCorrupt.checkItems.every((c) => c.plan !== null),
	parsedCorrupt.checkItems.map((c) => c.plan));
// 用户当天实际打了「健康 + 学习」两个卡 → 合并后应恰好是这两项为已打卡
const corruptChecked = parsedCorrupt.checkItems.filter((c) => c.checked).map((c) => c.plan).sort();
check("勾选态合并正确：只有 健康/学习 为已打卡（任一为 x 即算打）",
	JSON.stringify(corruptChecked) === JSON.stringify(["健康", "学习"]), corruptChecked);
check("写作/复盘 保持未勾（没打过就是没打过）",
	parsedCorrupt.checkItems.filter((c) => !c.checked).map((c) => c.plan).sort().join(",") === "写作,复盘");

// 正常文件（单套打卡区）不能被去重误伤——这是最关键的反向断言
const CLEAN = [
	"---", "date: 2026-10-06", "type: daily", "---", "# 📅 2026-10-06 星期二", "",
	"## ✅ 今日打卡",
	"- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-06 📅 2026-10-06",
	"- [x] 🏃 健康 #计划/健康 🛫 2026-10-06 📅 2026-10-06",
	"- [x] 📖 学习 #计划/学习 🛫 2026-10-06 📅 2026-10-06",
	"- [ ] 📈 复盘 → [[2026-10-06 复盘]] #计划/复盘 🛫 2026-10-06 📅 2026-10-06",
	"", "## ⏱ 打卡记录", "",
	"- 2026-10-06 · 📖 学习 · 用时 30 分钟",
	"- 2026-10-06 · 🏃 健康 · 用时 30 分钟",
	"", "## 📝 今日总结", "",
].join("\n");
const parsedClean = parseDailyContent(file, CLEAN, "2026-10-06");
check("正常文件仍是 4 项（去重不误伤）", parsedClean.checkItems.length === 4, parsedClean.checkItems.length);
check("正常文件勾选态不变（2 项已打卡）",
	parsedClean.checkItems.filter((c) => c.checked).length === 2,
	parsedClean.checkItems.map((c) => `${c.plan}:${c.checked}`));

// 同 key 但形态不同（复盘链接 / 历史时长后缀）必须视作同一项
const VARIANTS = [
	"## ✅ 今日打卡",
	"- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-06 📅 2026-10-06",
	"- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-06 📅 2026-10-06", // 完全重复
	"", "## 📝 今日总结", "",
].join("\n");
check("逐字相同的重复行被合并成 1 项", parseDailyContent(file, VARIANTS, "2026-10-06").checkItems.length === 1);

// v1.2.1 回归：**同一计划下的不同打卡项必须各自保留**。
// 旧键是 `P:{plan}`（只认计划名），等价于「同一计划每天只能有一条打卡项」——
// 用户给已有计划的计划再加一条打卡项，文件写得进去但界面永远不显示
// （实测反馈：「新建打卡项也没有显示」）。这里钉死修复后的行为。
const SAME_PLAN = [
	"## ✅ 今日打卡",
	"- [ ] 布置并发送作业 #计划/学习 🛫 2026-10-09 📅 2026-10-09",
	"- [ ] 阅读 30 分钟 #计划/学习 🛫 2026-10-09 📅 2026-10-09",
	"", "## 📝 今日总结", "",
].join("\n");
const parsedSamePlan = parseDailyContent(file, SAME_PLAN, "2026-10-09");
check("同计划两条不同打卡项都要保留", parsedSamePlan.checkItems.length === 2, parsedSamePlan.checkItems.map((c) => c.text));
check("同计划两条项名各自正确（顺序不乱）",
	JSON.stringify(parsedSamePlan.checkItems.map((c) => c.text)) === JSON.stringify(["布置并发送作业", "阅读 30 分钟"]),
	parsedSamePlan.checkItems.map((c) => c.text));
// 对照组：同计划下的**逐字重复**仍必须合并 —— 防止把去重整个改没了。
// 混合样本：同计划 2 个不同项，其中一项再重复一次 → 结果应恰好 2 项（不是 3、也不是 1）。
//
// 注：**不追求**「✍️ 写作 1小时」与「✍️ 写作」这类历史时长后缀的跨形态合并 ——
// 剥时长后缀需要一个「标准打卡项名」做闸门（见 stripLegacyDuration 注释：没有闸门
// 会把「阅读 30 分钟」误削成「阅读」，也会让「阅读 30 分钟」「阅读 60 分钟」互相吞掉）。
// parseDailyContent 这一层拿不到计划定义，宁可不合也不能误合。
const SAME_PLAN_MIXED = [
	"## ✅ 今日打卡",
	"- [ ] 布置并发送作业 #计划/学习 🛫 2026-10-09 📅 2026-10-09",
	"- [ ] 阅读 30 分钟 #计划/学习 🛫 2026-10-09 📅 2026-10-09",
	"- [ ] 布置并发送作业 #计划/学习 🛫 2026-10-09 📅 2026-10-09", // 与第一条逐字重复
	"", "## 📝 今日总结", "",
].join("\n");
check("同计划：不同项各自保留、逐字重复仍合并（3 行 → 2 项）",
	parseDailyContent(file, SAME_PLAN_MIXED, "2026-10-09").checkItems.length === 2,
	parseDailyContent(file, SAME_PLAN_MIXED, "2026-10-09").checkItems.map((c) => c.text));

// 总结区不能把第二篇的 frontmatter/标题吞进文本框（否则用户总结框里冒出 --- 和日期标题）
const corruptSummary = extractSummary(CORRUPTED);
check("总结区不吞第二篇的 frontmatter/标题（应为空）",
	corruptSummary === "", JSON.stringify(corruptSummary.slice(0, 60)));
check("正常文件的总结照常取到", extractSummary(CLEAN) === "");
// 真有总结正文时必须保住（别把去重/截断做成清空）
const WITH_SUMMARY = ["## ✅ 今日打卡", "- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-06 📅 2026-10-06",
	"", "## 📝 今日总结", "今天写了两段。", "", "第二段。", ""].join("\n");
check("有总结正文时原样保留", extractSummary(WITH_SUMMARY) === "今天写了两段。\n\n第二段。",
	JSON.stringify(extractSummary(WITH_SUMMARY)));
// 总结正文之后若跟了第二篇日记（损坏形态），第一篇的正文仍要拿到
const SUMMARY_THEN_DUP = ["## ✅ 今日打卡", "- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-06 📅 2026-10-06",
	"", "## 📝 今日总结", "今天写了点东西。", "",
	"---", "date: 2026-10-06", "type: daily", "---", "# 📅 2026-10-06 星期二", ""].join("\n");
check("总结后接第二篇日记时，保留第一篇正文",
	extractSummary(SUMMARY_THEN_DUP) === "今天写了点东西。", JSON.stringify(extractSummary(SUMMARY_THEN_DUP)));

// --- v1.2.2 回归：自动打卡项的命名口径 + 编辑计划后的联动 -------------------
// 背景（用户 2026-10-10 实测三条）：
//   ① 编辑计划后，自动生成的打卡项不跟着改；
//   ② 新建计划的自动打卡项**可删除**，与「计划自动生成的项不可删」的既有行为不一致；
//   ③ 今日打卡卡的「+ 添加」入口撤除（打卡项统一在计划里增删）。
// ①② 的根因是**两套命名口径**：建新日记的模板写 `{图标} {计划名}`，而新建计划当天补
// 那一条写的是 `label || name`（有图标时只剩图标）。两侧对不上 → 管理弹窗的
// 「自动项白名单」认不出当天那行 → 它被当成手工项，配上了 ✏️🗑️。

// ① 口径函数：四种输入形态都要落到「图标 + 空格 + 计划名」
check("autoCheckItemName：图标+名 → 「图标 空格 名」", autoCheckItemName("🏃", "晨跑") === "🏃 晨跑", autoCheckItemName("🏃", "晨跑"));
check("autoCheckItemName：空图标 → 只有计划名", autoCheckItemName("", "晨跑") === "晨跑", autoCheckItemName("", "晨跑"));
check("autoCheckItemName：undefined → 只有计划名", autoCheckItemName(undefined, "晨跑") === "晨跑", autoCheckItemName(undefined, "晨跑"));
check("autoCheckItemName：null → 只有计划名", autoCheckItemName(null, "晨跑") === "晨跑", autoCheckItemName(null, "晨跑"));

// ② 联动：旧口径文本 → 新口径
const RENAME_OLD = [
	"## ✅ 今日打卡",
	"- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-10 📅 2026-10-10",
	"", "## 📝 今日总结", "",
].join("\n");
const renamed1 = renameAutoCheckLines(RENAME_OLD, ["写作"], ["✍️ 写作"], "📖 写作");
check("① 联动：旧口径文本被改成新口径", renamed1.includes("- [ ] 📖 写作 #计划/写作"), renamed1);
check("① 联动：🛫/📅 窗口原样保留", renamed1.includes("🛫 2026-10-10 📅 2026-10-10"), renamed1);

// ③ 自愈：旧 savePlan 的 `label || name` 形态（有图标时只剩图标）
const BUGGY = ["## ✅ 今日打卡", "- [ ] 🏃 #计划/晨跑 🛫 2026-10-10 📅 2026-10-10", "", "## 📝 今日总结", ""].join("\n");
check("② 自愈：只剩图标的历史坏行被补全", renameAutoCheckLines(BUGGY, ["晨跑"], ["🏃 晨跑", "🏃"], "🏃 晨跑").includes("- [ ] 🏃 晨跑 #计划/晨跑"),
	renameAutoCheckLines(BUGGY, ["晨跑"], ["🏃 晨跑", "🏃"], "🏃 晨跑"));

// ④ 勾选态为 [x] 的坏行同样要自愈，且勾选态不能丢
const CHECKED = ["## ✅ 今日打卡", "- [x] 🏃 #计划/晨跑 🛫 2026-10-10 📅 2026-10-10", "", "## 📝 今日总结", ""].join("\n");
check("② 自愈：已勾选的坏行同样补全，勾选态保留",
	renameAutoCheckLines(CHECKED, ["晨跑"], ["🏃"], "🏃 晨跑").includes("- [x] 🏃 晨跑 #计划/晨跑"),
	renameAutoCheckLines(CHECKED, ["晨跑"], ["🏃"], "🏃 晨跑"));

// ⑤ 对照组（**必须有**，否则「一律重写文本」这种错实现也能全绿）：
//    手工项名不动、前缀相似的另一个计划不被误伤、不在白名单的行原样保留。
const MIXED2 = [
	"## ✅ 今日打卡",
	"- [ ] 🏃 #计划/晨跑 🛫 2026-10-10 📅 2026-10-10",              // 坏行 → 应自愈
	"- [ ] 阅读 30 分钟 #计划/晨跑 🛫 2026-10-10 📅 2026-10-10",     // 手工项 → 不动
	"- [ ] 🏃 晨跑 #计划/晨跑2 🛫 2026-10-10 📅 2026-10-10",         // 标签不同 → 不动（防前缀误伤）
	"- [ ] ✍️ 写作 → [[2026-10-10 复盘]] #计划/写作 🛫 2026-10-10 📅 2026-10-10", // 不在白名单 → 不动
	"", "## 📝 今日总结", "",
].join("\n");
const mixed2 = renameAutoCheckLines(MIXED2, ["晨跑", "写作"], ["🏃 晨跑", "🏃"], "🏃 晨跑");
check("⑤ 对照组：手工项名不受影响", mixed2.includes("阅读 30 分钟 #计划/晨跑"), mixed2);
check("⑤ 对照组：前缀相似的另一个计划不被误伤（#计划/晨跑2）", mixed2.includes("- [ ] 🏃 晨跑 #计划/晨跑2 "), mixed2);
check("⑤ 对照组：不在白名单的其它文本原样保留", mixed2.includes("✍️ 写作 → [[2026-10-10 复盘]]"), mixed2);
check("⑤ 同一份样本里：坏行被自愈、手工项没动（两件事同时成立）",
	mixed2.includes("- [ ] 🏃 晨跑 #计划/晨跑 ") && mixed2.includes("阅读 30 分钟 #计划/晨跑"), mixed2);

// ⑥ 改名联动：savePlan 是「先换 #计划/ 标签、再校正文本」两步串联 —— 串起来也要对
const TAGGED = ["## ✅ 今日打卡", "- [ ] 🏃 #计划/晨跑 🛫 2026-10-10 📅 2026-10-10", "", "## 📝 今日总结", ""].join("\n");
const afterTag = TAGGED.replace(/#计划\/晨跑(?=\s|$)/g, "#计划/晨跑A");
const afterRename = renameAutoCheckLines(afterTag, ["晨跑", "晨跑A"], ["🏃", "🏃 晨跑"], "🏃 晨跑A");
check("⑥ 改名联动：标签换成新名后文本同步到新口径",
	afterRename.includes("- [ ] 🏃 晨跑A #计划/晨跑A"), afterRename);

// ---------------------------------------------------------------------------
// v1.2.3：手动新增的打卡项自动带计划图标（withPlanIcon）
// 用户反馈：「在同一个计划下新增的打卡项应该自动带相同的计划图标」
// ---------------------------------------------------------------------------
check("⑦ 图标：名字不带图标时补上计划图标", withPlanIcon("喝水 500ml", "🏃") === "🏃 喝水 500ml", withPlanIcon("喝水 500ml", "🏃"));
check("⑦ 图标：已带同图标不重复补（不会变成 `🏃 🏃 喝水`）", withPlanIcon("🏃 喝水", "🏃") === "🏃 喝水", withPlanIcon("🏃 喝水", "🏃"));
check("⑦ 图标：计划没图标（空串）→ 原样返回，不塞空格", withPlanIcon("喝水", "") === "喝水", withPlanIcon("喝水", ""));
check("⑦ 图标：计划没图标（null / undefined）→ 原样返回",
	withPlanIcon("喝水", null) === "喝水" && withPlanIcon("喝水", undefined) === "喝水");
check("⑦ 图标：名字首尾空白被 trim", withPlanIcon("  喝水  ", "🏃") === "🏃 喝水", withPlanIcon("  喝水  ", "🏃"));
check("⑦ 图标：图标自身带空白也能正常判重", withPlanIcon("🏃 喝水", " 🏃 ") === "🏃 喝水", withPlanIcon("🏃 喝水", " 🏃 "));
check("⑦ 图标：名字恰好就是该图标 → 原样", withPlanIcon("🏃", "🏃") === "🏃", withPlanIcon("🏃", "🏃"));

// 对照组（必须有）：否则「一律加前缀」这种错实现也能全绿。
check("⑦ 对照组：用户执意用别的图标时仍补计划图标（同计划同图标是硬规则）",
	withPlanIcon("💧 喝水", "🏃") === "🏃 💧 喝水", withPlanIcon("💧 喝水", "🏃"));
check("⑦ 对照组：带图标的手工项 ≠ 自动项名 —— 带图标不会让它变成「不可删」",
	withPlanIcon("喝水", "🏃") !== autoCheckItemName("🏃", "晨跑"), withPlanIcon("喝水", "🏃"));
check("⑦ 对照组：不同计划的图标不会混淆（🏃 计划的项不会带成 📖）",
	withPlanIcon("喝水", "🏃") !== withPlanIcon("喝水", "📖"), withPlanIcon("喝水", "🏃"));

// ---------------------------------------------------------------------------
// v1.2.3：显示层裁后缀（collapseAutoSuffix）—— checkDisplayText 的 ② 兜底
// ⚠️ 它同时是**打卡记录行的键**：裁错了不只是显示变短，还会让手工项与自动项**撞键**。
// ---------------------------------------------------------------------------
check("⑧ 裁后缀：标准名 + 空格 + 历史时长后缀 → 裁回标准名",
	collapseAutoSuffix("✍️ 写作 1小时", "✍️ 写作") === "✍️ 写作", collapseAutoSuffix("✍️ 写作 1小时", "✍️ 写作"));
check("⑧ 裁后缀：非时长后缀（复盘+次日计划）同样裁掉",
	collapseAutoSuffix("📈 复盘 复盘+次日计划", "📈 复盘") === "📈 复盘");
check("⑧ 裁后缀：复盘链接原样保留",
	collapseAutoSuffix("📈 复盘 复盘+次日计划 → [[2026-10-02 复盘]]", "📈 复盘") === "📈 复盘 → [[2026-10-02 复盘]]");
check("⑧ 裁后缀：已等于标准名 → 原样", collapseAutoSuffix("✍️ 写作", "✍️ 写作") === "✍️ 写作");
check("⑧ 裁后缀：不以标准名开头 → 原样", collapseAutoSuffix("阅读 30 分钟", "🚶 晨跑") === "阅读 30 分钟");
check("⑧ 裁后缀：canon 为空 / null → 原样",
	collapseAutoSuffix("🚶 晨跑 1小时", "") === "🚶 晨跑 1小时" && collapseAutoSuffix("x", null) === "x");

// 🔴 v1.2.3 真机回归（本组是核心）：手工项带上了图标前缀后，
//    「计划名紧连词」的命名（晨跑热身 / 写作素材）**绝不能**被裁 ——
//    真机实测过：裁掉后打卡卡上出现两行「🚶 晨跑」，且两行打卡记录撞同一个键。
check("⑧ 关键回归：手工项「🚶 晨跑热身」不被裁（紧连词）",
	collapseAutoSuffix("🚶 晨跑热身", "🚶 晨跑") === "🚶 晨跑热身", collapseAutoSuffix("🚶 晨跑热身", "🚶 晨跑"));
check("⑧ 关键回归：手工项「🚶 喝水 500ml」不受影响（前缀不同）",
	collapseAutoSuffix("🚶 喝水 500ml", "🚶 晨跑") === "🚶 喝水 500ml");
// 已知残留（写进断言是为了将来改规则时必须显式改这里）：带空格的补充命名仍会被裁。
check("⑧ 已知残留：`{计划名} {补充词}` 仍会被裁（真库 50 篇日记无此类数据）",
	collapseAutoSuffix("🚶 晨跑 加强版", "🚶 晨跑") === "🚶 晨跑", collapseAutoSuffix("🚶 晨跑 加强版", "🚶 晨跑"));

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
// 用抛错而非 process.exit 汇报失败：process.exit 会掐断 runner，后面的套件就跑不到了。
if (failed > 0) throw new Error(`${failed} 个断言失败`);
