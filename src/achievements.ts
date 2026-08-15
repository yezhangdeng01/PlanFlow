import { App, TFile, TFolder } from "obsidian";
import { addDays, daysInMonth, formatDate, parseDailyContent, parseDateString } from "./daily";

/**
 * Rewards (v3): weekly/monthly badge settlement + consecutive check-in streak.
 *
 * Settlement writes to `{root}/{year}/成就.md` — the only user note this module
 * ever writes, and only through settleWeek / settleMonth (idempotent per period).
 * All reads reuse daily.ts parsing per DEV.md.
 */

/** One badge tier (color class + medal + labels). */
export interface BadgeTier {
	/** CSS tier class (`is-gold` / `is-silver` / `is-bronze`). */
	cls: string;
	/** Medal emoji, e.g. 🥇. */
	emoji: string;
	/** Tier display name, e.g. 金徽章. */
	tierName: string;
	/** Qualifier, e.g. 完美. */
	qualifier: string;
}

export interface BadgeCounts {
	gold: number;
	silver: number;
	bronze: number;
}

const GOLD: BadgeTier = { cls: "is-gold", emoji: "🥇", tierName: "金徽章", qualifier: "完美" };
const SILVER: BadgeTier = { cls: "is-silver", emoji: "🥈", tierName: "银徽章", qualifier: "优秀" };
const BRONZE: BadgeTier = { cls: "is-bronze", emoji: "🥉", tierName: "铜徽章", qualifier: "合格" };

/**
 * Completion-rate tier: ≥100 gold / ≥80 silver / ≥60 bronze.
 * Null below bronze or when there is no data (done ≤ 0 or total ≤ 0).
 */
export function tierFor(done: number, total: number): BadgeTier | null {
	if (total <= 0 || done <= 0) return null;
	const ratio = done / total;
	if (ratio >= 1) return GOLD;
	if (ratio >= 0.8) return SILVER;
	if (ratio >= 0.6) return BRONZE;
	return null;
}

/** Path of the achievement file for a year. */
function achievementPath(rootPath: string, year: string): string {
	return `${rootPath.replace(/\/+$/, "")}/${year}/成就.md`;
}

/**
 * Idempotent: appends one period record to 成就.md unless that period's
 * section already exists. Only settles when completion rate ≥ 60% (>0).
 */
async function settleRecord(
	app: App,
	rootPath: string,
	year: string,
	label: string,
	range: string,
	done: number,
	total: number,
	kind: "task" | "checkin" = "task"
): Promise<void> {
	const tier = tierFor(done, total);
	if (!tier) return;

	const path = achievementPath(rootPath, year);
	const dir = path.slice(0, path.lastIndexOf("/"));
	const percent = Math.round((done / total) * 100);
	const kindText = kind === "task" ? "任务完成率" : "打卡完成率";
	const line = `- ${kindText} ${percent}% → ${tier.emoji} ${tier.tierName}「${tier.qualifier}」`;
	const block = `## ${label}（${range}）\n${line}`;

	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		const content = await app.vault.cachedRead(existing);
		const lines = content.split("\n");
		// 幂等：该周期段落内已存在同 kind 记录 → 跳过
		let inSection = false;
		let hasKind = false;
		for (const l of lines) {
			if (l.startsWith("## ")) inSection = l.startsWith(`## ${label}`);
			else if (inSection && l.startsWith(`- ${kindText}`)) hasKind = true;
		}
		if (hasKind) return;
		const trimmed = content.replace(/\s+$/, "");
		if (inSection) {
			// 段落已存在（另一 kind）：在段落末尾（下一空行/下一段落前）补行
			const sectionIdx = lines.findIndex((l) => l.startsWith(`## ${label}`));
			let insertAt = sectionIdx + 1;
			while (insertAt < lines.length && lines[insertAt].trim() !== "" && !lines[insertAt].startsWith("## ")) insertAt++;
			lines.splice(insertAt, 0, line);
			await app.vault.process(existing, () => lines.join("\n").replace(/\n{3,}/g, "\n\n"));
		} else {
			const newContent = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
			await app.vault.process(existing, () => newContent);
		}
	} else {
		await ensureFolder(app, dir);
		await app.vault.create(path, `${block}\n`);
	}
}

