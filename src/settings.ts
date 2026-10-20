import { AbstractInputSuggest, App, DropdownComponent, FuzzySuggestModal, Modal, Notice, PluginSettingTab, Setting, SettingDefinitionItem, TFile, TFolder, setIcon } from "obsidian";
import type PlanFlowPlugin from "../main";
import { reviewTemplatePath } from "./paths";
import { addScheme, applyScheme, normalizeHex, PRESET_DEFAULTS, removeScheme, replaceScheme, resolveSkinSelection, schemeNameTaken } from "./skin-engine";
import type { CustomSkinOverride, CustomSkinScheme } from "./skin-engine";

/**
 * 预置计划配色（PRD §5）。键为计划标签名。
 *
 * ⚠️ 这里**刻意留空**——早期版本预置过「写作/健康/学习/复盘」四项，那是插件作者
 * 个人库里的计划名，不该随插件分发到每个用户 vault。留着等于给所有新用户凭空
 * 造出四个他不存在的计划，还会在计划下拉里多出四个候选。
 *
 * 配色改由`rotatePlanColor()` 按序发散生成（见 colors.ts），用户自建计划时
 * 自动取色；已建计划想改色走设置页。所以这里保持空表即可。
 */
export const DEFAULT_PLAN_COLORS: Record<string, string> = {};

/**
 * One row of the daily check-in template (PRD §6).
 * v7.6：`duration`（原「1小时」动作后缀）已退役——打卡记的是当天行动内容 + 用时，
 * 由行内输入框当场填，不再由计划定义预写进标题。
 */
export interface PlanTemplate {
	/** Display name, e.g. "✍️ 写作" (emoji included). */
	name: string;
	/** Plan tag name (no `#计划/` prefix), e.g. "写作". */
	plan: string;
	/** Whether to append a review link `→ [[{date} 复盘]]`. */
	includeReview: boolean;
	/** v7.21: 打卡项窗口 🛫（缺省 = 当天，原行为）——量化到每日打卡的自定义项带窗口。 */
	start?: string;
	/** v7.21: 打卡项窗口 📅（缺省 = 当天）。 */
	due?: string;
}

export interface PlanFlowSettings {
	/** Root folder for plan notes, relative to vault root (PRD §2.1). */
	rootPath: string;
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
	/** Home month-bars chart card height (px, 0 = auto, v3.8 draggable). */
	weekChartHeight: number;
	/** Home trend chart card height (px, 0 = auto, v3.8 draggable). */
	trendChartHeight: number;
	/** Home heatmap card height (px, 0 = auto, v3.8 draggable). */
	heatCardHeight: number;
	/** Achievement pop sound on tier-up (v1.4). */
	achievementSound: boolean;
	/** 计划卡拖拽排序（v1.6）：计划名顺序，空数组 = 按年度文件定义顺序。 */
	planOrder: string[];
	/** 年度计划卡每卡高度（v1.7.2：拖拽下边缘调整，px）。 */
	yearPlanHeights: Record<string, number>;
	/** 看板列顺序（v1.7.3：拖拽列头调整，计划名数组；空 = 按年度定义顺序）。 */
	boardColumnOrder: string[];
	/** 用户手动删除的自动分解任务名（v1.0.4）——防止 ensureAutoTasks 补额时"复活"被删任务。编辑/删除对应量化目标时清空相关条目。 */
	deletedAutoTasks: string[];
	/**
	 * 打卡「用时」的默认档（分钟，v7.9）。
	 *
	 * 语义是**记忆**而不是偏好：用户每次打卡填的那个值会回写到这里，
	 * 下次打开/刷新时输入框就停在这个值上——「选了 30 分，以后打卡默认就是 30，
	 * 除非再手动改」。首次安装没有这个字段时走 DEFAULT_SETTINGS 的 30。
	 */
	checkMinutes: number;
	/**
	 * 皮肤主题（v8.0）：sky=晴空（默认）/ paper=素笺 / midnight=夜阑 / pine=松风。
	 * 每款各自带浅色+深色两态，跟随 Obsidian 的 light/dark 主题自动切换；
	 * 计划色（planColors，用户自定）不受皮肤影响。
	 */
	skin: PlanFlowSkin;
	/**
	 * 自定义皮肤微调（v8.1）：非 null 时在当前 skin 预设基础上覆盖
	 * 主色（顶栏 banner 家族）与墨色（文字家族），其余令牌（画布膜 / 开口色 /
	 * 业务强调色）保持预设不动。null = 纯预设。「恢复预设值」即清回 null。
	 */
	customSkin: CustomSkinOverride | null;
	/**
	 * 命名方案仓库（v8.2）：「保存为方案」把 基底+主色+墨色 定格存库，
	 * 随时应用/删除。与 customSkin 的分工：customSkin = 当前生效值，这里是仓库。
	 */
	skinSchemes: CustomSkinScheme[];
	/**
	 * v8.10 「皮肤主题」下拉上次选中/正在编辑的方案名（null = 未选方案）。
	 * 只影响回显，不参与派色：改色后外观已不等于方案快照，但下拉不该跳回预设
	 * （用户正在「青空」上微调，名字就该还写着「青空」）。
	 * 选预设 / 恢复预设值 / 删除方案时清空。
	 */
	skinScheme: string | null;
	/**
	 * v8.4 banner 贴图：库内图片的 vault 相对路径（选图弹窗产生）。
	 * 独立于 customSkin（贴图是全局开关，不进派生引擎、不进方案定格）。
	 * 文件被移动/删除时视图侧按「无贴图」回落（inline 不写）。
	 */
	bannerImage: string | null;
	/** v8.4 贴图不透明度 0.1~0.7（默认 0.35；太透看不见、太实盖住文字）。 */
	bannerImgOpacity: number;
	/** v8.4c 最近用过的贴图（下拉快捷切换），最多 8 条。 */
	bannerRecent: string[];
	/** v1.3.1 历史最高连续打卡记录（天）；-1 = 尚未回填（老用户升级后首次打开时全量扫一次）。 */
	maxStreak: number;
	/** v8.4e 浏览弹窗记忆：上次浏览的文件夹（null = 根目录），下次打开默认定位到它。 */
	bannerBrowseDir: string | null;
}

