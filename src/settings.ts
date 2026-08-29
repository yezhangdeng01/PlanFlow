import { AbstractInputSuggest, App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, SettingDefinitionItem, TFile, TFolder, setIcon } from "obsidian";
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
	/** If true, the 复盘 check-in rate denominator uses workdays. */
	reviewWorkdays: boolean;
	/** Review-note template (写复盘按钮生成); `{date}` is replaced with the current date. */
	reviewTemplate: string;
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
	reviewWorkdays: true,
	// v1.8: 通用复盘模板（用户可在设置页自定义，如自己的 A 股复盘格式）
	reviewTemplate: `---
type: review
date: {date}
tags: [复盘]
---
# 📝 复盘（{date}）

## 今日完成
- 

## 收获与亮点
- 

## 不足与改进
- 

## 明日计划
- 
`,
	openOnStartup: true,
	icon: "home",
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

/** 文件夹选择弹窗：列出库内全部文件夹，点选即回调路径（Obsidian 标准交互）。 */
class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	private onPick: (path: string) => void;
	constructor(app: App, onPick: (path: string) => void) {
		super(app);
		this.onPick = onPick;
		this.setPlaceholder("输入或选择库内文件夹…");
		this.setInstructions([{ command: "↑↓", purpose: "选择" }, { command: "↵", purpose: "确认" }, { command: "esc", purpose: "取消" }]);
	}
	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
	}
	getItemText(folder: TFolder): string {
		return folder.path === "/" ? "/（库根目录）" : folder.path;
	}
	onChooseItem(folder: TFolder): void {
		this.onPick(folder.path === "/" ? "" : folder.path);
	}
}

