/**
 * 统计缓存（v1.0.5）行为验证。
 *
 * 为什么测这个：年统计要把窗口内每篇每日笔记读一遍 + parseDailyContent
 * （真库满年 365 篇），而回顾页一次刷新就 year+week+month 连算，首页 banner 与
 * settle 判定还会再算 —— 加了 keyed cache 后必须证明两件事：
 *   ① 命中时**真的不再读文件**（否则缓存等于白加）；
 *   ② 任何输入变化 / 显式失效后**一定重算**（否则就是算错，比慢更糟）。
 */
import { App, TFile } from "obsidian";
import { computePeriodStats, invalidateStatsCache, invalidateAllStatsCaches } from "../src/stats";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
	if (!cond) failed++;
}

/** mock 的 TFile 是空类（没有构造参数），实例字段必须手工挂上去。 */
function mkFile(path: string, basename: string): TFile {
	const f = new TFile();
	return Object.assign(f, { path, name: `${basename}.md`, basename, stat: { mtime: 0 } }) as TFile;
}

const DAILY_ALL_DONE = "## ✅ 今日打卡\n- [x] ✍️ 写作 #计划/写作\n- [ ] 🏃 健康 #计划/健康\n";
const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const ROOT = "raw/计划";
const TODAY = "2026-10-04";

/** 假 vault：能数 read 次数、能造每日笔记；dailyContent 可中途改，模拟用户勾选。 */
function makeApp(days: string[], dailyContent = DAILY_ALL_DONE): { app: App; readCount: () => number; setDaily: (s: string) => void } {
	let reads = 0;
	let daily = dailyContent;
	const files = days.map((d) => mkFile(`raw/计划/2026/每日/${d}.md`, d));
	const pool = mkFile("raw/计划/2026/任务.md", "任务");
	const planFile = mkFile("raw/计划/2026/年度计划.md", "年度计划");
	const all = [...files, pool, planFile];
	const readOne = (f: TFile): string => (f.path.includes("每日/") ? daily : "---\nplans: []\n---\n");
	const app = {
		vault: {
			getFiles: () => all,
			getAbstractFileByPath: (p: string) => all.find((f) => f.path === p) ?? null,
			async cachedRead(f: TFile) {
				reads++;
				return readOne(f);
			},
			async read(f: TFile) {
				reads++;
				return readOne(f);
			},
		},
	} as unknown as App;
	return { app, readCount: () => reads, setDaily: (s: string) => { daily = s; } };
}

// ═══ 1. 命中缓存：第二次不再读文件 ═══
invalidateAllStatsCaches();
{
	const { app, readCount } = makeApp(DAYS);
	const a = await computePeriodStats(app, ROOT, TODAY, "year", true);
	const afterFirst = readCount();
	const b = await computePeriodStats(app, ROOT, TODAY, "year", true);
	const afterSecond = readCount();

	check("首次计算读了文件", afterFirst > 0, { 首读: afterFirst });
	check("二次命中缓存，零额外读取", afterSecond === afterFirst, { 首读: afterFirst, 二读: afterSecond });
	check("缓存命中返回同一对象引用（未重算）", a === b, { 同一引用: a === b });
	check("结果正确：写作 4 天全打卡", a.planRates.find((r) => r.plan === "写作")?.done === 4, a.planRates);
	check("结果正确：健康 0 天打卡", a.planRates.find((r) => r.plan === "健康")?.done === 0, a.planRates);
}

// ═══ 2. 键里每个输入都必须影响命中 ═══
invalidateAllStatsCaches();
{
	const { app, readCount } = makeApp(DAYS);
	await computePeriodStats(app, ROOT, TODAY, "year", true);


	// 换 rootPath：过滤前缀变了 → dailyFiles 为空 → 读到 0 次文件，但**确实重算了**
	//（结果里 planRates 会变空）。所以判据不能是 read 次数，要看返回的引用是否不同。
	const prevRoot = await computePeriodStats(app, ROOT, TODAY, "year", true);
	const otherRoot = await computePeriodStats(app, "别的根", TODAY, "year", true);
	check("rootPath 变化 → 重算（引用不同）", prevRoot !== otherRoot, { 同一引用: prevRoot === otherRoot });
	check("rootPath 变化 → 结果随之改变（前缀过滤生效）", otherRoot.planRates.length === 0,
		{ 别的根的计划数: otherRoot.planRates.length });
	const afterRoot = readCount();

	await computePeriodStats(app, ROOT, "2026-10-05", "year", true);
	check("today 变化 → 重算", readCount() > afterRoot, { 增量: readCount() - afterRoot });
	const afterToday = readCount();

	await computePeriodStats(app, ROOT, TODAY, "month", true);
	check("type 变化 → 重算", readCount() > afterToday, { 增量: readCount() - afterToday });
	const afterType = readCount();

	await computePeriodStats(app, ROOT, TODAY, "year", false);
	check("reviewWorkdays 变化 → 重算（复盘分母口径不同）", readCount() > afterType, { 增量: readCount() - afterType });
	const afterRw = readCount();

	await computePeriodStats(app, ROOT, TODAY, "year", false);
	check("参数不变 → 命中缓存", readCount() === afterRw, { 读取: readCount() });
}

