import { AbstractInputSuggest, App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFile, TFolder, setIcon } from "obsidian";
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		;

		new Setting(containerEl)
			.setName("计划根目录")
			.setDesc("笔记存放根路径（相对库根目录）；输入时弹库内文件夹下拉，或点「浏览…」打开系统资源管理器")
			.addText((text) => {
				text.setPlaceholder("raw/计划").setValue(this.plugin.settings.rootPath);
				const applyRoot = (value: string): void => {
					this.plugin.settings.rootPath = value.trim() || "raw/计划";
					void this.plugin.saveSettings();
					this.plugin.refreshView();
				};
				// 输入即弹文件夹下拉（FolderSuggest），选中直接生效
				new FolderSuggest(this.app, text.inputEl, applyRoot);
				text.onChange(applyRoot);
			})
			.addButton((btn) =>
				btn.setButtonText("浏览…").setTooltip("弹出文件夹选择窗口").onClick(() => {
					const input = containerEl.querySelector<HTMLInputElement>(".setting-item-control input[type='text']");
					new FolderPickerModal(this.app, (path) => {
						if (input) input.value = path;
						// 触发与手输一致的保存流程
						input?.dispatchEvent(new Event("input", { bubbles: true }));
					}).open();
				})
			);

		// v2.7: 打卡模板管理已迁移到视图内（今日打卡卡「⚙ 模板」/ 年度计划页「⚙ 打卡模板」），
		// 模板是数据联动而非设置，不再在设置页维护。

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
			.setName("复盘笔记模板")
			.setDesc(`模板文件：${this.plugin.settings.rootPath.replace(/\/+$/, "")}/复盘模板.md —— 在 Obsidian 中直接编辑，{date} 会自动替换为当天日期`)
			.addButton((btn) =>
				btn.setButtonText("打开模板文件").setCta().onClick(async () => {
					const filePath = `${this.plugin.settings.rootPath.replace(/\/+$/, "")}/复盘模板.md`;
					let file: TFile | null = null;
					const existing = this.app.vault.getAbstractFileByPath(filePath);
					if (existing instanceof TFile) {
						file = existing;
					} else {
						file = (await this.app.vault.create(filePath, this.plugin.settings.reviewTemplate));
					}
					if (file) {
						const leaf = this.app.workspace.getLeaf(false);
						await leaf.openFile(file);
					}
				})
			)
			.addButton((btn) =>
				btn.setButtonText("恢复默认").onClick(async () => {
					const filePath = `${this.plugin.settings.rootPath.replace(/\/+$/, "")}/复盘模板.md`;
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						await this.app.vault.modify(file, this.plugin.settings.reviewTemplate);
						new Notice("已恢复默认模板");
					}
				})
			);

		new Setting(containerEl)
			.setName("启动时打开 PlanFlow")
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
			.setDesc("点击选择侧边栏 / 标签页图标，或输入任意 Obsidian / Lucide 图标名");
		this.renderIconPicker(containerEl);
	}

	/** v1.2: 视觉化图标选择器（常用 Lucide 图标格子 + 自定义输入兜底）。 */
	private renderIconPicker(containerEl: HTMLElement): void {
		const ICONS = [
			"home", "calendar", "target", "layout-dashboard", "list-checks",
			"book-open", "trending-up", "check-circle", "flame", "trophy",
			"rocket", "heart", "star", "clock", "zap", "layers", "workflow", "flag",
		];
		const wrap = containerEl.createDiv({ cls: "planflow-icon-picker" });
		for (const name of ICONS) {
			const btn = wrap.createEl("button", { cls: "planflow-icon-option", attr: { type: "button" } });
			setIcon(btn, name);
			btn.title = name;
			if (name === this.plugin.settings.icon) btn.addClass("is-selected");
			btn.addEventListener("click", () => {
				this.plugin.settings.icon = name;
				void this.plugin.saveSettings();
				this.display();
			});
		}
		const custom = wrap.createDiv({ cls: "planflow-icon-custom" });
		custom.createSpan({ text: "自定义：", cls: "planflow-icon-custom-label" });
		const input = custom.createEl("input", { attr: { type: "text", placeholder: "输入任意图标名…" } });
		input.value = ICONS.includes(this.plugin.settings.icon) ? "" : this.plugin.settings.icon;
		input.addEventListener("change", () => {
			this.plugin.settings.icon = input.value.trim() || "home";
			void this.plugin.saveSettings();
			this.display();
		});
	}
}
