import { ButtonComponent, Modal, Notice, Plugin, TFile, TFolder } from "obsidian";
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
			["🎯", "新建计划", "打开年度视图 →「＋ 新增计划」，先建写作 / 健康 / 学习 / 复盘等分类"],
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

	async onload(): Promise<void> {
		await this.loadSettings();

		// 首次启动：确保计划目录骨架存在（新用户零报错，不用手动建文件夹）。
		// 必须在 layout-ready 后执行——onload 时 vault 可能尚未扫描完，
		// getAbstractFileByPath 对已有目录会误返回 null → 误判全新安装 → createFolder 撞已存在目录 → 插件崩溃。
		this.app.workspace.onLayoutReady(() => {
			void this.ensurePlanRootSafe();
		});

		this.registerView(VIEW_TYPE_PLANFLOW, (leaf) => {
			return new PlanBoardView(leaf, this);
		});

		this.addCommand({
			id: "open-planboard",
			name: "打开计划总览",
			callback: () => void this.activateView(),
		});

		// 侧边栏图标（点击打开 PlanFlow，主区域）
		const ribbonIcon = this.addRibbonIcon("home", "PlanFlow 计划总览", () =>
			void this.activateView(),
		);
		ribbonIcon.addClass("planboard-ribbon");

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
	 */
	private async ensurePlanRoot(): Promise<boolean> {
		const year = String(new Date().getFullYear());
		const root = this.settings.rootPath.replace(/\/+$/, "");
		const base = `${root}/${year}`;
		const yearFolder = this.app.vault.getAbstractFileByPath(base);
		if (yearFolder instanceof TFolder) {
			// 已有年度目录（老用户）：只补建年度计划.md
			const planFile = this.app.vault.getAbstractFileByPath(`${base}/年度计划.md`);
			if (!(planFile instanceof TFile)) {
				await this.app.vault.create(`${base}/年度计划.md`, this.buildYearPlanTemplate(year));
			}
			return false;
		}
		// 全新：逐级创建目录 + 骨架文件
		await this.ensureFolder(root);
		await this.ensureFolder(`${base}/每日`);
		await this.ensureFolder(`${base}/周`);
		await this.ensureFolder(`${base}/月`);
		await this.app.vault.create(`${base}/年度计划.md`, this.buildYearPlanTemplate(year));
		if (!this.app.vault.getAbstractFileByPath(`${base}/任务.md`)) {
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

	/** 新用户年度计划.md 骨架：4 个默认计划（与默认打卡模板对齐）。 */
	private buildYearPlanTemplate(year: string): string {
		const end = `${year}-12-31`;
		return `---
type: yearly
period: ${year}
start: ${year}-01-01
end: ${end}
plans:
  写作:
    label: ✍️
    action: 1小时
    daily: true
    target: 每日写作
  健康:
    label: 🏃
    action: 1小时
    daily: true
    target: 每日运动
  学习:
    label: 📖
    action: 1小时
    daily: true
    target: 每日学习
  复盘:
    label: 📈
    action: 复盘+次日计划
    daily: true
    target: 每日复盘
---
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
		// 关闭旧位置（如右栏）的视图，确保在主区域打开
		workspace.detachLeavesOfType(VIEW_TYPE_PLANFLOW);
		const leaf = workspace.getLeaf("tab");
		if (!leaf) {
			new Notice("无法打开 PlanFlow 视图");
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_PLANFLOW, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** Ask the open view to re-read files after settings changed. */
	refreshView(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PLANFLOW)) {
			if (leaf.view instanceof PlanBoardView) leaf.view.requestRefresh();
		}
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
