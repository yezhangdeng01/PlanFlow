/**
 * 路径拼接（v1.0.5）。
 *
 * 为什么值得单列一个模块：根目录 `rootPath` 是用户可填的设置项，
 * 而拼接点散落在 4 个文件里（PlanBoardView 18 处、stats 3 处、achievements 2 处、
 * settings 2 处）。此前只有 5 处记得 `replace(/\/+$/, "")`，其余直接 `${root}/...`——
 * 用户在设置里填 `raw/计划/`（带尾斜杠）就会拼出 `raw/计划//2026/...`，
 * `getAbstractFileByPath` 匹配不上，整页表现为「今日笔记不存在」。
 *
 * 设置项只做了 `.trim()`（见 settings.ts），不会去掉尾斜杠，所以拼接侧必须兜。
 *
 * 同时统一「年目录」的取法：`${date.slice(0,4)}` 这个写法散落多处，
 * 一旦有一处写成 `date.substring` 或忘了 slice，路径就悄悄错了 —— 收进函数里。
 */

/** 去掉首尾斜杠（只去一层连续的反斜杠/正斜杠混合）。 */
function stripSlashes(p: string): string {
	return p.replace(/^\/+|\/+$/g, "");
}

/** 拼接多个路径片段，自动处理分隔符，避免出现 `//`。 */
export function joinPath(...parts: (string | undefined | null)[]): string {
	const cleaned = parts
		.filter((p): p is string => typeof p === "string" && p.length > 0)
		.map((p) => stripSlashes(p))
		.filter((p) => p.length > 0);
	return cleaned.join("/");
}

/** 根目录规范化：去首尾斜杠。空值退回默认 `raw/计划`（与 settings 的兜底一致）。 */
export function rootPath(root: string | undefined | null): string {
	const cleaned = stripSlashes((root ?? "").trim());
	return cleaned.length > 0 ? cleaned : "raw/计划";
}

/** `raw/计划` + `2026` → `raw/计划/2026`（年目录）。 */
export function yearDir(root: string, year: string | number): string {
	return joinPath(root, String(year));
}

/** `raw/计划` + `2026` + `每日` → `raw/计划/2026/每日`（每日目录）。 */
export function dailyDir(root: string, year: string | number): string {
	return joinPath(root, String(year), "每日");
}

/** 周目录：`raw/计划/2026/周`。 */
export function weekDir(root: string, year: string | number): string {
	return joinPath(root, String(year), "周");
}

/** 月目录：`raw/计划/2026/月`。 */
export function monthDir(root: string, year: string | number): string {
	return joinPath(root, String(year), "月");
}

/** 周记文件路径：`raw/计划/2026/周/2026-W42.md`（label 原样拼）。 */
export function weekNotePath(root: string, year: string | number, label: string): string {
	return joinPath(root, String(year), "周", `${label}.md`);
}

/** 月记文件路径：`raw/计划/2026/月/2026-10.md`。 */
export function monthNotePath(root: string, year: string | number, label: string): string {
	return joinPath(root, String(year), "月", `${label}.md`);
}

/**
 * 某一天的每日笔记路径：`raw/计划/2026/每日/2026-10-04.md`。
 * `date` 传 `YYYY-MM-DD`（传 Date 也能用，会按本地时区取年月日）。
 */
export function dailyNotePath(root: string, date: string | Date): string {
	const iso = typeof date === "string" ? date : toLocalISO(date);
	return joinPath(root, iso.slice(0, 4), "每日", `${iso}.md`);
}

/** 年度计划文件路径。`year` 为空时返回不带年份的根级文件（兼容旧布局）。 */
export function annualPlanPath(root: string, year?: string | number | null): string {
	return joinPath(root, year ? String(year) : "", "年度计划.md");
}

/** 任务池文件路径。 */
export function taskPoolPath(root: string, year?: string | number | null): string {
	return joinPath(root, year ? String(year) : "", "任务.md");
}

/** 复盘模板路径（根级，不分年份）。 */
export function reviewTemplatePath(root: string): string {
	return joinPath(root, "复盘模板.md");
}

/** 成就文件路径。 */
export function achievementPath(root: string, year: string | number): string {
	return joinPath(root, String(year), "成就.md");
}

/** `Date` → `YYYY-MM-DD`（本地时区；不要用 toISOString，那是 UTC，会差一天）。 */
export function toLocalISO(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
