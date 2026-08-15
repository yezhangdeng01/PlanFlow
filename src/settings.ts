import { App, PluginSettingTab, Setting } from "obsidian";
import type PlanFlowPlugin from "../main";

/** Default plan accent colors (PRD §5). Keys are plan tag names. */
export const DEFAULT_PLAN_COLORS: Record<string, string> = {
	写作: "#f59e0b",
	健康: "#10b981",
	学习: "#3b82f6",
	复盘: "#ef4444",
};

/** One row of the daily check-in template (PRD §6). */
export interface PlanTemplate {
	/** Display name, e.g. "✍️ 写作" (emoji included). */
	name: string;
	/** Duration text, e.g. "1小时". May be empty. */
	duration: string;
	/** Plan tag name (no `#计划/` prefix), e.g. "写作". */
	plan: string;
	/** Whether to append a review link `→ [[{date} 复盘]]`. */
	includeReview: boolean;
}

export interface PlanFlowSettings {
	/** Root folder for plan notes, relative to vault root (PRD §2.1). */
	rootPath: string;
	/** Daily check-in templates shown when creating a new daily note / adding an item. */
	dailyTemplates: PlanTemplate[];
	/** If true, the 复盘 check-in rate denominator uses workdays. */
	reviewWorkdays: boolean;
	/** Open the PlanFlow view automatically on startup. */
	openOnStartup: boolean;
	/** Sidebar icon name (Obsidian / lucide icon id). */
	icon: string;
	/** Plan accent colors, keyed by plan tag name. */
	planColors: Record<string, string>;
	/** Home month-task card list height (px, draggable resize). */
	monthCardHeight: number;
	/** Home week-task card list height (px, draggable resize). */
	weekCardHeight: number;
	/** Home check-in card height (px, 0 = auto). */
	checkCardHeight: number;
	/** Home summary card height (px, 0 = auto). */
	summaryCardHeight: number;
	/** Achievement pop sound on tier-up (v1.4). */
	achievementSound: boolean;
	/** 计划卡拖拽排序（v1.6）：计划名顺序，空数组 = 按年度文件定义顺序。 */
	planOrder: string[];
	/** 年度计划卡每卡高度（v1.7.2：拖拽下边缘调整，px）。 */
	yearPlanHeights: Record<string, number>;
	/** 看板列顺序（v1.7.3：拖拽列头调整，计划名数组；空 = 按年度定义顺序）。 */
	boardColumnOrder: string[];
}

export const DEFAULT_SETTINGS: PlanFlowSettings = {
	rootPath: "raw/计划",
	dailyTemplates: [
		{ name: "✍️ 写作", duration: "1小时", plan: "写作", includeReview: false },
		{ name: "🏃 健康", duration: "1小时", plan: "健康", includeReview: false },
		{ name: "📖 学习", duration: "1小时", plan: "学习", includeReview: false },
		{ name: "📈 复盘", duration: "", plan: "复盘", includeReview: true },
	],
	reviewWorkdays: true,
	openOnStartup: true,
	icon: "calendar",
	planColors: { ...DEFAULT_PLAN_COLORS },
	monthCardHeight: 0, // v1.4: 0 = 内容自适应（拖拽后固定）
	weekCardHeight: 0,
	checkCardHeight: 0,
	summaryCardHeight: 0,
	achievementSound: true,
	planOrder: [],
	yearPlanHeights: {},
	boardColumnOrder: [],
};

export class PlanFlowSettingTab extends PluginSettingTab {
	plugin: PlanFlowPlugin;

	constructor(app: App, plugin: PlanFlowPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "PlanBoard 设置" });

		new Setting(containerEl)
			.setName("计划根目录")
			.setDesc("笔记存放根路径（相对库根目录）")
			.addText((text) => {
				text.setPlaceholder("raw/计划").setValue(this.plugin.settings.rootPath);
				text.onChange(async (value) => {
					this.plugin.settings.rootPath = value.trim() || "raw/计划";
					await this.plugin.saveSettings();
					this.plugin.refreshView();
				});
			});

		containerEl.createEl("h3", { text: "每日打卡项模板" });
		containerEl.createDiv({
			cls: "planboard-setting-hint",
			text: "新建今日笔记 / 添加打卡项时使用的默认模板。",
		});
		this.renderTemplateList(containerEl);

		new Setting(containerEl)
			.setName("添加打卡项模板")
			.addButton((btn) =>
				btn.setButtonText("+ 添加").setCta().onClick(async () => {
					this.plugin.settings.dailyTemplates.push({
						name: "新打卡",
						duration: "1小时",
						plan: "写作",
						includeReview: false,
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("复盘按工作日统计")
			.setDesc("复盘打卡率分母使用工作日（周一至周五），否则与其它计划一致")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.reviewWorkdays);
				toggle.onChange(async (value) => {
					this.plugin.settings.reviewWorkdays = value;
					await this.plugin.saveSettings();
					this.plugin.refreshView();
				});
			});

		new Setting(containerEl)
			.setName("启动时打开 PlanBoard")
			.setDesc("Obsidian 启动后自动打开计划总览视图")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.openOnStartup);
				toggle.onChange(async (value) => {
					this.plugin.settings.openOnStartup = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("成就音效")
			.setDesc("达成新档位（金牌/银牌/铜牌）时播放提示音")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.achievementSound);
				toggle.onChange(async (value) => {
					this.plugin.settings.achievementSound = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("图标主题")
			.setDesc("侧边栏图标（Obsidian / Lucide 内置图标名）")
			.addText((text) => {
				text.setPlaceholder("calendar").setValue(this.plugin.settings.icon);
				text.onChange(async (value) => {
					this.plugin.settings.icon = value.trim() || "calendar";
					await this.plugin.saveSettings();
				});
			});
	}

	private renderTemplateList(containerEl: HTMLElement): void {
		const templates = this.plugin.settings.dailyTemplates;
		templates.forEach((tmpl: PlanTemplate, idx: number) => {
			const setting = new Setting(containerEl).setName(`#${idx + 1}`);
			setting.addText((text) => {
				text.setPlaceholder("名称").setValue(tmpl.name);
				text.onChange(async (value) => {
					tmpl.name = value;
					await this.plugin.saveSettings();
				});
			});
			setting.addText((text) => {
				text.setPlaceholder("时长").setValue(tmpl.duration);
				text.onChange(async (value) => {
					tmpl.duration = value;
					await this.plugin.saveSettings();
				});
			});
			setting.addDropdown((dropdown) => {
				const options = this.getPlanOptions();
				for (const plan of options) dropdown.addOption(plan, plan);
				dropdown.setValue(tmpl.plan);
				dropdown.onChange(async (value) => {
					tmpl.plan = value;
					await this.plugin.saveSettings();
				});
			});
			setting.addToggle((toggle) => {
				toggle.setValue(tmpl.includeReview);
				toggle.onChange(async (value) => {
					tmpl.includeReview = value;
					await this.plugin.saveSettings();
				});
			});
			setting.addExtraButton((btn) =>
				btn.setIcon("trash").setTooltip("删除模板").onClick(async () => {
					this.plugin.settings.dailyTemplates.splice(idx, 1);
					await this.plugin.saveSettings();
					this.display();
				})
			);
		});
	}

	private getPlanOptions(): string[] {
		const plans = new Set<string>(Object.keys(DEFAULT_PLAN_COLORS));
		for (const tmpl of this.plugin.settings.dailyTemplates) plans.add(tmpl.plan);
		return Array.from(plans);
	}
}