/** v8.0 皮肤标识（与 styles.css 的 data-skin 值一一对应）。 */
export type PlanFlowSkin = "sky" | "paper" | "midnight" | "pine";

export const DEFAULT_SETTINGS: PlanFlowSettings = {
	rootPath: "raw/计划",
	// v1.1.6：通用复盘模板（用户在设置页直接编辑 `{rootPath}/复盘模板.md`，
	// 内容完全自定——插件不预置任何领域模板，原先注释里「如自己的 A 股复盘格式」
	// 那类示例已删，免得把作者个人的交易习惯当成通用默认）
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
	weekChartHeight: 0, // v3.8: 0 = 自适应（拖拽后固定）
	trendChartHeight: 0,
	heatCardHeight: 0,
	achievementSound: true,
	planOrder: [],
	yearPlanHeights: {},
	boardColumnOrder: [],
	deletedAutoTasks: [],
	checkMinutes: 30,
	skin: "sky",
	customSkin: null,
	skinSchemes: [],
	skinScheme: null,
	bannerImage: null,
	bannerImgOpacity: 0.35,
	bannerRecent: [],
	maxStreak: -1,
	bannerBrowseDir: null,
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
		{
			// v8.2：desc 长文本撤了（用户「太占位置」）——四款预设名 + 自定义说明
			// 全部收进面板内的小标题与占位提示，aliases 保留保搜索可达性
			name: "皮肤主题",
			aliases: ["skin", "皮肤", "皮肤色", "主题", "配色", "颜色", "自定义", "方案"],
			render: (setting) => this.renderSkinPicker(setting),
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
				const filePath = reviewTemplatePath(this.plugin.settings.rootPath);
				let file: TFile | null = null;
				const existing = this.app.vault.getAbstractFileByPath(filePath);
				if (existing instanceof TFile) {
					file = existing;
				} else if (existing instanceof TFolder) {
					// 路径被同名文件夹占用（旧版 bug 残留）→ 不 create，避免未捕获异常
					new Notice(`「${filePath}」被同名文件夹占用，请先删除该文件夹`);
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
				const filePath = reviewTemplatePath(this.plugin.settings.rootPath);
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file instanceof TFile) {
					await this.app.vault.modify(file, this.plugin.settings.reviewTemplate);
					new Notice("已恢复默认模板");
				}
			})
		);
	}

	/**
	 * v8.3 皮肤选择器：主行下拉 = 四预设 + 已存方案（选中即应用）；
	 * 下方**全宽自绘**微调面板（挂在 Setting 行之后，避开两栏布局挤压）：
	 * 主色/墨色行（hex 框 + 色盘 + 行内「复原」），标题行右侧
	 * 「保存为方案」（弹 Modal 命名）+「恢复预设值」。
	 * 自定义只覆盖主色与墨色；画布膜/开口色不单独开放——v8.17 起它们随主色由
	 * deriveTokens 现算（tintAccent），业务强调色仍保持预设（skin-engine 铁律①）。
	 */
	private renderSkinPicker(setting: Setting): void {
		const SKINS: Array<{ id: PlanFlowSkin; name: string }> = [
			{ id: "sky", name: "晴空（天蓝）" },
			{ id: "paper", name: "素笺（暖纸褐）" },
			{ id: "midnight", name: "夜阑（深夜靛）" },
			{ id: "pine", name: "松风（墨绿）" },
		];
		// 输入框引用：切基底预设 / 应用方案时刷新显示值（v8.4d 起只有色盘）
		const inputs: Partial<Record<"accent" | "ink", { color: HTMLInputElement }>> = {};
		const currentOverride = (): CustomSkinOverride =>
			this.plugin.settings.customSkin ?? PRESET_DEFAULTS[this.plugin.settings.skin] ?? PRESET_DEFAULTS.sky;
		const syncInputs = (): void => {
			const cur = currentOverride();
			for (const f of ["accent", "ink"] as const) {
				const pair = inputs[f];
				if (pair) {
					pair.color.value = cur[f];
				}
			}
		};
		const SCHEME_PREFIX = "scheme:";
		const schemeValue = (name: string): string => SCHEME_PREFIX + name;
		/**
		 * 当前外观是否**精确**等于某个方案（base + 主色 + 墨色全等，不掺记忆）。
		 * 只用于 v8.10 的老数据自愈：升级上来的用户有 customSkin 却没有 skinScheme 名字。
		 */
		const exactScheme = (): CustomSkinScheme | null => {
			const c = this.plugin.settings.customSkin;
			if (!c) return null;
			return (
				this.plugin.settings.skinSchemes.find(
					(s) => s.base === this.plugin.settings.skin && s.accent === c.accent && s.ink === c.ink,
				) ?? null
			);
		};
		/**
		 * 下拉当前显示的那个方案（v8.10）。
		 * 判定交给 resolveSkinSelection：精确命中优先，其次「上次选中/正在编辑」的记忆。
		 * 回显与垃圾桶共用它——下拉写谁的名字，垃圾桶就删谁，不会出现「显示方案却删不掉」。
		 */
		const activeScheme = (): CustomSkinScheme | null => {
			const sel = resolveSkinSelection(
				this.plugin.settings.skinSchemes,
				{ skin: this.plugin.settings.skin, customSkin: this.plugin.settings.customSkin },
				this.plugin.settings.skinScheme,
			);
			if (sel.kind !== "scheme") return null;
			return this.plugin.settings.skinSchemes.find((s) => s.name === sel.name) ?? null;
		};		let skinDropdown: DropdownComponent | null = null;
		let delBtnEl: HTMLElement | null = null;
		const updateDelBtn = (): void => {
			// class 切换而非 style.display（市场 lint 禁内联样式赋值）
			if (delBtnEl) delBtnEl.classList.toggle("planflow-hidden", !activeScheme());
		};
		const rebuildOptions = (): void => {
			const dd = skinDropdown;
			if (!dd) return;
			dd.selectEl.empty();
			for (const s of SKINS) dd.addOption(s.id, s.name);
			for (const sch of this.plugin.settings.skinSchemes) dd.addOption(schemeValue(sch.name), sch.name);
		};
		const syncDropdown = (): void => {
			// v8.10 自愈：外观恰好等于某方案、但没记住名字（从 <8.10 升级上来，
			// data.json 里没有 skinScheme 字段）→ 补记一次。否则用户下一次改色时
			// resolveSkinSelection 拿不到记忆，下拉又会跳回预设名（正是本次报的 bug）。
			const exact = exactScheme();
			if (exact && this.plugin.settings.skinScheme !== exact.name) {
				this.plugin.settings.skinScheme = exact.name;
				void this.plugin.saveSettings();
			}
			// 外观精确命中方案 → 显示该方案；改过色（不再命中）但记忆里的方案仍在
			// → 仍显示它（别跳回预设，用户会以为方案丢了）；否则回落基底预设。
			const sch = activeScheme();
			// setValue 不触发 onChange，只是回显
			skinDropdown?.setValue(sch ? schemeValue(sch.name) : this.plugin.settings.skin);
			updateDelBtn();
		};
		/** 应用某个方案：写设置 + 换肤 + 面板同步（下拉回显交给调用方）。 */
		const applySchemeToSettings = (sch: CustomSkinScheme): void => {
			const { skin, customSkin } = applyScheme(sch);
			this.plugin.settings.skin = skin;
			this.plugin.settings.customSkin = customSkin;
			// v8.10：记住正在编辑的方案，改色后下拉仍显示它
			this.plugin.settings.skinScheme = sch.name;
			void this.plugin.saveSettings();
			this.plugin.applySkinToViews();
			syncInputs();
		};

		setting.addDropdown((dd) => {
			skinDropdown = dd;
			rebuildOptions();
			// v8.10：初始化必须走 syncDropdown 而不是裸 setValue(settings.skin)——
			// 否则重开设置页时下拉永远显示基底预设（用户「设为青空后重开仍显示晴空天蓝」）。
			syncDropdown();
			dd.onChange((value) => {
				if (value.startsWith(SCHEME_PREFIX)) {
					// 选中某个已存方案 → 整套应用（基底 + 微调一起切）
					const sch = this.plugin.settings.skinSchemes.find((x) => schemeValue(x.name) === value);
					if (sch) applySchemeToSettings(sch);
					updateDelBtn();
					return;
				}
				// 下拉值来自固定四项，仍做一次白名单校验，脏数据回落 sky
				this.plugin.settings.skin = (SKINS.some((s) => s.id === value) ? value : "sky") as PlanFlowSkin;
				// v8.6.2：选预设 = 整套应用该预设的默认外观，必须清掉残留 customSkin——
				// 否则 deriveTokens 拿旧自定义色压 inline 变量，banner/开口/页面焊死在
				// 自定义色上、切预设无反应（用户实测 bug）。想跨预设保留微调用「保存为方案」。
				this.plugin.settings.customSkin = null;
				// v8.10：选预设 = 离开方案编辑状态，清掉回显记忆
				this.plugin.settings.skinScheme = null;
				void this.plugin.saveSettings();
				// 只改根元素 data-skin 属性即整站换肤，不必重开视图（CSS 变量即时生效）
				this.plugin.applySkinToViews();
				syncInputs(); // 面板回显新基底的默认色（customSkin 已清，显示预设值）
				updateDelBtn();
			});
		});
		// 下拉框旁的垃圾桶：仅当前生效外观恰好是某方案时可见（删除仓库条目，不动外观）
		setting.addExtraButton((btn) => {
			btn.setIcon("trash-2").setTooltip("删除当前选中的方案（不影响当前外观）");
			delBtnEl = btn.extraSettingsEl;
			delBtnEl.addClass("planflow-scheme-del-btn"); // 1.14.4 的内置类不可依赖，加自有类给脚本/样式定位
			// v1.3.1 iPad 修复：同图标选择器——svg 挪进 span，父级不再是 button（WebKit 不渲染 svg-in-button）
			const delSvg = delBtnEl.querySelector("svg");
			if (delSvg) delBtnEl.createSpan({ cls: "planflow-btn-icon" }).appendChild(delSvg);
			delBtnEl.addEventListener("click", () => {
				const m = activeScheme();
				if (!m) return;
				this.plugin.settings.skinSchemes = removeScheme(this.plugin.settings.skinSchemes, m.name);
				// v8.10：删的就是当前显示的那个方案，回显记忆一并清掉（否则会指着一个不存在的名字）
				this.plugin.settings.skinScheme = null;
				void this.plugin.saveSettings();
				rebuildOptions();
				syncDropdown(); // 仓库条目已删，按实际外观回显（通常回落基底预设）
				new Notice(`已删除方案「${m.name}」`);
			});
			updateDelBtn();
		});
		// ---- 自定义微调面板（挂 Setting 行**内部**、CSS 撑满整行） ----
		// ⚠️ 不能挂 settingEl 的兄弟节点：1.14.4 页面栈只挂载 .setting-item 本身，
		//     兄弟节点会被整个丢掉（v8.3 首版踩坑，面板凭空消失）。
		const wrap = setting.settingEl.createDiv({ cls: "planflow-skin-custom" });
		const head = wrap.createDiv({ cls: "planflow-skin-head" });
		head.createDiv({ cls: "planflow-skin-custom-title", text: "自定义微调（在当前预设基础上）" });
		const saveBtn = head.createEl("button", {
			cls: "planflow-skin-save",
			text: "保存",
			attr: {
				type: "button",
				title: "把当前皮肤色/墨色写回正在编辑的方案；还没有方案时（纯预设基础）会引导你另存为",
			},
		});
		const saveAsBtn = head.createEl("button", {
			cls: "planflow-skin-saveas",
			text: "另存为",
			attr: { type: "button", title: "把当前 基底预设 + 皮肤色 + 墨色 存成一个新方案（进「皮肤主题」下拉框）" },
		});
		/** 另存为：弹命名框 → 进仓库并选中它。 */
		const openSaveAs = (): void => {
			new SchemeNameModal(this.app, (name) => {
				if (schemeNameTaken(this.plugin.settings.skinSchemes, name)) {
					const cur = activeScheme();
					// 撞上正在编辑的那个方案 → 提示走「保存」；撞别的 → 换个名字
					return cur && cur.name === name
						? `「${name}」正在使用中，直接点「保存」即可覆盖`
						: `方案「${name}」已存在，换个名字`;
				}
				const c = currentOverride();
				this.plugin.settings.skinSchemes = addScheme(this.plugin.settings.skinSchemes, {
					name,
					base: this.plugin.settings.skin,
					accent: c.accent,
					ink: c.ink,
				});
				this.plugin.settings.skinScheme = name;
				void this.plugin.saveSettings();
				rebuildOptions();
				syncDropdown();
				new Notice(`已保存方案「${name}」`);
				return null;
			}).open();
		};
		// v8.11（用户 20261020）：「保存为方案 / 恢复预设值」→「保存 / 另存为」，撤掉恢复预设值。
		// 语义：预设本身不可改，在预设上微调只能另存为；已有方案时「保存」= 覆盖该方案。
		saveBtn.addEventListener("click", () => {
			const active = activeScheme();
			if (!active) {
				// 纯预设基础：没有可覆盖的对象，引导另存为（预设值永不写坏）
				new Notice("预设皮肤不可修改，已打开「另存为」");
				openSaveAs();
				return;
			}
			const c = currentOverride();
			this.plugin.settings.skinSchemes = replaceScheme(this.plugin.settings.skinSchemes, {
				name: active.name,
				base: active.base,
				accent: c.accent,
				ink: c.ink,
			});
			this.plugin.settings.skinScheme = active.name;
			void this.plugin.saveSettings();
			rebuildOptions();
			syncDropdown();
			new Notice(`已更新方案「${active.name}」`);
		});
		saveAsBtn.addEventListener("click", () => openSaveAs());
		/** 改某个色：写 customSkin → 保存 → 即时生效 → 同步面板。 */
		const applyField = (field: "accent" | "ink", raw: string): void => {
			const hex = normalizeHex(raw);
			if (!hex) {
				new Notice("颜色格式应为 #rrggbb（如 #b2d2ea），已忽略本次输入");
				syncInputs();
				return;
			}
			this.plugin.settings.customSkin = { ...currentOverride(), [field]: hex };
			void this.plugin.saveSettings();
			this.plugin.applySkinToViews();
			syncInputs();
			syncDropdown(); // 微调后可能恰好命中/脱离某个方案，下拉与垃圾桶跟着走
		};
		const rows: Array<{ field: "accent" | "ink"; label: string; title: string }> = [
			{ field: "accent", label: "皮肤色", title: "插件自己的主题色（区别于 Obsidian 主题色）：顶栏 banner 与开口、页面画布的基调（深色模式下以低透明度叠加）" },
			{ field: "ink", label: "墨色", title: "标签与周期文字的颜色" },
		];
		// v8.4e：主色/墨色并排一行（用户「能放一行吗，不能放两行也行」——三行并一行右栏太挤，
		// 两行刚好：色对一行、贴图一行），pair 内两个色行各占一半。
		const pair = wrap.createDiv({ cls: "planflow-skin-pair" });
		for (const { field, label, title } of rows) {
			const row = pair.createDiv({ cls: "planflow-skin-row" });
			row.createSpan({ cls: "planflow-skin-row-label", text: label, attr: { title } });
			const cur = currentOverride();
			// v8.4d：hex 文本框删除（用户「显示的是代码，不如直接显示色彩」）——
			// 原生色盘拉宽到 hex 位：直接显示颜色，点击弹系统色盘（自带 hex 精确输入，能力不丢）
			const color = row.createEl("input", { attr: { type: "color", title } });
			color.value = cur[field];
			color.addEventListener("input", () => applyField(field, color.value));
			// 行内复原：只回这一行的预设默认值（customSkin 为 null 时即无操作）
			const rowReset = row.createEl("button", { cls: "planflow-skin-row-reset", text: "复原", attr: { type: "button", title: `恢复${label}的预设值` } });
			rowReset.addEventListener("click", () => {
				const preset = PRESET_DEFAULTS[this.plugin.settings.skin] ?? PRESET_DEFAULTS.sky;
				this.plugin.settings.customSkin = { ...currentOverride(), [field]: preset[field] };
				void this.plugin.saveSettings();
				this.plugin.applySkinToViews();
				syncInputs();
				syncDropdown();
			});
			inputs[field] = { color };
		}
		// ---- banner 贴图行（v8.4 二期；v8.4c/d 用户反馈重排） ----
		// 与色行完全同构：label(3em) + 控件(--pf-skin-hex-w) + 按钮(=「复原」列)。
		// 「浏览」2 字与「复原」同宽 → 右缘齐；下拉 = 最近贴图（最多 8 条）快捷切换。
		const imgRow = wrap.createDiv({ cls: "planflow-skin-row planflow-skin-img-row" });
		imgRow.createSpan({
			cls: "planflow-skin-row-label",
			text: "贴图",
			attr: { title: "顶栏 banner 背景图片（库内文件，文件夹浏览选取）；半透明叠在渐变上，深色模式同样生效" },
		});
		const imgSelect = imgRow.createEl("select", { cls: "dropdown planflow-skin-img-select", attr: { title: "最近用过的贴图，可直接切换" } });
		const pickBtn = imgRow.createEl("button", { cls: "planflow-skin-img-pick", text: "浏览", attr: { type: "button", title: "按文件夹浏览库内图片（png/jpg/webp/gif/svg…）" } });
		const imgClear = imgRow.createEl("button", { cls: "planflow-skin-img-clear planflow-hidden", text: "清除", attr: { type: "button", title: "移除贴图，回到纯渐变" } });
		// 不透明度滑杆行：仅贴图生效时显示
		const opRow = wrap.createDiv({ cls: "planflow-skin-row planflow-skin-op-row planflow-hidden" });
		opRow.createSpan({ cls: "planflow-skin-row-label", text: "浓度", attr: { title: "贴图不透明度：太透看不见、太实盖住文字" } });
		const opInput = opRow.createEl("input", { attr: { type: "range", min: "10", max: "70", step: "5", title: "贴图不透明度 10%~70%" } });
		const opVal = opRow.createSpan({ cls: "planflow-skin-op-val" });
		const clampOp = (v: number): number => Math.min(0.7, Math.max(0.1, Number.isFinite(v) ? v : 0.35));
		/** 最近贴图仓库：新图置顶去重，最多 8 条（main.ts loadSettings 同步净化）。 */
		const pushRecent = (path: string): void => {
			this.plugin.settings.bannerRecent = [path, ...this.plugin.settings.bannerRecent.filter((p) => p !== path)].slice(0, 8);
		};
		const syncImg = (): void => {
			const p = this.plugin.settings.bannerImage;
			// 下拉选项 = 「未设置」 + 当前贴图 + 最近仓库（去重），当前值选中
			const recent = this.plugin.settings.bannerRecent;
			const items = [...new Set([...(p ? [p] : []), ...recent])];
			imgSelect.empty();
			imgSelect.createEl("option", { value: "", text: "未设置" });
			for (const path of items) imgSelect.createEl("option", { value: path, text: path });
			imgSelect.value = p ?? "";
			imgClear.classList.toggle("planflow-hidden", !p);
			opRow.classList.toggle("planflow-hidden", !p);
			if (p) {
				const op = clampOp(this.plugin.settings.bannerImgOpacity);
				opInput.value = String(Math.round(op * 100));
				opVal.setText(`${Math.round(op * 100)}%`);
			}
		};
		imgSelect.addEventListener("change", () => {
			const v = imgSelect.value;
			this.plugin.settings.bannerImage = v || null;
			if (v) pushRecent(v);
			void this.plugin.saveSettings();
			this.plugin.applySkinToViews();
			syncImg();
		});
		pickBtn.addEventListener("click", () => {
			new BannerImageModal(this.app, this.plugin, (file) => {
				this.plugin.settings.bannerImage = file.path;
				pushRecent(file.path);
				void this.plugin.saveSettings();
				this.plugin.applySkinToViews();
				syncImg();
				new Notice(`已设置 banner 贴图：${file.path}`);
			}).open();
		});
		imgClear.addEventListener("click", () => {
			this.plugin.settings.bannerImage = null;
			void this.plugin.saveSettings();
			this.plugin.applySkinToViews();
			syncImg();
			new Notice("已清除 banner 贴图");
		});
		opInput.addEventListener("change", () => {
			this.plugin.settings.bannerImgOpacity = clampOp(Number(opInput.value) / 100);
			void this.plugin.saveSettings();
			this.plugin.applySkinToViews();
			opVal.setText(`${opInput.value}%`);
		});
		syncImg();
	}

	/** 图标选择器：常用 Lucide 图标格子 + 自定义输入兜底（声明式 render 版）。 */
	private renderIconPicker(setting: Setting): void {
		const ICONS = [
			"home", "calendar", "target", "layout-dashboard", "list-checks",
			"book-open", "trending-up", "check-circle", "flame", "trophy",
			"rocket", "heart", "star", "clock", "zap", "layers", "workflow", "flag",
		];
		// v1.3.1: 触屏设备的图标兜底层——用户 iPad 上选择器 18 个 svg 全空框
		//（深浅色/选中态都空；同页垃圾桶 svg 正常 ⇒ 非全局 svg 失效，根因远程无法定位）。
		// 方案：按钮里同时渲染 svg 与 emoji 两层，CSS 触屏媒体查询二选一——
		// 桌面显示 lucide 图标（与现状逐像素一致），iPad 显示 emoji（可用性兜底，不赌 svg 根因）。
		const ICON_EMOJI: Record<string, string> = {
			home: "🏠", calendar: "📅", target: "🎯", "layout-dashboard": "📊", "list-checks": "☑️",
			"book-open": "📖", "trending-up": "📈", "check-circle": "✅", flame: "🔥", trophy: "🏆",
			rocket: "🚀", heart: "❤️", star: "⭐", clock: "🕐", zap: "⚡", layers: "🗂️",
			workflow: "🔀", flag: "🚩",
		};
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
			// v1.3.1 iPad 修复：svg 直接挂在 <button> 下 WebKit 不渲染（iPad 全系浏览器都是 WebKit 内核；
			// v1.2.2 顶栏触屏按钮同病，而卡片/弹窗里挂 div/span 一直正常）——包一层 span 让 svg 的父级不是 button
			setIcon(btn.createSpan({ cls: "planflow-btn-icon" }), name);
			// v1.3.1 触屏 emoji 兜底层（桌面 display:none，媒体查询二选一，见 styles.css v1.3.1 节）
			btn.createSpan({ cls: "planflow-icon-emoji", text: ICON_EMOJI[name] ?? "📦" });
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

/**
 * v8.4 banner 贴图选图弹窗（v8.4b 改文件夹浏览）：逐层进入文件夹、
 * 点图片即选中。用户反馈「没有浏览文件夹按钮」——全库模糊搜索不够直观。
 */
class BannerImageModal extends Modal {
	private static readonly IMG_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif"];
	private dir: TFolder;

	constructor(app: App, private plugin: PlanFlowPlugin, private pick: (file: TFile) => void) {
		super(app);
		// v8.4e：恢复上次浏览的文件夹（文件夹已删除/移动则回落根目录）
		const saved = plugin.settings.bannerBrowseDir;
		const restored = saved ? app.vault.getAbstractFileByPath(saved) : null;
		this.dir = restored instanceof TFolder ? restored : app.vault.getRoot();
	}

	/** v8.4e：导航时记忆当前文件夹（根目录记 null）；设置随写随存。 */
	private remember(): void {
		this.plugin.settings.bannerBrowseDir = this.dir === this.app.vault.getRoot() ? null : this.dir.path;
		void this.plugin.saveSettings();
	}

	onOpen(): void {
		this.titleEl.setText("选择 banner 贴图");
		this.modalEl.addClass("planflow-img-browse-modal");
		this.renderList();
	}

	private renderList(): void {
		this.contentEl.empty();
		const root = this.app.vault.getRoot();
		const isRoot = this.dir === root;
		this.contentEl.createDiv({
			cls: "planflow-img-browse-path",
			text: isRoot ? "库根目录" : this.dir.path + "/",
		});
		if (!isRoot && this.dir.parent) {
			const up = this.contentEl.createDiv({ cls: "planflow-img-browse-item planflow-img-browse-up" });
			setIcon(up.createSpan({ cls: "planflow-img-browse-icon" }), "arrow-up");
			up.createSpan({ text: "返回上级" });
			up.addEventListener("click", () => {
				if (this.dir.parent instanceof TFolder) this.dir = this.dir.parent;
				this.remember();
				this.renderList();
			});
		}
		const folders = this.dir.children.filter((c): c is TFolder => c instanceof TFolder).sort((a, b) => a.name.localeCompare(b.name));
		const images = this.dir.children.filter(
			(c): c is TFile => c instanceof TFile && BannerImageModal.IMG_EXTS.includes(c.extension.toLowerCase()),
		).sort((a, b) => a.name.localeCompare(b.name));
		for (const folder of folders) {
			const item = this.contentEl.createDiv({ cls: "planflow-img-browse-item" });
			setIcon(item.createSpan({ cls: "planflow-img-browse-icon" }), "folder");
			item.createSpan({ text: folder.name });
			item.addEventListener("click", () => {
				this.dir = folder;
				this.remember();
				this.renderList();
			});
		}
		for (const img of images) {
			// v8.4d：缩略图预览（用户「浏览不显示文件夹里的图」）——所见即所得，点即选
			const item = this.contentEl.createDiv({ cls: "planflow-img-browse-item planflow-img-browse-img" });
			item.createEl("img", {
				cls: "planflow-img-browse-thumb",
				attr: { src: this.app.vault.getResourcePath(img), loading: "lazy", alt: img.name },
			});
			item.createSpan({ text: img.name });
			item.createSpan({ cls: "planflow-img-browse-dim", text: `${Math.round(img.stat.size / 1024)} KB` });
			item.addEventListener("click", () => {
				this.close();
				this.pick(img);
			});
		}
		if (folders.length === 0 && images.length === 0) {
			this.contentEl.createDiv({ cls: "planflow-img-browse-empty", text: "此文件夹没有子文件夹或图片" });
		}
		// 格式/尺寸提示（v8.4c 用户问询）：贴图层 cover 裁剪填充，横图最佳
		this.contentEl.createDiv({
			cls: "planflow-img-browse-hint",
			text: "支持 png / jpg / webp / gif / svg；建议宽 ≥ 1200px 的横图，会自动裁剪铺满 banner",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * v8.3 保存方案命名弹窗：一个文本框 + 取消/保存。
 * submit 回调返回错误文案（弹窗内红字提示、不关闭）或 null（成功并关闭）。
 */
class SchemeNameModal extends Modal {
	constructor(app: App, private submit: (name: string) => string | null) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("保存为皮肤方案");
		this.modalEl.addClass("planflow-scheme-modal");
		const input = this.contentEl.createEl("input", {
			cls: "planflow-scheme-name-input",
			attr: { type: "text", placeholder: "方案名（如：金麒麟）", spellcheck: "false" },
		});
		const err = this.contentEl.createDiv({ cls: "planflow-scheme-name-error planflow-hidden" });
		const btns = this.contentEl.createDiv({ cls: "modal-button-container" });
		btns.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		const ok = btns.createEl("button", { text: "保存", cls: "mod-cta" });
		const showErr = (text: string): void => {
			err.setText(text);
			err.classList.remove("planflow-hidden");
			input.focus();
		};
		const doSubmit = (): void => {
			const name = input.value.trim();
			if (!name) {
				showErr("先填个方案名");
				return;
			}
			const conflict = this.submit(name);
			if (conflict !== null) {
				showErr(conflict);
				input.select();
				return;
			}
			this.close();
		};
		ok.addEventListener("click", doSubmit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				doSubmit();
			}
		});
		window.setTimeout(() => input.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