/** Weekly badge settlement. `weekLabel` like `2026-W33`. */
export async function settleWeek(
	app: App,
	root: string,
	year: string,
	weekLabel: string,
	done: number,
	total: number
): Promise<void> {
	const m = /^(\d{4})-W(\d{2})$/.exec(weekLabel);
	if (!m) return;
	const labelYear = m[1];
	const week = parseInt(m[2], 10);
	const mon = isoWeekMonday(parseInt(labelYear, 10), week);
	const sun = addDays(mon, 6);
	const range = `${formatDate(mon).slice(5)} ~ ${formatDate(sun).slice(5)}`;
	await settleRecord(app, root, labelYear, weekLabel, range, done, total, "task");
}

/** Weekly check-in badge settlement (habit dimension). */
export async function settleWeekCheckin(
	app: App,
	root: string,
	year: string,
	weekLabel: string,
	done: number,
	total: number
): Promise<void> {
	const m = /^(\d{4})-W(\d{2})$/.exec(weekLabel);
	if (!m) return;
	const labelYear = m[1];
	const week = parseInt(m[2], 10);
	const mon = isoWeekMonday(parseInt(labelYear, 10), week);
	const sun = addDays(mon, 6);
	const range = `${formatDate(mon).slice(5)} ~ ${formatDate(sun).slice(5)}`;
	await settleRecord(app, root, labelYear, weekLabel, range, done, total, "checkin");
}

/** Monthly badge settlement. `monthLabel` like `2026-08`. */
export async function settleMonth(
	app: App,
	root: string,
	year: string,
	monthLabel: string,
	done: number,
	total: number
): Promise<void> {
	const m = /^(\d{4})-(\d{2})$/.exec(monthLabel);
	if (!m) return;
	const labelYear = m[1];
	const [y, mo] = monthLabel.split("-").map(Number);
	const start = `${monthLabel}-01`;
	const end = `${monthLabel}-${String(daysInMonth(y, mo)).padStart(2, "0")}`;
	const range = `${start.slice(5)} ~ ${end.slice(5)}`;
	await settleRecord(app, root, labelYear, monthLabel, range, done, total, "task");
}

/** Monthly check-in badge settlement (habit dimension). */
export async function settleMonthCheckin(
	app: App,
	root: string,
	year: string,
	monthLabel: string,
	done: number,
	total: number
): Promise<void> {
	const m = /^(\d{4})-(\d{2})$/.exec(monthLabel);
	if (!m) return;
	const labelYear = m[1];
	const [y, mo] = monthLabel.split("-").map(Number);
	const start = `${monthLabel}-01`;
	const end = `${monthLabel}-${String(daysInMonth(y, mo)).padStart(2, "0")}`;
	const range = `${start.slice(5)} ~ ${end.slice(5)}`;
	await settleRecord(app, root, labelYear, monthLabel, range, done, total, "checkin");
}

/** Read 成就.md and count gold/silver/bronze medals. */
export async function badgeCounts(app: App, root: string, year: string): Promise<BadgeCounts> {
	const file = app.vault.getAbstractFileByPath(achievementPath(root, year));
	if (!(file instanceof TFile)) return { gold: 0, silver: 0, bronze: 0 };
	const content = await app.vault.cachedRead(file);
	const counts: BadgeCounts = { gold: 0, silver: 0, bronze: 0 };
	for (const line of content.split("\n")) {
		if (!line.startsWith("- ") || !line.includes("→")) continue;
		if (line.includes("🥇")) counts.gold++;
		else if (line.includes("🥈")) counts.silver++;
		else if (line.includes("🥉")) counts.bronze++;
	}
	return counts;
}

/**
 * Read the badges settled for one period (e.g. week label "2026-W33" or
 * month label "2026-08"). Returns formatted badge rows like
 * ["🥇 完美（任务）", "🥈 优秀（打卡）"] — empty when nothing settled.
 */