/** 文件夹建议器：输入时下拉选择库内文件夹（社区标准 FolderSuggest 模式）。 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private onChange: (path: string) => void;
	constructor(app: App, inputEl: HTMLInputElement, onChange: (path: string) => void) {
		super(app, inputEl);
		this.onChange = onChange;
	}
	getSuggestions(inputStr: string): TFolder[] {
		const lower = inputStr.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(lower));
	}
	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}
	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		this.onChange(folder.path);
		this.close();
	}
}

export class PlanFlowSettingTab extends PluginSettingTab {
	plugin: PlanFlowPlugin;

	constructor(app: App, plugin: PlanFlowPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// v2.8: 声明式设置（Obsidian 1.13+）——设置可搜索；display() 已移除（1.13 起 getSettingDefinitions 接管渲染）
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "计划根目录",
				desc: "笔记存放根路径（相对库根目录）；输入时弹库内文件夹下拉，或点「浏览…」选择",
				aliases: ["rootPath", "根目录", "路径"],
				render: (setting) => this.renderRootPath(setting),
			},
			{
				name: "复盘按工作日统计",
				desc: "复盘打卡率分母使用工作日（周一至周五），否则与其它计划一致",
				control: { type: "toggle", key: "reviewWorkdays" },
			},
			{
				name: "复盘笔记模板",
				desc: "在 Obsidian 中直接编辑，{date} 会自动替换为当天日期",
				aliases: ["reviewTemplate", "模板"],
				render: (setting) => this.renderReviewTemplate(setting),
			},
			{
				name: "启动时打开 PlanFlow",
				desc: "Obsidian 启动后自动打开计划总览视图",
				control: { type: "toggle", key: "openOnStartup" },
			},
			{
				name: "成就音效",
				desc: "达成新档位（金牌/银牌/铜牌）时播放提示音",
				control: { type: "toggle", key: "achievementSound" },
			},
			{
				name: "图标主题",
				desc: "点击选择侧边栏 / 标签页图标，或输入任意 Obsidian / Lucide 图标名",
				aliases: ["icon", "图标"],
				render: (setting) => this.renderIconPicker(setting),
			},
		];
	}

	/** 声明式绑定读值：从 settings 读取。 */
	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	/** 声明式绑定写值：写入 settings 并持久化、刷新视图。 */
	setControlValue(key: string, value: unknown): void {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		void this.plugin.saveSettings();
		this.plugin.refreshView();
	}

	/** 计划根目录：文本框（FolderSuggest 下拉）+ 浏览按钮（文件夹选择弹窗）。 */
	private renderRootPath(setting: Setting): void {
		setting.addText((text) => {
			text.setPlaceholder("raw/计划").setValue(this.plugin.settings.rootPath);
			const applyRoot = (value: string): void => {
				this.plugin.settings.rootPath = value.trim() || "raw/计划";
				void this.plugin.saveSettings();
				this.plugin.refreshView();
			};
			new FolderSuggest(this.app, text.inputEl, applyRoot);
			text.onChange(applyRoot);
		});
		setting.addButton((btn) =>
			btn.setButtonText("浏览…").setTooltip("弹出文件夹选择窗口").onClick(() => {
				const input = setting.controlEl.querySelector<HTMLInputElement>("input[type='text']");
				new FolderPickerModal(this.app, (path) => {
					if (input) input.value = path;
					input?.dispatchEvent(new Event("input", { bubbles: true }));
				}).open();
			})
		);
	}

	/** 复盘模板：打开模板文件 + 恢复默认。 */
	private renderReviewTemplate(setting: Setting): void {
		setting.addButton((btn) =>
			btn.setButtonText("打开模板文件").setCta().onClick(async () => {
				const filePath = `${this.plugin.settings.rootPath.replace(/\/+$/, "")}/复盘模板.md`;
				let file: TFile | null = null;
				const existing = this.app.vault.getAbstractFileByPath(filePath);
				if (existing instanceof TFile) {
					file = existing;
				} else {
					file = await this.app.vault.create(filePath, this.plugin.settings.reviewTemplate);
				}
				if (file) {
					const leaf = this.app.workspace.getLeaf(false);
					await leaf.openFile(file);
				}
			})
		);
		setting.addButton((btn) =>
			btn.setButtonText("恢复默认").onClick(async () => {
				const filePath = `${this.plugin.settings.rootPath.replace(/\/+$/, "")}/复盘模板.md`;
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file instanceof TFile) {
					await this.app.vault.modify(file, this.plugin.settings.reviewTemplate);
					new Notice("已恢复默认模板");
				}
			})
		);
	}

	/** 图标选择器：常用 Lucide 图标格子 + 自定义输入兜底（声明式 render 版）。 */
	private renderIconPicker(setting: Setting): void {
		const ICONS = [
			"home", "calendar", "target", "layout-dashboard", "list-checks",
			"book-open", "trending-up", "check-circle", "flame", "trophy",
			"rocket", "heart", "star", "clock", "zap", "layers", "workflow", "flag",
		];
		setting.settingEl.addClass("planflow-icon-setting");
		const wrap = setting.settingEl.createDiv({ cls: "planflow-icon-picker" });
		const syncSelection = (selected: string | null, customInput: HTMLInputElement): void => {
			wrap.querySelectorAll(".planflow-icon-option.is-selected").forEach((el) => el.removeClass("is-selected"));
			if (!selected) return;
			const target = Array.from(wrap.querySelectorAll<HTMLElement>(".planflow-icon-option")).find((b) => b.title === selected);
			if (target) target.addClass("is-selected");
			customInput.value = ICONS.includes(selected) ? "" : selected;
		};
		for (const name of ICONS) {
			const btn = wrap.createEl("button", { cls: "planflow-icon-option", attr: { type: "button" } });
			setIcon(btn, name);
			btn.title = name;
			if (name === this.plugin.settings.icon) btn.addClass("is-selected");
			btn.addEventListener("click", () => {
				this.plugin.settings.icon = name;
				void this.plugin.saveSettings();
				this.plugin.applyRibbonIcon(); // v2.8.1: 侧边栏图标即时跟随
				syncSelection(name, input);
			});
		}
		const custom = wrap.createDiv({ cls: "planflow-icon-custom" });
		custom.createSpan({ text: "自定义：", cls: "planflow-icon-custom-label" });
		const input = custom.createEl("input", { attr: { type: "text", placeholder: "输入任意图标名…" } });
		input.value = ICONS.includes(this.plugin.settings.icon) ? "" : this.plugin.settings.icon;
		input.addEventListener("change", () => {
			this.plugin.settings.icon = input.value.trim() || "home";
			void this.plugin.saveSettings();
			this.plugin.applyRibbonIcon(); // v2.8.1: 侧边栏图标即时跟随
			syncSelection(this.plugin.settings.icon, input);
		});
	}
}