// ═══ 3. 显式失效 ═══
invalidateAllStatsCaches();
{
	const { app, readCount } = makeApp(DAYS);
	const a = await computePeriodStats(app, ROOT, TODAY, "year", true);
	const before = readCount();

	invalidateStatsCache(app);
	const b = await computePeriodStats(app, ROOT, TODAY, "year", true);
	check("invalidateStatsCache 后重算（引用不同）", a !== b, { 同一引用: a === b });
	check("invalidateStatsCache 后确实重读文件", readCount() > before, { 增量: readCount() - before });
	check("重算结果与原结果内容一致（缓存对调用方透明）", JSON.stringify(a) === JSON.stringify(b));
}

// ═══ 4. force 参数 ═══
invalidateAllStatsCaches();
{
	const { app, readCount } = makeApp(DAYS);
	await computePeriodStats(app, ROOT, TODAY, "year", true);
	const before = readCount();
	await computePeriodStats(app, ROOT, TODAY, "year", true, true);
	check("force=true 绕过缓存重算", readCount() > before, { 增量: readCount() - before });
	const afterForce = readCount();
	await computePeriodStats(app, ROOT, TODAY, "year", true);
	check("force 重算结果也存入缓存（下次命中）", readCount() === afterForce, { 读取: readCount() });
}

// ═══ 5. 缓存按 app 隔离 ═══
invalidateAllStatsCaches();
{
	const a1 = makeApp(DAYS);
	const a2 = makeApp(DAYS);
	const r1 = await computePeriodStats(a1.app, ROOT, TODAY, "year", true);
	const r2 = await computePeriodStats(a2.app, ROOT, TODAY, "year", true);
	check("不同 app 不共享缓存（各自都读了文件）", a1.readCount() > 0 && a2.readCount() > 0,
		{ app1读: a1.readCount(), app2读: a2.readCount() });
	check("两 app 拿到各自对象（未串味）", r1 !== r2, { 同一引用: r1 === r2 });

	const b1 = a1.readCount();
	const b2 = a2.readCount();
	invalidateStatsCache(a1.app);
	await computePeriodStats(a1.app, ROOT, TODAY, "year", true);
	await computePeriodStats(a2.app, ROOT, TODAY, "year", true);
	check("失效 app1 不影响 app2 的缓存", a1.readCount() > b1 && a2.readCount() === b2,
		{ app1: a1.readCount(), app2: a2.readCount() });
}

// ═══ 6. 库变化后必须拿到新值（缓存陈旧是最危险的情况）═══
invalidateAllStatsCaches();
{
	const NOTHING_DONE = "## ✅ 今日打卡\n- [ ] ✍️ 写作 #计划/写作\n";
	const { app, setDaily } = makeApp(DAYS, NOTHING_DONE);
	const before = await computePeriodStats(app, ROOT, TODAY, "year", true);
	check("初始：写作 0 天", before.planRates.find((r) => r.plan === "写作")?.done === 0, before.planRates);

	// 模拟「用户勾了 checkbox」→ vault 事件触发 invalidate → 重算
	setDaily(DAILY_ALL_DONE);
	invalidateStatsCache(app);
	const after = await computePeriodStats(app, ROOT, TODAY, "year", true);
	check("库变化 + invalidate 后拿到新值（写作 4 天）",
		after.planRates.find((r) => r.plan === "写作")?.done === 4, after.planRates);
	check("缓存没有返回陈旧值", before !== after, { 同一引用: before === after });
}

// ═══ 7. 缓存容量上限（实现 12 条，超出淘汰最早一条）═══
invalidateAllStatsCaches();
{
	const { app, readCount } = makeApp(DAYS);
	// 13 个不同键（today 每天挪一天）
	for (let i = 0; i < 13; i++) {
		const iso = new Date(Date.parse("2026-09-25T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
		await computePeriodStats(app, ROOT, iso, "year", true);
	}
	const after13 = readCount();
	const fresh = "2026-12-25";
	const s1 = await computePeriodStats(app, ROOT, fresh, "year", true);
	check("未进过缓存的键 → 必然重算", readCount() > after13, { 增量: readCount() - after13 });
	check("超出容量后仍返回正确结果", s1.planRates.length > 0, { 计划数: s1.planRates.length });

	const afterFresh = readCount();
	await computePeriodStats(app, ROOT, fresh, "year", true);
	check("新键已入缓存，第二次命中", readCount() === afterFresh, { 读取: readCount() });

	// 最早的 2026-09-25 超过 12 条上限应已被淘汰 → 再算会重读
	const beforeOld = readCount();
	await computePeriodStats(app, ROOT, "2026-09-25", "year", true);
	check("超出容量的最早键已被淘汰（会重算）", readCount() > beforeOld, { 增量: readCount() - beforeOld });
}

// ═══ 8. 空库不崩 ═══
invalidateAllStatsCaches();
{
	const { app } = makeApp([]);
	const s = await computePeriodStats(app, ROOT, TODAY, "year", true);
	check("空库（无每日笔记）不崩且返回零值", s.planRates.length === 0 && s.taskTotal === 0,
		{ planRates: s.planRates.length, taskTotal: s.taskTotal });
	const s2 = await computePeriodStats(app, ROOT, TODAY, "week", true);
	check("空库周统计也不崩", s2.type === "week", { type: s2.type });
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
// 用抛错而非 process.exit 汇报失败：process.exit 会掐断 runner，后面的套件就跑不到了。
if (failed > 0) throw new Error(`${failed} 个断言失败`);
