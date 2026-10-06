import { ButtonComponent, Modal, Notice, Plugin, TFolder, setIcon } from "obsidian";
import { PlanBoardView, VIEW_TYPE_PLANFLOW } from "./src/PlanBoardView";
import type { PlanFlowSettings } from "./src/settings";
import { DEFAULT_PLAN_COLORS, DEFAULT_SETTINGS, PlanFlowSettingTab } from "./src/settings";

/** 首次启动引导弹窗：新用户四步上手（新建计划 → 量化目标 → 每日打卡 → 追踪进度）。 */
class WelcomeModal extends Modal {
	private onStart: () => void;
	constructor(app: import("obsidian").App, onStart: () => void) {
		super(app);
		this.onStart = onStart;
	}
	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("planboard-welcome");
		contentEl.createDiv({ cls: "planboard-welcome-title", text: "👋 欢迎使用 PlanFlow" });
		contentEl.createDiv({
			cls: "planboard-welcome-sub",
			text: "已为你在库中创建好计划目录，四步开始使用：",
		});
		const steps = [
			["🎯", "新建计划", "打开年度视图 →「＋ 新增计划」，按你自己的分类建（写作 / 健康 / 学习 / 复盘只是例子，想建什么都行）"],
			["📐", "量化目标", "给计划添加量化目标（如 12 篇 / 10 本书），自动拆解到月和周"],
			["✅", "每日打卡", "在「今日打卡」勾选完成项，数据自动汇总到周 / 月 / 年度视图"],
			["📊", "追踪进度", "看板 / 甘特视图 + 铜银金徽章，随时查看目标进度"],
		];
		for (const [emoji, title, desc] of steps) {
			const row = contentEl.createDiv({ cls: "planboard-welcome-step" });
			row.createSpan({ cls: "planboard-welcome-step-emoji", text: emoji });
			const body = row.createDiv();
			body.createDiv({ cls: "planboard-welcome-step-title", text: title });
			body.createDiv({ cls: "planboard-welcome-step-desc", text: desc });
		}
		const footer = contentEl.createDiv({ cls: "planboard-welcome-footer" });
		const startBtn = new ButtonComponent(footer).setButtonText("开始使用").setCta();
		startBtn.onClick(() => {
			this.close();
			this.onStart();
		});
		new ButtonComponent(footer).setButtonText("稍后再说").onClick(() => this.close());
	}
	onClose(): void {
		this.contentEl.empty();
	}
}

export default class PlanFlowPlugin extends Plugin {
	settings: PlanFlowSettings;
	private startupOpenTimer: number | null = null;
	private startupOpened = false;
	/** 侧边栏 ribbon 图标元素（v2.8.1：跟随 settings.icon 动态更新）。 */
	private ribbonIconEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// 首次启动：确保计划目录骨架存在（新用户零报错，不用手动建文件夹）。
		// 必须在 layout-ready 后执行——onload 时 vault 可能尚未扫描完，
		// getAbstractFileByPath 对已有目录会误返回 null → 误判全新安装 → createFolder 撞已存在目录 → 插件崩溃。
		this.app.workspace.onLayoutReady(() => {
			void this.ensurePlanRootSafe();
			// 布局就绪后再补一次（防核心图标晚于插件插入，覆盖排序）
			this.moveRibbonIconFirst();
		});

		this.registerView(VIEW_TYPE_PLANFLOW, (leaf) => {
			return new PlanBoardView(leaf, this);
		});

		this.addCommand({
			id: "open-planboard",
			name: "打开计划总览",
			callback: () => void this.activateView(),
		});

		// 侧边栏图标（点击打开 PlanFlow，主区域）；图标跟随 settings.icon（v2.8.1）
		this.ribbonIconEl = this.addRibbonIcon(this.settings.icon || "home", "PlanFlow 计划总览", () =>
			void this.activateView(),
		);
		this.ribbonIconEl.addClass("planboard-ribbon");
		// v1.0.3: 图标排左侧首位（addRibbonIcon 默认追加在末尾）
		this.moveRibbonIconFirst();

		this.addSettingTab(new PlanFlowSettingTab(this.app, this));

