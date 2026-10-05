/**
 * 路径工具（v1.0.5）行为验证。
 *
 * 核心动机：用户在设置里把 rootPath 填成 `raw/计划/`（带尾斜杠）时，
 * 旧代码 25 处 `${root}/...` 会拼出 `raw/计划//2026/...` → getAbstractFileByPath
 * 匹配不上 → 整页显示「今日笔记不存在」。设置项只做了 trim()，不会去尾斜杠，
 * 所以兜底必须在拼接侧。
 */
import {
	joinPath,
	rootPath,
	yearDir,
	dailyDir,
	dailyNotePath,
	annualPlanPath,
	taskPoolPath,
	reviewTemplatePath,
	achievementPath,
	toLocalISO,
} from "../src/paths";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}

// ═══ 1. joinPath ═══
check("joinPath 常规拼接", joinPath("raw/计划", "2026", "每日") === "raw/计划/2026/每日", joinPath("raw/计划", "2026", "每日"));
check("joinPath 去尾斜杠（核心：防 // ）", joinPath("raw/计划/", "2026") === "raw/计划/2026", joinPath("raw/计划/", "2026"));
check("joinPath 去首斜杠", joinPath("/raw/计划", "2026") === "raw/计划/2026", joinPath("/raw/计划", "2026"));
check("joinPath 根路径**只在开头**带斜杠", joinPath("raw/计划", "/2026/") === "raw/计划/2026", joinPath("raw/计划", "/2026/"));
check("joinPath 忽略空片段", joinPath("raw/计划", "", "2026") === "raw/计划/2026", joinPath("raw/计划", "", "2026"));
check("joinPath 忽略 null/undefined", joinPath("raw/计划", null, undefined, "2026") === "raw/计划/2026",
	joinPath("raw/计划", null, undefined, "2026"));
check("joinPath 全空 → 空串", joinPath("", "", "") === "", JSON.stringify(joinPath("", "", "")));
check("joinPath 不动路径中间的连续斜杠（那是有意义的目录名）",
	joinPath("raw//计划", "2026") === "raw//计划/2026", joinPath("raw//计划", "2026"));

// ═══ 2. rootPath 规范化 ═══
check("rootPath 去尾斜杠", rootPath("raw/计划/") === "raw/计划", rootPath("raw/计划/"));
check("rootPath 去首尾斜杠", rootPath("/raw/计划/") === "raw/计划", rootPath("/raw/计划/"));
check("rootPath 多层尾斜杠全去", rootPath("raw/计划///") === "raw/计划", rootPath("raw/计划///"));
check("rootPath 常规值不变", rootPath("raw/计划") === "raw/计划");
check("rootPath 空值退回默认", rootPath("") === "raw/计划", rootPath(""));
check("rootPath 纯斜杠退回默认", rootPath("///") === "raw/计划", rootPath("///"));
check("rootPath undefined 退回默认", rootPath(undefined) === "raw/计划");
check("rootPath 含空格会 trim（与设置项一致）", rootPath("  raw/计划  ") === "raw/计划", rootPath("  raw/计划  "));

// ═══ 3. 年目录 / 每日目录 ═══
check("yearDir", yearDir("raw/计划", 2026) === "raw/计划/2026", yearDir("raw/计划", 2026));
check("yearDir 带尾斜杠的 root", yearDir("raw/计划/", 2026) === "raw/计划/2026", yearDir("raw/计划/", 2026));
check("yearDir 接数字", yearDir("raw/计划", "2026") === "raw/计划/2026");
check("dailyDir", dailyDir("raw/计划", 2026) === "raw/计划/2026/每日", dailyDir("raw/计划", 2026));
check("dailyDir 带尾斜杠的 root", dailyDir("raw/计划/", 2026) === "raw/计划/2026/每日", dailyDir("raw/计划/", 2026));

// ═══ 4. 每日笔记路径 ═══
check("dailyNotePath 常规", dailyNotePath("raw/计划", "2026-10-04") === "raw/计划/2026/每日/2026-10-04.md",
	dailyNotePath("raw/计划", "2026-10-04"));
