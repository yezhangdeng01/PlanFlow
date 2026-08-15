import { Notice, Plugin } from "obsidian";
import { PlanFlowView, VIEW_TYPE_PLANFLOW } from "./src/PlanBoardView";
import type { PlanFlowSettings } from "./src/settings";
import { DEFAULT_SETTINGS, PlanFlowSettingTab } from "./src/settings";

export default class PlanFlowPlugin extends Plugin {
	settings: PlanFlowSettings;
	private view: PlanFlowView | null = null;
	private startupOpenTimer: number | null = null;
	private startupOpened = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_PLANBOARD, (leaf) => {
			this.view = new PlanBoardView(leaf, this);
			return this.view;
		});

		this.addCommand({
			id: "open-planboard",
			name: "打开计划总览",
			callback: () => void this.activateView(),
		});

		// 侧边栏图标（点击打开 PlanBoard，主区域）
		const ribbonIcon = this.addRibbonIcon("layout-dashboard", "PlanBoard 计划总览", () =>
			void this.activateView(),
		);
		ribbonIcon.addClass("planboard-ribbon");

		this.addSettingTab(new PlanBoardSettingTab(this.app, this));

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

	/** layout-change 防抖：恢复稳定后打开 PlanBoard（仅启动期一次）。 */
	private onStartupLayoutChange = (): void => {
		if (this.startupOpened) return;
		const inMain = this.app.workspace.getLeavesOfType(VIEW_TYPE_PLANBOARD).some((l) => l.getRoot() === this.app.workspace.rootSplit);
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
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PLANBOARD);
	}

	/** Open the PlanBoard view in the main area (or reveal it if already open). */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		// 关闭旧位置（如右栏）的视图，确保在主区域打开
		workspace.detachLeavesOfType(VIEW_TYPE_PLANBOARD);
		const leaf = workspace.getLeaf("tab");
		if (!leaf) {
			new Notice("无法打开 PlanBoard 视图");
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_PLANBOARD, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** Ask the open view to re-read files after settings changed. */
	refreshView(): void {
		this.view?.requestRefresh();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.dailyTemplates =
			Array.isArray(this.settings.dailyTemplates) && this.settings.dailyTemplates.length > 0
				? this.settings.dailyTemplates
				: DEFAULT_SETTINGS.dailyTemplates;
		this.settings.planColors = Object.assign({}, DEFAULT_SETTINGS.planColors, this.settings.planColors);
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