		if (this.settings.openOnStartup) {
			// 借鉴 Homepage 插件方案：监听 layout-change，等 Obsidian 启动恢复流程
			// 完全停止（防抖 700ms）后一次性打开 PlanBoard——不会"打开→被恢复覆盖→重开"闪烁。
			// 恢复期间 layout-change 会连续触发，每次重置计时器；恢复结束 700ms 后打开即稳定。
			this.registerEvent(this.app.workspace.on("layout-change", this.onStartupLayoutChange));
			// 上限兜底：启动 6s 后无论恢复是否结束都强制打开
			window.setTimeout(() => {
				if (!this.startupOpened) void this.activateView();
			}, 6000);
		}
	}

	/** 目录初始化安全壳：任何异常不阻塞插件加载（降级为"本次跳过，下次启动再试"）。 */
	private async ensurePlanRootSafe(): Promise<void> {
		try {
			const created = await this.ensurePlanRoot();
			if (created) {
				window.setTimeout(() => {
					new WelcomeModal(this.app, () => void this.activateView()).open();
				}, 1200);
			}
		} catch (e) {
			console.warn("PlanFlow: 计划目录初始化跳过（下次启动重试）", e);
		}
	}

	/**
	 * 首次启动确保计划目录骨架存在：{rootPath}/{年}/每日|周|月 + 年度计划.md + 任务.md。
	 * 已有年度目录则只补建缺失的年度计划.md；全部已存在返回 false（不弹引导）。
	 *
	 * v1.1.6 加固「升级不得重复添加」：这函数每次启动都跑，所以判断必须**只增不改**——
	 * 绝不能因为「文件读不到」就当成新装库、把骨架连同默认计划一起重建（那会覆盖用户
	 * 数据，且在同步延迟 / iPad 冷启动时高发）。
	 *
	 * 关键：`getAbstractFileByPath` 对「路径不存在」和「索引尚未就绪」**都**返回 null，
	 * 拿它当存在性判断会把老用户误判成新装库。因此存在性一律走
	 * `adapter.exists()`（真实文件系统，异步），只有确认「根目录确实不存在」才建骨架。
	 */
	private async ensurePlanRoot(): Promise<boolean> {
		const year = String(new Date().getFullYear());
		const root = this.settings.rootPath.replace(/\/+$/, "");
		const base = `${root}/${year}`;
		const planPath = `${base}/年度计划.md`;

		// 正常老用户：计划文件在 → 什么都不做（这条占绝大多数启动）
		if (await this.app.vault.adapter.exists(planPath)) return false;

		// 目录已存在但计划文件读不到 → 老用户（含同步中/索引未就绪）。
		// 绝不逐级重建目录、绝不覆盖已有文件，只跳过本次（下次启动重试）。
		if (await this.app.vault.adapter.exists(root)) {
			console.warn(`PlanFlow: ${planPath} 暂不存在，跳过本次补建（下次启动重试）`);
			return false;
		}

		// 根目录确实不存在 → 真·全新安装
		await this.ensureFolder(root);
		await this.ensureFolder(`${base}/每日`);
		await this.ensureFolder(`${base}/周`);
		await this.ensureFolder(`${base}/月`);
		await this.app.vault.create(planPath, this.buildYearPlanTemplate(year));
		// ⚠️ 这里原来漏了 await：`if (adapter.exists(...))` 拿一个**恒为真的 Promise**
		// 当条件 → 取反为 false → 任务.md 永远不创建（lint 的 no-misused-promises
		// 正是社区扫描器的 error 级规则，1.1.2栽过一次，不能放过）。
		if (!(await this.app.vault.adapter.exists(`${base}/任务.md`))) {
			await this.app.vault.create(`${base}/任务.md`, "");
		}
		return true;
	}

	/** 沿路径逐级创建文件夹（已存在跳过，遇文件冲突提示）。 */
	private async ensureFolder(folderPath: string): Promise<void> {
		const parts = folderPath.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(cur);
			if (existing instanceof TFolder) continue;
			if (existing) {
				new Notice(`路径冲突：${cur}`);
				return;
			}
			await this.app.vault.createFolder(cur);
		}
	}

	/**
	 * 新用户年度计划.md 骨架：**只建结构，不预置任何计划**。
	 *
	 * ⚠️ 早期版本在这里硬编码了「写作/健康/学习/复盘」四个计划（连`target:
	 * 每日写作` 这类文案都是作者个人库的），随插件分发进了每个用户 vault——
	 * 等于替所有人凭空造了四个他并不存在的计划，还让计划下拉多出四个候选。
	 * 现改为空`plans:`，由用户在「年度视图 → ＋ 新增计划」自己建。
	 *
	 * `plans: {}` 显式给空字典而非留空：YAML 里裸`plans:` 会解析成 null，
	 * `parsePlansFromFrontmatter` 拿到 null 再遍历会炸（见 plan-file.ts）。
	 */
	private buildYearPlanTemplate(year: string): string {
		const end = `${year}-12-31`;
		return `---
type: yearly
period: ${year}
start: ${year}-01-01
end: ${end}
plans: {}
---
# 🏆 ${year} 年度计划

> 本文件是打卡体系的**唯一配置源**：在 frontmatter 的 \`plans\` 里增删计划、改图标，
> 每日打卡项自动跟着变。或在插件「年度视图 → ＋ 新增计划」里点着建。

## 我的计划

（还没有计划。点上方「＋ 新增计划」，或直接在下面的 \`plans:\` 里照这个格式写：
\`\`\`yaml
plans:
  示例:
    label: 🎯
    daily: true
    target: 填一句目标
\`\`\`
）
`;
	}

	/** layout-change 防抖：恢复稳定后打开 PlanBoard（仅启动期一次）。 */
	private onStartupLayoutChange = (): void => {
		if (this.startupOpened) return;
		const inMain = this.app.workspace.getLeavesOfType(VIEW_TYPE_PLANFLOW).some((l) => l.getRoot() === this.app.workspace.rootSplit);
		if (inMain) {
			this.startupOpened = true;
			return;
		}
		if (this.startupOpenTimer !== null) window.clearTimeout(this.startupOpenTimer);
		this.startupOpenTimer = window.setTimeout(() => {
			this.startupOpened = true;
			void this.activateView();
		}, 700);
	};

	onunload(): void {
		// 保留用户拖放位置：不在 onunload 中 detach leaves
	}

	/** Open the PlanBoard view in the main area (or reveal it if already open). */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		// v1.0.3: 已在主区域打开 → 直接聚焦，不销毁重建（保留固定状态与视图内状态）
		const existing = workspace
			.getLeavesOfType(VIEW_TYPE_PLANFLOW)
			.find((l) => l.getRoot() === workspace.rootSplit);
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}
		// 关闭旧位置（如右栏）的视图，确保在主区域打开
		workspace.detachLeavesOfType(VIEW_TYPE_PLANFLOW);
		const leaf = workspace.getLeaf("tab");
		if (!leaf) {
			new Notice("无法打开 PlanFlow 视图");
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_PLANFLOW, active: true });
		// v1.0.3: 固定标签页——作为首页常驻，打开其它文件不会顶掉它
		leaf.setPinned(true);
		await workspace.revealLeaf(leaf);
	}

	/** v1.0.3: 侧边栏图标移到左 ribbon 容器首位（Obsidian 无排序 API，操作 DOM 顺序）。 */
	private moveRibbonIconFirst(): void {
		const el = this.ribbonIconEl;
		const parent = el?.parentElement;
		if (parent && parent.firstElementChild !== el) {
			parent.prepend(el);
		}
	}

	/** Ask the open view to re-read files after settings changed. */
	refreshView(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PLANFLOW)) {
			if (leaf.view instanceof PlanBoardView) leaf.view.requestRefresh();
		}
	}

	/** v2.8.1: 设置页改了图标后，动态更新侧边栏 ribbon 图标（setIcon 原地替换 SVG）。 */
	applyRibbonIcon(): void {
		if (this.ribbonIconEl) setIcon(this.ribbonIconEl, this.settings.icon || "home");
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PlanFlowSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		this.settings.planColors = Object.assign({}, DEFAULT_PLAN_COLORS, this.settings.planColors);
		// v1.4 迁移：月/周列表旧默认 180px → 0（内容自适应，拖拽后才固定）
		if (this.settings.monthCardHeight === 180) this.settings.monthCardHeight = 0;
		if (this.settings.weekCardHeight === 180) this.settings.weekCardHeight = 0;
		// v1.6: planOrder 默认数组
		if (!Array.isArray(this.settings.planOrder)) this.settings.planOrder = [];
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