export async function readPeriodBadges(
	app: App,
	root: string,
	year: string,
	label: string
): Promise<string[]> {
	const file = app.vault.getAbstractFileByPath(achievementPath(root, year));
	if (!(file instanceof TFile)) return [];
	const content = await app.vault.cachedRead(file);
	const lines = content.split("\n");
	let inSection = false;
	const out: string[] = [];
	for (const line of lines) {
		if (line.startsWith("## ")) {
			inSection = line.startsWith(`## ${label}`);
			continue;
		}
		if (!inSection || !line.startsWith("- ") || !line.includes("→")) continue;
		const emoji = line.includes("🥇") ? "🥇" : line.includes("🥈") ? "🥈" : line.includes("🥉") ? "🥉" : null;
		if (!emoji) continue;
		const qualifier = /「(.+?)」/.exec(line)?.[1] ?? "";
		const kind = line.includes("任务完成率") ? "任务" : "打卡";
		out.push(`${emoji} ${qualifier}（${kind}）`);
	}
	return out;
}

/**
 * Read every badge settled within a month — the month's own badges plus the
 * badges of every ISO week whose range starts inside that month (week → month
 * progression). Returns rows like "🥇 完美（任务）" with a 周/月 source marker.
 */
export async function readMonthBadges(
	app: App,
	root: string,
	year: string,
	monthLabel: string
): Promise<string[]> {
	const file = app.vault.getAbstractFileByPath(achievementPath(root, year));
	if (!(file instanceof TFile)) return [];
	const content = await app.vault.cachedRead(file);
	const mm = monthLabel.slice(5, 7);
	const out: string[] = [];
	let inSection = false;
	let sectionLabel = "";
	for (const line of content.split("\n")) {
		if (line.startsWith("## ")) {
			const m = /^## (\d{4}-W\d{2}|(\d{4}-\d{2}))/.exec(line);
			sectionLabel = m ? m[1] : "";
			inSection = false;
			if (m) {
				if (m[2]) {
					// 月段落：本月自身徽章
					inSection = m[2] === monthLabel;
				} else {
					// 周段落：range 起点月份属于本月 → 计入
					const rangeM = /（(\d{2})-(\d{2})/.exec(line);
					inSection = rangeM ? rangeM[1] === mm : false;
				}
			}
			continue;
		}
		if (!inSection || !line.startsWith("- ") || !line.includes("→")) continue;
		const emoji = line.includes("🥇") ? "🥇" : line.includes("🥈") ? "🥈" : line.includes("🥉") ? "🥉" : null;
		if (!emoji) continue;
		const qualifier = /「(.+?)」/.exec(line)?.[1] ?? "";
		const kind = line.includes("任务完成率") ? "任务" : "打卡";
		out.push(`${emoji} ${qualifier}（${kind}）`);
	}
	return out;
}

/**
 * Consecutive check-in streak: walk backwards from yesterday; a day counts when
 * its daily note exists and every check-in item is checked. Stops on the first
 * missing/incomplete day. Today itself never counts (reward v3).
 * Reuses daily.ts parsing (DEV.md §6).
 */
export async function computeStreak(
	app: App,
	root: string,
	year: string,
	today: string
): Promise<number> {
	const rootPath = root.replace(/\/+$/, "");
	let streak = 0;
	let cur = addDays(parseDateString(today), -1); // start from yesterday
	// Each date resolves its own year folder, so the streak crosses year boundaries.
	for (let i = 0; i < 3700; i++) {
		const ds = formatDate(cur);
		const path = `${rootPath}/${ds.slice(0, 4)}/每日/${ds}.md`;
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) break;
		const content = await app.vault.cachedRead(file);
		const data = parseDailyContent(file, content, ds);
		if (data.checkItems.length === 0) break;
		if (!data.checkItems.every((c) => c.checked)) break;
		streak++;
		cur = addDays(cur, -1);
	}
	return streak;
}

/** Monday of the given ISO week (ISO week 1 = the week containing the first Thursday). */
function isoWeekMonday(year: number, week: number): Date {
	const jan4 = new Date(year, 0, 4);
	const day = jan4.getDay() || 7; // Mon=1 … Sun=7
	const jan4Mon = addDays(jan4, 1 - day);
	return addDays(jan4Mon, (week - 1) * 7);
}

/** Create folders along a vault path (no-op for existing ones). */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = folderPath.split("/").filter(Boolean);
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(cur);
		if (existing instanceof TFolder) continue;
		if (existing) return; // path conflict
		await app.vault.createFolder(cur);
	}
}
