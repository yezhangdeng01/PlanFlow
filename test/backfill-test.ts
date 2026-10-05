/**
 * v7.22 补卡（backfill）专项离线测试。
 *
 * 为什么单独写一份：补卡的坑**全部集中在「跨文件定位」** —— 行号在另一篇里无效、
 * 复盘链接尾段两侧形态不同、时长后缀历史遗留、目标文件可能整个不存在。
 * 这些用真机点鼠标验起来慢且容易漏，而它们恰恰是「点了没反应」的根因。
 *
 * 覆盖：
 *   1. findCheckLineByPlan  跨文件按计划名定位（含复盘链接 / 时长后缀两种历史形态）
 *   2. setCheckLineChecked   勾 / 取消，且不吃错行
 *   3. upsert/removeCheckLog 补卡记录行的增删（跨日期共存）
 *   4. 端到端：模拟「今天那篇 → 昨天那篇」的补卡全流程
 */
import { findCheckLineByPlan, setCheckLineChecked, normalizeCheckName, upsertCheckLog, removeCheckLog, appendCheckItem, parseDailyContent, CHECK_HEADING, buildCheckLine } from "../src/daily";
import { TFile } from "obsidian";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}

/** 昨天那篇的真实内容（复盘项带链接、写作项带历史时长后缀）。 */
const YESTERDAY = `---
date: 2026-10-02
type: daily
---
# 📅 2026-10-02 星期五

## ✅ 今日打卡
- [ ] ✍️ 写作 1小时 #计划/写作 🛫 2026-10-02 📅 2026-10-02
- [x] 🏃 健康 #计划/健康 🛫 2026-10-02 📅 2026-10-02
- [ ] 📈 复盘 复盘+次日计划 → [[2026-10-02 复盘]] #计划/复盘 🛫 2026-10-02 📅 2026-10-02

## 📝 今日总结
`;

/** 今天那篇（界面渲染的来源）。 */
const TODAY = `---
date: 2026-10-03
type: daily
---
# 📅 2026-10-03 星期六

## ✅ 今日打卡
- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-03 📅 2026-10-03
- [x] 🏃 健康 #计划/健康 🛫 2026-10-03 📅 2026-10-03
- [ ] 📈 复盘 → [[2026-10-03 复盘]] #计划/复盘 🛫 2026-10-03 📅 2026-10-03

## ⏱ 打卡记录

- 2026-10-03 · 🏃 健康 · 用时 30 分钟
- 2026-10-02 · 🏃 健康 · 用时 30 分钟

## 📝 今日总结
`;

// --- 1. normalizeCheckName -----------------------------------------------
check("归一：剥掉复盘链接尾段", normalizeCheckName("📈 复盘 → [[2026-10-02 复盘]]") === "📈 复盘");
check("归一：压掉多余空白", normalizeCheckName("  ✍️   写作  ") === "✍️ 写作");
check("归一：不动时长后缀（合法内容，不能剥）", normalizeCheckName("阅读 30 分钟") === "阅读 30 分钟");