check("dailyNotePath 带尾斜杠的 root（这是要修的 bug）",
	dailyNotePath("raw/计划/", "2026-10-04") === "raw/计划/2026/每日/2026-10-04.md",
	dailyNotePath("raw/计划/", "2026-10-04"));
check("dailyNotePath 跨年：日期决定年目录，不另传 year",
	dailyNotePath("raw/计划", "2025-01-05") === "raw/计划/2025/每日/2025-01-05.md",
	dailyNotePath("raw/计划", "2025-01-05"));
check("dailyNotePath 接受 Date 对象（本地时区）",
	dailyNotePath("raw/计划", new Date(2026, 9, 4)) === "raw/计划/2026/每日/2026-10-04.md",
	dailyNotePath("raw/计划", new Date(2026, 9, 4)));
// ⚠️ 这条是踩坑点：toISOString() 是 UTC，本地早上 8 点前会算成前一天
check("dailyNotePath 用 Date 时不被 UTC 偏移（本地 0 点 = 当天）",
	dailyNotePath("raw/计划", new Date(2026, 0, 1, 0, 30)) === "raw/计划/2026/每日/2026-01-01.md",
	dailyNotePath("raw/计划", new Date(2026, 0, 1, 0, 30)));

// ═══ 5. 固定文件名 ═══
check("annualPlanPath 带年", annualPlanPath("raw/计划", 2026) === "raw/计划/2026/年度计划.md",
	annualPlanPath("raw/计划", 2026));
check("annualPlanPath 不带年（兼容旧布局）", annualPlanPath("raw/计划") === "raw/计划/年度计划.md",
	annualPlanPath("raw/计划"));
check("annualPlanPath 带尾斜杠的 root", annualPlanPath("raw/计划/", 2026) === "raw/计划/2026/年度计划.md",
	annualPlanPath("raw/计划/", 2026));
check("taskPoolPath 带年", taskPoolPath("raw/计划", 2026) === "raw/计划/2026/任务.md", taskPoolPath("raw/计划", 2026));
check("taskPoolPath 不带年", taskPoolPath("raw/计划") === "raw/计划/任务.md", taskPoolPath("raw/计划"));
check("reviewTemplatePath（根级，不分年）", reviewTemplatePath("raw/计划/") === "raw/计划/复盘模板.md",
	reviewTemplatePath("raw/计划/"));
check("achievementPath", achievementPath("raw/计划/", 2026) === "raw/计划/2026/成就.md", achievementPath("raw/计划/", 2026));

// ═══ 6. toLocalISO ═══
check("toLocalISO 正常", toLocalISO(new Date(2026, 9, 4)) === "2026-10-04", toLocalISO(new Date(2026, 9, 4)));
check("toLocalISO 补零（月份/日期）", toLocalISO(new Date(2026, 0, 5)) === "2026-01-05", toLocalISO(new Date(2026, 0, 5)));
check("toLocalISO 12 月", toLocalISO(new Date(2026, 11, 31)) === "2026-12-31", toLocalISO(new Date(2026, 11, 31)));
// 与 toISOString 的差异就是它存在的理由
check("toLocalISO 与 toISOString 在本地凌晨确实不同（说明为何不能用后者）",
	toLocalISO(new Date(2026, 0, 1, 0, 30)) !== new Date(2026, 0, 1, 0, 30).toISOString().slice(0, 10),
	{ 本地: toLocalISO(new Date(2026, 0, 1, 0, 30)), UTC: new Date(2026, 0, 1, 0, 30).toISOString().slice(0, 10) });

// ═══ 7. 中文与空格 ═══
check("含中文与空格的路径正常", dailyNotePath("raw/我的 计划", "2026-10-04") === "raw/我的 计划/2026/每日/2026-10-04.md",
	dailyNotePath("raw/我的 计划", "2026-10-04"));

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
if (failed > 0) throw new Error(`${failed} 个断言失败`);