// --- 2. findCheckLineByPlan：跨文件定位（按计划名） ----------------------------------
// 关键：今天的行号（1,2,3）在昨天那篇里指向完全不同的行，
// 所以必须按计划名定位，且 findCheckLineByPlan 找出的行内容要真的对得上。
{
	const tIdx = findCheckLineByPlan(YESTERDAY, "写作", "✍️ 写作"); // 界面显示名（无时长后缀）
	const tLine = YESTERDAY.split("\n")[tIdx];
	check("定位：昨天那篇的「写作」找得到", tIdx !== -1);
	check("定位：找对行了（不是凭行号巧合）", /✍️ 写作/.test(tLine), tLine);
}
{
	// 复盘项：界面名已剥链接，笔记行还带着 —— 归一后必须能对上
	const rIdx = findCheckLineByPlan(YESTERDAY, "复盘", "📈 复盘");
	const rLine = YESTERDAY.split("\n")[rIdx];
	check("定位：复盘项（带链接尾段）能对上", rIdx !== -1 && /复盘/.test(rLine), rLine);
}
{
	// 找不到的项必须返回 -1，不能瞎指一行（否则会勾错行）
	check("定位：不存在的项返回 -1", findCheckLineByPlan(YESTERDAY, "不存在的项", "不存在的项") === -1);
}
{
	// 不许越出打卡区：总结区里若有一行同名的，也不能被当成打卡项
	const tricky = `## ✅ 今日打卡
- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-02 📅 2026-10-02

## 📝 今日总结
- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-02 📅 2026-10-02
`;
	const idx = findCheckLineByPlan(tricky, "写作", "✍️ 写作");
	check("定位：只认打卡区内的行（不串到总结区）", idx === 1, { idx });
}
{
	// 幂等：同一份内容反复查，行号稳定
	const a = findCheckLineByPlan(YESTERDAY, "健康", "🏃 健康");
	const b = findCheckLineByPlan(YESTERDAY, "健康", "🏃 健康");
	check("定位：可重复，行号稳定", a === b && a !== -1, { a, b });
}
{
	// 关键回归（单测第一轮就挂了的那条）：带历史时长后缀的老行必须能定位到。
	// 显示名是「✍️ 写作」，笔记行是「✍️ 写作 1小时」——按显示名匹配必挂，
	// 按计划名（#计划/写作）才对得上。这条是本次改用计划名锚点的全部理由。
	const idx = findCheckLineByPlan(YESTERDAY, "写作", "✍️ 写作");
	const line = YESTERDAY.split("\n")[idx];
	check("定位：带「1小时」历史后缀的老行按计划名命中", idx !== -1 && /✍️ 写作 1小时/.test(line), line);
}
{
	// 复盘项同样带 action + 链接两层遗留，按计划名也要命中
	const idx = findCheckLineByPlan(YESTERDAY, "复盘", "📈 复盘");
	const line = YESTERDAY.split("\n")[idx];
	check("定位：复盘项（action+链接双遗留）按计划名命中", idx !== -1 && /📈 复盘/.test(line), line);
}
{
	// 回退路径：手写行没有 #计划/ 标签时，按归一名匹配
	// （这段没有 frontmatter，「✍️ 写作」在第 0 行）
	const manual = `## ✅ 今日打卡
- [ ] ✍️ 写作 🛫 2026-10-02
- [x] 🏃 健康 🛫 2026-10-02
`;
	const idx = findCheckLineByPlan(manual, "写作", "✍️ 写作");
	check("回退：无 #计划/ 标签的行按显示名命中", idx === 1, { idx });
	// 计划名给了但文件里没有该计划，且行有标签 → 不许回退误配到别的计划的行
	const withTags = `## ✅ 今日打卡
- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-02
- [x] 🏃 健康 #计划/健康 🛫 2026-10-02
`;
	const idx2 = findCheckLineByPlan(withTags, "不存在的计划", "✃ 健康");
	check("回退：计划名对不上时不误配到别的计划行", idx2 === -1, { idx2 });
}

// --- 3. setCheckLineChecked：勾 / 取消 / 不吃错行 -------------------------
{
	const idx = findCheckLineByPlan(YESTERDAY, "写作", "✍️ 写作");
	const out = setCheckLineChecked(YESTERDAY, idx, true);
	const line = out.split("\n")[idx];
	check("勾选：目标行变 - [x]", /^- \[x\] ✍️ 写作/.test(line), line);
	// 「不串到别的行」：逐行比对，除目标行外每一行都必须与原文相同
	const before = YESTERDAY.split("\n");
	const after = out.split("\n");
	const othersIntact = after.every((l, i) => (i === idx ? true : l === before[i]));
	check("勾选：不串到别的行（其余逐行原样）", othersIntact && after.length === before.length, { idx });
	const back = setCheckLineChecked(out, findCheckLineByPlan(out, "写作", "✍️ 写作"), false);
	check("取消勾选：回到 - [ ]", back.split("\n")[idx] === YESTERDAY.split("\n")[idx], back.split("\n")[idx]);
}
{
	// fail-safe：行号越界 / 行型不对 → 原样返回，不许改坏别的行
	check("fail-safe：行号越界原样返回", setCheckLineChecked(YESTERDAY, 999, true) === YESTERDAY);
	const notTask = "## 📝 今日总结\n随便一行文字\n";
	check("fail-safe：非任务行不误勾", setCheckLineChecked(notTask, 1, true) === notTask);
}

// --- 4. 记录行：补卡与今天共存 -------------------------------------------
{
	// 这是修复前用户真库里那行的形态：假日期文本躺在今天文件里
	const dirty = TODAY;
	const dupBefore = dirty.split("\n").filter((l) => l.startsWith("- 2026-10-02 · 🏃 健康")).length;
	check("真库现场：今天那篇里确实躺着一条 10-02 的假记录", dupBefore === 1, { dupBefore });
	// 修复后补卡不应再产生这种行 —— 记录应写进**昨天那篇**
	const y = upsertCheckLog(YESTERDAY, "2026-10-02", "✍️ 写作", "用时 30 分钟");
	check("补卡：记录行写进昨天那篇", y.includes("- 2026-10-02 · ✍️ 写作 · 用时 30 分钟"));
	check("补卡：昨天那篇原本没有记录区 → 新建", y.includes("## ⏱ 打卡记录"));
}
{
	// 同一项同一天再打 → 覆盖不刷屏
	let y = upsertCheckLog(YESTERDAY, "2026-10-02", "✍️ 写作", "用时 30 分钟");
	y = upsertCheckLog(y, "2026-10-02", "✍️ 写作", "用时 60 分钟");
	const n = y.split("\n").filter((l) => l.startsWith("- 2026-10-02 · ✍️ 写作")).length;
	check("幂等：同日期同项只留一条（用时被更新）", n === 1 && y.includes("用时 60 分钟"), { n });
}
{
	// 撤销：只删目标那一行，今天那天的记录不受影响
	const y = upsertCheckLog(YESTERDAY, "2026-10-02", "✍️ 写作", "用时 30 分钟");
	const out = removeCheckLog(y, "2026-10-02", "✍️ 写作");
	check("撤销：删掉目标行", !out.includes("- 2026-10-02 · ✍️ 写作"));
	// 区内不剩记录 → 标题一并撤掉，不留空壳
	check("撤销：空了就撤标题，不留空壳", !out.includes("## ⏱ 打卡记录"));
}

// --- 5. 端到端：模拟补卡全流程 -------------------------------------------
{
	// 场景：10-03 早上打开看板，给 10-02（那篇不存在）补一次「健康」打卡
	function buildDailyNote(): string {
		return `---
date: 2026-10-02
type: daily
---
# 📅 2026-10-02 星期五

## ✅ 今日打卡
- [ ] ✍️ 写作 #计划/写作 🛫 2026-10-02 📅 2026-10-02
- [ ] 🏃 健康 #计划/健康 🛫 2026-10-02 📅 2026-10-02
- [ ] 📈 复盘 → [[2026-10-02 复盘]] #计划/复盘 🛫 2026-10-02 📅 2026-10-02

## 📝 今日总结
`;
	}
	const target = upsertCheckLog(
		setCheckLineChecked(
			buildDailyNote(),
			findCheckLineByPlan(buildDailyNote(), "健康", "🏃 健康"),
			true
		),
		"2026-10-02",
		"🏃 健康",
		"用时 30 分钟"
	);
	// 统计口径只认「文件所属日期 + checkbox」→ 补完后 parse 出来必须是 1
	const f = new TFile();
	const data = parseDailyContent(f, target, "2026-10-02");
	const done = data.checkItems.filter((c) => c.checked).length;
	check("端到端：昨天那篇完成后数 = 1（统计能吃到）", done === 1, { done });

	// 补卡只碰目标那篇：今天那篇的内容对象不能被改（复检：它的脏记录行还在原处）
	const todayCopy = TODAY;
	const afterBackfill = target; // 只对 target 做了操作，todayCopy 未参与
	check("端到端：补卡不影响今天那篇", todayCopy.includes("- 2026-10-03 · 🏃 健康 · 用时 30 分钟") && !afterBackfill.includes("2026-10-03"), {
		todayUntouched: todayCopy === TODAY,
	});

	// 再补第二项（写作）→ 完成数变 2
	const t2 = upsertCheckLog(
		setCheckLineChecked(target, findCheckLineByPlan(target, "写作", "✍️ 写作"), true),
		"2026-10-02",
		"✍️ 写作",
		"用时 30 分钟"
	);
	const done2 = parseDailyContent(f, t2, "2026-10-02").checkItems.filter((c) => c.checked).length;
	check("端到端：补第二项 → 完成数 = 2", done2 === 2, { done2 });
}
{
	// 撤销后逐字节还原 —— 这是补卡最关键的验收点（不能留残迹）。
	// 模拟 checkInOtherDate 的 undo 分支：取消勾 + 删记录行，两步都要有。
	let y = upsertCheckLog(YESTERDAY, "2026-10-02", "✍️ 写作", "用时 30 分钟");
	const checked = setCheckLineChecked(y, findCheckLineByPlan(y, "写作", "✍️ 写作"), true);
	y = removeCheckLog(setCheckLineChecked(checked, findCheckLineByPlan(checked, "写作", "✍️ 写作"), false), "2026-10-02", "✍️ 写作");
	check("端到端：撤销后与原文件一致（无残迹）", y === YESTERDAY, {
		got: y.slice(0, 120),
		stillChecked: /^- \[x\] ✍️ 写作/m.test(y),
		hasLog: y.includes("⏱ 打卡记录"),
	});
}
{
	// 目标那篇没有这一项（昨天用旧模板）→ 补一条进去，而不是静默失败
	const old = `---
date: 2026-10-02
type: daily
---
# 📅 2026-10-02

## 📝 今日总结
`;
	const line = buildCheckLine({ name: "✍️ 写作", plan: "写作", includeReview: false, date: "2026-10-02" });
	const added = appendCheckItem(old, line);
	check("兜底：目标那篇缺该区时能新建并补行", added.includes(CHECK_HEADING) && findCheckLineByPlan(added, "写作", "✍️ 写作") !== -1);
	check("兜底：补出的行窗口是目标日期（不是今天）", added.includes("🛫 2026-10-02") && !added.includes("2026-10-03"), added.split("\n")[3]);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
export default failed === 0 ? 0 : 1;
