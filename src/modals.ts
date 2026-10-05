/**
 * 交互模态框（v1.0.5 从 PlanBoardView.ts 类外搬入，字节级切割未改逻辑）。
 *
 * 三个 Modal（添加打卡项 / 计划编辑 / 量化目标编辑）此前住在视图文件尾部，
 * 与视图类唯一的耦合是构造参数（app / plugin / 回调），本就自包含 ——
 * 拆出来后 PlanBoardView.ts 瘦身约 590 行，Modal 的改动不再需要滚动 4000 行找位置。
 */
import { App, Modal, Notice, Setting, ToggleComponent, setIcon } from "obsidian";
import type PlanBoardPlugin from "../main";
import { buildCheckLine, CheckItem } from "./daily";
import { PLAN_COLOR_OPTIONS } from "./plan-file";
import type { PlanDef, PlanGoal, GoalDailyItem } from "./stats";
/**
 * Fields editable in PlanEditModal (new or edit a plan category).
 * v7.6：`action`（每日打卡动作，原「1小时」后缀）已退役，弹窗不再提供该栏。
 * v7.18：`target`（目标描述）退役——量化目标段已承载该信息，弹窗不再提供该栏。
 */
export interface PlanEditInput {
	name: string;
	label: string;
	color: string;
	daily: boolean;
	// v7.16: 合并「新增量化目标」——仅新增计划时可在同一表单里顺带建一个量化目标
	//（可选，两栏全空 = 不建）；编辑已有计划时不显示该段。v7.18 起选已有计划名也走这段（只加目标）。
	goal?: GoalInput | null;
	// v7.18: 计划周期——写年度计划 frontmatter 顶层 start/end（readPlanPeriod 的数据源，
	// 年度统计窗口与自动任务分配窗口都跟它）。两者都填才写，全空 = 清除（回自然年）。
	period?: { start: string; end: string } | null;
}

/** Fields editable in GoalEditModal (new or edit a quantified goal). */
export interface GoalInput {
	name: string;
	count: number;
	unit: string;
	start?: string;
	end?: string;
	// v7.20: 量化到每日打卡——勾选后每天自动加一条该目标的打卡项（窗口内），勾它计入打卡统计
	daily?: boolean;
	// v7.21: 每日打卡项的可编辑内容（与「添加打卡项」同字段；daily 为 true 时有效）。
	// 缺省时使用端回落目标自身值（名称/计划/窗口），复盘链接回落 false。
	dailyItem?: GoalDailyItem;
}

export function attachFieldError(input: HTMLInputElement | HTMLTextAreaElement): {
	show: (msg: string) => void;
	clear: () => void;
} {
	// v1.0.5 回归修复：此处曾写 input.ownerDocument.createDiv —— Document 上调用
	// Obsidian 的 createDiv 扩展会抛 HierarchyRequestError（试图给 document 追加元素），
	// onOpen 中断后设置项全部消失、异常又被 Modal 内部吞掉，极难察觉。
	// 全局 createDiv() 建游离节点，随后 row.after(err) 插入，语义正确。
	const err = createDiv({ cls: "planboard-field-error" });
	err.setAttribute("role", "alert");
	err.hidden = true;
	const row = input.closest(".setting-item");
	if (row?.parentElement) row.after(err);
	else input.after(err);
	const show = (msg: string): void => {
		err.textContent = msg;
		err.hidden = false;
		input.addClass("is-invalid");
		input.setAttr("aria-invalid", "true");
		input.focus();
	};
	const clear = (): void => {
		err.hidden = true;
		err.textContent = "";
		input.removeClass("is-invalid");
		input.removeAttribute("aria-invalid");
	};
	input.addEventListener("input", clear);
	return { show, clear };
}

export class AddCheckItemModal extends Modal {
	private plugin: PlanBoardPlugin;
	private today: string;
	// v7.20: 计划下拉选项改由调用方传入（真实计划 + 内置名）——原先弹窗里只读 4 个
	// 内置名，选了不在年度计划里的名，打卡项的 #计划/ 标签对不上任何计划，统计漏计
	private planOptions: string[];
	private onSubmit: (line: string) => void;
	private nameEl!: HTMLInputElement;
	private planEl!: HTMLSelectElement;
	// v7.20: 含复盘链接（onChange 记账，不读 input.checked）
	private reviewVal = false;
	// v7.19: 起止日期（默认当天；写入行内 🛫/📅）
	private startEl!: HTMLInputElement;
	private endEl!: HTMLInputElement;

	constructor(app: App, plugin: PlanBoardPlugin, today: string, planOptions: string[], onSubmit: (line: string) => void) {
		super(app);
		this.plugin = plugin;
		this.today = today;
		this.planOptions = planOptions;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: "添加打卡项" });

		new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：阅读 30 分钟");
		});
		const nameErr = attachFieldError(this.nameEl);

		new Setting(contentEl).setName("计划").addDropdown((dropdown) => {
			this.planEl = dropdown.selectEl;
			for (const plan of this.planOptions) dropdown.addOption(plan, plan);
			dropdown.setValue(this.planOptions[0] ?? "");
		});

		// v7.6：删除「时长」栏（原值形如「1小时」，会拼进标题）。名称里想带时长可直接写，
		// 例如「阅读 30 分钟」——那是标题的一部分，不再由插件另行拼接。
		// v7.19: 起止日期（可选）——量化目标分解到日的人工补充：分解任务有 🛫/📅 窗口，
		// 手动加的打卡项原来钉死在当天；现在可给窗口（写入行内 🛫/📅，与任务池同语法）。
		// 默认都是当天（= 原行为），清空也回落当天。
		const periodSetting = new Setting(contentEl).setName("起止日期").setDesc("默认今天；跨多天的打卡项在这里给窗口");
		periodSetting.addText((text) => {
			this.startEl = text.inputEl;
			this.startEl.type = "date";
			this.startEl.addClass("planboard-date-btn");
			this.startEl.setAttribute("aria-label", "开始日期");
		});
		periodSetting.addText((text) => {
			this.endEl = text.inputEl;
			this.endEl.type = "date";
			this.endEl.addClass("planboard-date-btn");
			this.endEl.setAttribute("aria-label", "结束日期");
		});
		periodSetting.controlEl.addClass("planboard-period-range");
		this.startEl.value = this.today;
		this.endEl.value = this.today;
		const periodErr = attachFieldError(this.startEl);

		new Setting(contentEl).setName("含复盘链接").addToggle((toggle) => {
			// v7.20: 状态走 onChange 记账——input.checked 与视觉状态相反（见 GoalEditModal 注）
			toggle.setValue(false);
			toggle.onChange((v) => {
				this.reviewVal = v;
			});
		});

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());

		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "添加" });
		ok.addEventListener("click", () => {
			const name = this.nameEl.value.trim();
			if (!name) {
				nameErr.show("请输入打卡名称");
				return;
			}
			// v7.19: 起止日期——都空回落当天；半填或倒挂拦在表单里
			const ps = this.startEl.value || this.today;
			const pe = this.endEl.value || this.today;
			if ((this.startEl.value && !this.endEl.value) || (!this.startEl.value && this.endEl.value)) {
				periodErr.show("开始和结束日期请一起填，或都清空（默认今天）");
				return;
			}
			if (ps > pe) {
				periodErr.show("开始日期不能晚于结束日期");
				return;
			}
			const line = buildCheckLine({
				name,
				plan: this.planEl.value,
				includeReview: this.reviewVal,
				date: this.today,
				start: ps,
				due: pe,
			});
			this.onSubmit(line);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Modal for creating / editing a plan category (v1.2, spec #4). */
export class PlanEditModal extends Modal {
	private existing: PlanDef | null;
	private daily: boolean;
	private onSubmit: (input: PlanEditInput) => Promise<boolean>;
	/** v7.18: 已有计划名列表——名称输入框的 datalist 候选，选已有名 = 只为它加量化目标。 */
	private existingNames: string[];
	/** v7.18: 年度计划 frontmatter 顶层 start/end（readPlanPeriod 数据源），编辑时回填。 */
	private period: { start: string; end: string } | null;
	/** v7.19: 今天——新增计划时「开始日期」默认当日。 */
	private today: string;
	private nameEl!: HTMLInputElement;
	private labelEl!: HTMLInputElement;
	private colorEl!: HTMLSelectElement;
	// v7.18: 计划周期两个 date 输入（从量化段上移为计划级字段）
	private periodStartEl!: HTMLInputElement;
	private periodEndEl!: HTMLInputElement;
	// v7.16: 合并段——量化目标（可选，仅新增时显示）
	private goalNameEl!: HTMLInputElement;
	private goalCountEl!: HTMLInputElement;
	private goalUnitEl!: HTMLInputElement;
	/** 校验合并段（返回错误 + 出错字段，或 null）；仅新增计划时在 onOpen 里赋值。 */
	private goalValidate: (() => { msg: string; field: "name" | "count" } | null) | null = null;
	/** 从合并段收集 GoalInput（未填则返回 null）。 */
	private goalBuild: (() => GoalInput | null) | null = null;
	/** 合并段两个输入框的行内报错器（attachFieldError 产物；仅新增时赋值）。 */
	private goalNameShow: ((msg: string) => void) | null = null;
	private goalCountShow: ((msg: string) => void) | null = null;
	/** v7.18: 计划周期行内报错器（半填拦截）。 */
	private periodShow: ((msg: string) => void) | null = null;

	private dailyVal = true;
	/** emoji 选择浮层的点击外关闭监听与清理（v2.4.1）。 */
	private emojiPopDocDown: ((e: PointerEvent) => void) | null = null;
	private emojiClosePop: (() => void) | null = null;

	constructor(
		app: App,
		existing: PlanDef | null,
		daily: boolean,
		existingNames: string[],
		period: { start: string; end: string } | null,
		today: string,
		onSubmit: (input: PlanEditInput) => Promise<boolean>
	) {
		super(app);
		this.existing = existing;
		this.daily = daily;
		this.dailyVal = daily;
		this.existingNames = existingNames;
		this.period = period;
		this.today = today;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		// v7.16: 标题从「大类」改「计划」——与页面按钮「＋ 新增计划」同词，
		// 量化目标也并进这个表单（下见 goal 段），再叫大类容易让人以为只是分类。
		contentEl.createEl("h2", { text: this.existing ? "编辑计划" : "新增计划" });

		// v7.18: 新增时名称输入挂 datalist——下拉列出已有计划名；选中已有名时本表单
		// 只为该计划新增量化目标（见下方提交逻辑），不再重复建计划。
		// v7.20: 编辑模式不挂——名称在这里就是改名，不该被引到别的计划。
		const nameSetting = new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：写作");
		});
		if (!this.existing) {
			this.nameEl.setAttribute("list", "planflow-plan-name-options");
			const datalist = contentEl.createEl("datalist", { attr: { id: "planflow-plan-name-options" } });
			for (const n of this.existingNames) datalist.createEl("option", { value: n });
			nameSetting.setDesc("输入已有计划名可直接为它新增量化目标");
		}
		const nameErr = attachFieldError(this.nameEl);
		// v2.4: 图标字段 emoji 选择器（v2.4.1 改浮动弹层——点「选择…」在按钮旁弹出，不占 Modal 空间）
		const EMOJI_GROUPS: [string, string[]][] = [
			["运动", ["🏃", "🚶", "💪", "🏋️", "🧘", "⚽", "🏀", "🚴", "🏊", "🥾", "🎾", "⛰️"]],
			["学习", ["📖", "📚", "✍️", "🖋️", "🎓", "💡", "🧠", "🔬", "📝", "🗣️", "🎵", "📐"]],
			["健康", ["🥗", "🍎", "💊", "🩺", "😴", "🛌", "🌿", "💧", "🏥", "🥦", "🍵", "🧖"]],
			["工作", ["💼", "🖥️", "⌨️", "📈", "🗂️", "📊", "💻", "✉️", "🤝", "📅", "🛠️", "⚙️"]],
			["其他", ["🎯", "⭐", "🔥", "🎨", "📷", "🌱", "✨", "❤️", "🆕", "🌙", "☀️", "🚀"]],
		];
		const closeEmojiPop = (): void => {
			document.querySelector(".planflow-emoji-pop")?.remove();
			document.removeEventListener("pointerdown", this.emojiPopDocDown!, true);
			this.emojiPopDocDown = null;
		};
		this.emojiClosePop = closeEmojiPop;
		const showEmojiPop = (anchor: HTMLElement): void => {
			closeEmojiPop();
			const pop = document.body.createDiv({ cls: "planflow-emoji-pop" });
			for (const [label, emojis] of EMOJI_GROUPS) {
				const group = pop.createDiv({ cls: "planflow-emoji-group" });
				group.createSpan({ cls: "planflow-emoji-group-label", text: label });
				const row = group.createDiv({ cls: "planflow-emoji-row" });
				for (const emoji of emojis) {
					const b = row.createEl("button", { cls: "planflow-emoji-option", attr: { type: "button" } });
					b.setText(emoji);
					b.addEventListener("click", () => {
						this.labelEl.value = emoji;
						closeEmojiPop();
					});
				}
			}
			// 视口定位：按钮下方，左右不越界；下方空间不足则向上弹
			const r = anchor.getBoundingClientRect();
			const W = 340;
			const H = pop.offsetHeight || 340;
			let left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
			let top = r.bottom + 6;
			if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 6);
			pop.style.left = `${left}px`;
			pop.style.top = `${top}px`;
			pop.style.maxHeight = `${Math.min(380, window.innerHeight - 16)}px`;
			// 点击浮层外关闭
			this.emojiPopDocDown = (e: PointerEvent) => {
				if (!pop.contains(e.target as Node)) closeEmojiPop();
			};
			document.addEventListener("pointerdown", this.emojiPopDocDown, true);
		};
		new Setting(contentEl)
			.setName("图标")
			.setDesc("显示在计划名称前，如 ✍️ 📖 🏃")
			.addText((text) => {
				this.labelEl = text.inputEl;
				text.setPlaceholder("✍️");
			})
			.addButton((btn) => {
				btn.setButtonText("选择…").setTooltip("从常用 emoji 中选择").onClick(() => {
					showEmojiPop(btn.buttonEl);
				});
			});
		// v7.6：删除「动作」栏（原值形如「1小时」，会被拼进每日打卡标题且改不掉）。
		// 打卡记的是当天行动内容 + 用时，由今日打卡卡的行内输入框当场填。
		// v7.18：「目标描述」栏也退役——下方量化目标段已承载该信息（用户 190343）。
		new Setting(contentEl).setName("颜色").addDropdown((dropdown) => {
			this.colorEl = dropdown.selectEl;
			dropdown.addOption("", "（自动）");
			for (const c of PLAN_COLOR_OPTIONS) dropdown.addOption(c, c);
		});
		new Setting(contentEl).setName("每日打卡").setDesc("勾选后作为每日例行行动").addToggle((toggle) => {
			toggle.setValue(this.dailyVal);
			toggle.onChange((v) => {
				this.dailyVal = v;
			});
		});

		// v7.18: 计划周期（起止日期，可选）——从 v7.17 的量化目标段上移为计划级字段。
		// 写的是年度计划 frontmatter 顶层 start/end（readPlanPeriod 读的就是它），
		// 年度统计窗口与自动任务分配窗口都跟这个值；留空 = 自然年。
		const periodSetting = new Setting(contentEl).setName("起止日期").setDesc("计划的有效窗口，留空按整年算");
		periodSetting.addText((text) => {
			this.periodStartEl = text.inputEl;
			this.periodStartEl.type = "date";
			this.periodStartEl.addClass("planboard-date-btn");
			this.periodStartEl.setAttribute("aria-label", "开始日期");
		});
		periodSetting.addText((text) => {
			this.periodEndEl = text.inputEl;
			this.periodEndEl.type = "date";
			this.periodEndEl.addClass("planboard-date-btn");
			this.periodEndEl.setAttribute("aria-label", "结束日期");
		});
		periodSetting.controlEl.addClass("planboard-period-range");
		const periodErr = attachFieldError(this.periodStartEl);
		this.periodShow = (msg) => periodErr.show(msg);

		// v7.16: 合并「新增量化目标」——表单分两段：上段计划、下段量化目标。
		// v7.20: 编辑已有计划也显示这段（用户 195107）——补新目标直接在编辑表单里填，
		// 右键菜单的「新增量化目标」项随之退役。
		{
			const goalSection = contentEl.createDiv({ cls: "planboard-modal-goal-section" });
			goalSection.createEl("h3", { text: this.existing ? "新增量化目标（可选）" : "量化目标（可选）" });
			goalSection.createDiv({
				cls: "planboard-modal-goal-hint",
				text: this.existing
					? "填了就在保存时给本计划新增这个量化目标；留空则只更新计划本身。"
					: "没有量化目标也可以直接打卡；以后想补，右键计划卡 →「编辑计划」，在下方量化目标段添加。",
			});
			new Setting(goalSection).setName("目标名称").addText((text) => {
				this.goalNameEl = text.inputEl;
				text.setPlaceholder("例如：公众号文章");
			});
			const goalNameErr = attachFieldError(this.goalNameEl);
			this.goalNameShow = (msg) => goalNameErr.show(msg);
			new Setting(goalSection).setName("数量").addText((text) => {
				this.goalCountEl = text.inputEl;
				this.goalCountEl.type = "number";
				this.goalCountEl.min = "1";
				text.setPlaceholder("例如：12");
			});
			const goalCountErr = attachFieldError(this.goalCountEl);
			this.goalCountShow = (msg) => goalCountErr.show(msg);
			new Setting(goalSection).setName("单位").addText((text) => {
				this.goalUnitEl = text.inputEl;
				text.setPlaceholder("个");
			});
			this.goalUnitEl.value = "个";
			// v7.18: 起止日期已上移为计划级字段（见上）——目标窗口默认跟计划周期，
			// 需要单独覆盖时走计划卡右键「编辑目标」（GoalEditModal 仍有这两个字段）。

			// 校验与收集：名称/数量要么都空（不建目标），要么都有值且数量为正整数
			this.goalValidate = (): { msg: string; field: "name" | "count" } | null => {
				const gn = this.goalNameEl.value.trim();
				const gc = this.goalCountEl.value.trim();
				if (!gn && !gc) return null;
				if (gn && !gc) return { msg: "已填目标名称，请补数量", field: "count" };
				if (!gn && gc) return { msg: "已填数量，请补目标名称", field: "name" };
				const n = parseInt(gc, 10);
				if (Number.isNaN(n) || n <= 0) return { msg: "数量请输入正整数", field: "count" };
				return null;
			};
			this.goalBuild = (): GoalInput | null => {
				const gn = this.goalNameEl.value.trim();
				const gc = this.goalCountEl.value.trim();
				if (!gn || !gc) return null;
				return { name: gn, count: parseInt(gc, 10), unit: this.goalUnitEl.value.trim() || "个" };
			};
		}

		this.nameEl.value = this.existing?.name ?? "";
		this.labelEl.value = this.existing?.label ?? "";
		this.colorEl.value = this.existing?.color ?? "";
		// v7.18: 计划周期回填。v7.19: 编辑已有计划 = 原值回填；新增 = 开始日期默认当日
		//（用户 1930），结束日期沿用当前窗口末（无窗口则年末），用户可改可清空。
		if (this.existing) {
			this.periodStartEl.value = this.period?.start ?? "";
			this.periodEndEl.value = this.period?.end ?? "";
		} else {
			this.periodStartEl.value = this.today;
			this.periodEndEl.value = this.period?.end ?? `${this.today.slice(0, 4)}-12-31`;
		}

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => {
			// v1.0.5: 防重复提交——保存是异步写盘，await 期间连点会建出重复计划
			if (ok.disabled) return;
			ok.disabled = true;
			void (async () => {
				try {
				const name = this.nameEl.value.trim();
				if (!name) {
					nameErr.show("请输入计划名称");
					return;
				}
				// v7.18: 计划周期校验——要么都空（自然年），要么都填
				const ps = this.periodStartEl.value;
				const pe = this.periodEndEl.value;
				if ((ps && !pe) || (!ps && pe)) {
					this.periodShow?.("开始和结束日期请一起填，或都留空");
					return;
				}
				if (ps && pe && ps > pe) {
					this.periodShow?.("开始日期不能晚于结束日期");
					return;
				}
				// v7.16: 合并段校验——半填或数量非法时拦在表单里
				const gerr = this.goalValidate?.() ?? null;
				if (gerr) {
					if (gerr.field === "name") this.goalNameShow?.(gerr.msg);
					else this.goalCountShow?.(gerr.msg);
					return;
				}
				const saved = await this.onSubmit({
					name,
					label: this.labelEl.value.trim(),
					color: this.colorEl.value,
					daily: this.dailyVal,
					goal: this.goalBuild?.() ?? null,
					period: ps && pe ? { start: ps, end: pe } : null,
				});
				if (saved) this.close();
				} finally {
					ok.disabled = false;
				}
			})();
		});
	}

	onClose(): void {
		this.emojiClosePop?.(); // v2.4.1: 关闭 Modal 时清理浮动 emoji 选择层
		this.contentEl.empty();
	}
}

/** Modal for creating / editing a quantified goal under a plan (v1.2, spec #4). */
export class GoalEditModal extends Modal {
	private planName: string;
	private existing: PlanGoal | null;
	/** v7.21: 计划下拉选项（真实计划 + 内置名，当前计划排最前）——每日打卡项的 #计划/ 标签可选。 */
	private planOptions: string[];
	private onSubmit: (input: GoalInput) => Promise<boolean>;
	private nameEl!: HTMLInputElement;
	private countEl!: HTMLInputElement;
	private unitEl!: HTMLInputElement;
	private startEl!: HTMLInputElement;
	private endEl!: HTMLInputElement;
	// v7.21: 「量化到每日打卡」从开关改为可编辑段（与添加打卡项同款字段）。
	// 启用判据 = 打卡名称非空；留空 = 不生成（可选语义由输入框承载，不再用开关）。
	private dailyNameEl!: HTMLInputElement;
	private dailyPlanEl!: HTMLSelectElement;
	private dailyStartEl!: HTMLInputElement;
	private dailyEndEl!: HTMLInputElement;
	// 含复盘链接（onChange 记账，不读 input.checked——checkbox 反转坑）
	private dailyReviewVal = false;
	private dailyReviewToggle!: ToggleComponent;

	constructor(
		app: App,
		planName: string,
		existing: PlanGoal | null,
		planOptions: string[],
		onSubmit: (input: GoalInput) => Promise<boolean>
	) {
		super(app);
		this.planName = planName;
		this.existing = existing;
		this.planOptions = planOptions;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", {
			text: this.existing ? `编辑量化目标（${this.planName}）` : `新增量化目标（${this.planName}）`,
		});

		new Setting(contentEl).setName("名称").addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：公众号文章");
		});
		const nameErr = attachFieldError(this.nameEl);
		new Setting(contentEl).setName("数量").addText((text) => {
			this.countEl = text.inputEl;
			this.countEl.type = "number";
			this.countEl.min = "1";
			text.setPlaceholder("例如：12");
		});
		const countErr = attachFieldError(this.countEl);
		new Setting(contentEl).setName("单位").addText((text) => {
			this.unitEl = text.inputEl;
			text.setPlaceholder("个");
		});
		new Setting(contentEl).setName("开始日期").addText((text) => {
			this.startEl = text.inputEl;
			this.startEl.type = "date";
			this.startEl.addClass("planboard-date-btn");
		});
		new Setting(contentEl).setName("结束日期").addText((text) => {
			this.endEl = text.inputEl;
			this.endEl.type = "date";
			this.endEl.addClass("planboard-date-btn");
		});
		// v7.21: 「量化到每日打卡」从开关改为可编辑段（用户指令：不是一个开关，要和
		// 「添加打卡项」一样的几个可编辑内容）。字段与 AddCheckItemModal 一致：
		// 名称 / 计划 / 起止日期 / 含复盘链接。启用判据 = 打卡名称非空，留空 = 不生成。
		// 窗口内每天自动加一条该打卡项，勾选计入计划打卡率/打卡统计；目标本身的
		// 量化进度仍走分解任务，两条线不混。
		contentEl.createDiv({ cls: "planboard-modal-section-title", text: "量化到每日打卡（可选）" });
		const dailyDesc = contentEl.createDiv({ cls: "planboard-modal-section-desc" });
		dailyDesc.setText("填了打卡名称才生成：窗口内每天自动加一条该打卡项，勾选计入打卡统计");

		new Setting(contentEl).setName("打卡名称").addText((text) => {
			this.dailyNameEl = text.inputEl;
			text.setPlaceholder("例如：写作 30 分钟（留空则不生成）");
		});
		new Setting(contentEl).setName("计划").addDropdown((dropdown) => {
			this.dailyPlanEl = dropdown.selectEl;
			for (const plan of this.planOptions) dropdown.addOption(plan, plan);
			dropdown.setValue(this.planOptions[0] ?? this.planName);
		});
		const dailyPeriodSetting = new Setting(contentEl).setName("起止日期").setDesc("默认跟随目标起止日期");
		dailyPeriodSetting.addText((text) => {
			this.dailyStartEl = text.inputEl;
			this.dailyStartEl.type = "date";
			this.dailyStartEl.addClass("planboard-date-btn");
			this.dailyStartEl.setAttribute("aria-label", "开始日期");
		});
		dailyPeriodSetting.addText((text) => {
			this.dailyEndEl = text.inputEl;
			this.dailyEndEl.type = "date";
			this.dailyEndEl.addClass("planboard-date-btn");
			this.dailyEndEl.setAttribute("aria-label", "结束日期");
		});
		dailyPeriodSetting.controlEl.addClass("planboard-period-range");
		const dailyPeriodErr = attachFieldError(this.dailyStartEl);
		new Setting(contentEl).setName("含复盘链接").addToggle((toggle) => {
			// v7.20: 状态走 onChange 记账——input.checked 与视觉状态相反（实测本版 Obsidian）
			this.dailyReviewToggle = toggle;
			toggle.setValue(false);
			toggle.onChange((v) => {
				this.dailyReviewVal = v;
			});
		});

		this.nameEl.value = this.existing?.name ?? "";
		this.countEl.value = this.existing ? String(this.existing.count) : "";
		this.unitEl.value = this.existing?.unit ?? "个";
		this.startEl.value = this.existing?.start ?? "";
		this.endEl.value = this.existing?.end ?? "";
		// v7.21: 每日打卡段回填——YAML 有 dailyItem 用它；旧数据（daily: true 无配置）
		// 回落目标自身值（名称/计划/窗口），与推导口径一致。
		const di = this.existing?.dailyItem;
		if (this.existing?.daily) {
			this.dailyNameEl.value = di?.name ?? this.existing.name;
			if (di?.plan && this.planOptions.includes(di.plan)) this.dailyPlanEl.value = di.plan;
			this.dailyStartEl.value = di?.start ?? this.existing.start ?? "";
			this.dailyEndEl.value = di?.due ?? this.existing.end ?? "";
			if (di?.review) {
				this.dailyReviewVal = true;
				this.dailyReviewToggle.setValue(true);
			}
		}

		// 弹窗打开即聚焦名称输入（Obsidian modal 不默认聚焦；迟延兜底动画期间点击失效）
		this.nameEl.focus();
		window.setTimeout(() => {
			if (this.contentEl.isConnected) this.nameEl.focus();
		}, 120);

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		ok.addEventListener("click", () => {
			// v1.0.5: 防重复提交（同 PlanEditModal）
			if (ok.disabled) return;
			ok.disabled = true;
			void (async () => {
				try {
				const name = this.nameEl.value.trim();
				if (!name) {
					nameErr.show("请输入目标名称");
					return;
				}
				const count = parseInt(this.countEl.value, 10);
				if (Number.isNaN(count) || count <= 0) {
					countErr.show("请输入有效的数量");
					return;
				}
				const input: GoalInput = { name, count, unit: this.unitEl.value.trim() || "个" };
				if (this.startEl.value) input.start = this.startEl.value;
				if (this.endEl.value) input.end = this.endEl.value;
				// v7.21: 打卡名称非空 = 启用「量化到每日打卡」，收集整个可编辑段
				const dName = this.dailyNameEl.value.trim();
				if (dName) {
					const ds = this.dailyStartEl.value;
					const de = this.dailyEndEl.value;
					if ((ds && !de) || (!ds && de)) {
						dailyPeriodErr.show("起止日期请一起填，或都清空（默认跟随目标）");
						return;
					}
					if (ds && de && ds > de) {
						dailyPeriodErr.show("开始日期不能晚于结束日期");
						return;
					}
					input.daily = true;
					const item: GoalDailyItem = { name: dName, plan: this.dailyPlanEl.value || this.planName };
					if (ds) item.start = ds;
					if (de) item.due = de;
					if (this.dailyReviewVal) item.review = true;
					input.dailyItem = item;
				}
				const saved = await this.onSubmit(input);
				if (saved) this.close();
				} finally {
					ok.disabled = false;
				}
			})();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * v1.0.5.2: 今日打卡项管理弹窗（计划管理页入口）。
 *
 * 背景：今日打卡卡去掉行内删除后，打卡项的增删收归计划管理页——
 * 计划卡「✅ 打卡行动」标题行的 ✏️ 打开本弹窗，按计划过滤今日打卡项：
 * 列表（逐项删）+ 添加表单（名称/起止日期）。首页保留「+ 添加」做快捷新建。
 */
export class CheckItemManageModal extends Modal {
	private plan: string;
	private today: string;
	private getItems: () => CheckItem[];
	private isAuto: (item: CheckItem) => boolean;
	private onAdd: (line: string) => Promise<void>;
	private onDeleteItem: (item: CheckItem) => Promise<void>;
	private onEditItem: (item: CheckItem, name: string, start: string | null, due: string | null) => Promise<void>;
	private listEl!: HTMLElement;
	private nameEl!: HTMLInputElement;
	private startEl!: HTMLInputElement;
	private endEl!: HTMLInputElement;
	private busy = false;
	private editing: CheckItem | null = null; // 当前处于 inline 编辑态的项

	constructor(
		app: App,
		opts: {
			plan: string;
			today: string;
			getItems: () => CheckItem[];
			isAuto: (item: CheckItem) => boolean;
			onAdd: (line: string) => Promise<void>;
			onDeleteItem: (item: CheckItem) => Promise<void>;
			onEditItem: (item: CheckItem, name: string, start: string | null, due: string | null) => Promise<void>;
		}
	) {
		super(app);
		this.plan = opts.plan;
		this.today = opts.today;
		this.getItems = opts.getItems;
		this.isAuto = opts.isAuto;
		this.onAdd = opts.onAdd;
		this.onDeleteItem = opts.onDeleteItem;
		this.onEditItem = opts.onEditItem;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("planboard-modal");
		contentEl.createEl("h2", { text: `管理打卡项 · ${this.plan}` });

		this.listEl = contentEl.createEl("ul", { cls: "planboard-checklist planboard-manage-list" });
		this.renderList();

		// 添加表单：名称 + 起止日期（计划已由本弹窗锁定，不再选）
		const period = new Setting(contentEl).setName("新增打卡项").setDesc("默认今天；跨多天在这里给窗口");
		period.addText((text) => {
			this.nameEl = text.inputEl;
			text.setPlaceholder("例如：阅读 30 分钟");
		});
		period.addText((text) => {
			this.startEl = text.inputEl;
			this.startEl.type = "date";
			this.startEl.value = this.today;
			this.startEl.setAttribute("aria-label", "开始日期");
		});
		period.addText((text) => {
			this.endEl = text.inputEl;
			this.endEl.type = "date";
			this.endEl.value = this.today;
			this.endEl.setAttribute("aria-label", "结束日期");
		});
		period.controlEl.addClass("planboard-period-range");

		const buttons = contentEl.createDiv({ cls: "planboard-modal-buttons" });
		const cancel = buttons.createEl("button", { cls: "planboard-btn", text: "完成" });
		cancel.addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "添加" });
		ok.addEventListener("click", () => {
			if (this.busy) return;
			const name = this.nameEl.value.trim();
			if (!name) return;
			const ps = this.startEl.value || this.today;
			const pe = this.endEl.value || this.today;
			if ((this.startEl.value && !this.endEl.value) || (!this.startEl.value && this.endEl.value)) {
				new Notice("开始和结束日期请一起填，或都清空（默认今天）");
				return;
			}
			if (ps > pe) {
				new Notice("开始日期不能晚于结束日期");
				return;
			}
			this.busy = true;
			void (async () => {
				try {
					await this.onAdd(buildCheckLine({ name, plan: this.plan, includeReview: false, date: this.today, start: ps, due: pe }));
					this.nameEl.value = "";
					this.renderList();
				} finally {
					this.busy = false;
				}
			})();
		});
	}

	/** 每次增删/编辑后重渲染列表（数据由 getItems 从 View 取最新） */
	private renderList(): void {
		this.listEl.empty();
		const items = this.getItems();
		if (items.length === 0) {
			this.listEl.createEl("li", { cls: "planboard-manage-empty", text: "该计划今天还没有打卡项" });
			return;
		}
		for (const item of items) {
			if (this.editing === item) {
				this.renderEditingRow(item);
				continue;
			}
			const li = this.listEl.createEl("li", { cls: "planboard-check-item" });
			const auto = this.isAuto(item);
			li.createSpan({ cls: "planboard-check-text", text: item.text + (item.checked ? " ✓" : "") });
			if (auto) {
				// 跟随计划/目标自动创建的打卡项**不可删除**（只有删除计划才连带删除），
				// 也不可编辑——行内容是目标定义的投影，改它会被次日自动重建覆盖。
				li.createSpan({ cls: "planboard-manage-auto-tag", text: "自动" });
				continue;
			}
			const actions = li.createDiv({ cls: "planboard-item-actions is-static" });
			const editBtn = actions.createEl("button", {
				cls: "planboard-icon-btn",
				attr: { "aria-label": "编辑这项", title: "编辑这项" },
			});
			editBtn.setText("✏️"); // 彩色 emoji（与卡头编辑按钮一致）
			editBtn.addEventListener("click", () => {
				this.editing = item;
				this.renderList();
			});
			const del = actions.createEl("button", {
				cls: "planboard-icon-btn planboard-del-btn",
				attr: { "aria-label": "删除这项", title: "删除这项" },
			});
			setIcon(del, "lucide-trash-2");
			del.addEventListener("click", () => {
				if (del.disabled) return;
				del.disabled = true;
				void (async () => {
					try {
						await this.onDeleteItem(item);
						this.renderList();
					} finally {
						del.disabled = false;
					}
				})();
			});
		}
	}

	/** 手动项 inline 编辑：名称 + 起止日期，保存/取消。 */
	private renderEditingRow(item: CheckItem): void {
		const li = this.listEl.createEl("li", { cls: "planboard-check-item planboard-manage-editing" });
		const name = li.createEl("input", { type: "text", value: item.text });
		name.addClass("planboard-manage-edit-name");
		const start = li.createEl("input", { type: "date" });
		start.value = item.start ?? this.today;
		const due = li.createEl("input", { type: "date" });
		due.value = item.due ?? this.today;
		const save = li.createEl("button", { cls: "planboard-btn planboard-btn-primary", text: "保存" });
		const cancel = li.createEl("button", { cls: "planboard-btn", text: "取消" });
		cancel.addEventListener("click", () => {
			this.editing = null;
			this.renderList();
		});
		save.addEventListener("click", () => {
			if (this.busy) return;
			const newName = name.value.trim();
			if (!newName) return;
			this.busy = true;
			void (async () => {
				try {
					await this.onEditItem(item, newName, start.value || null, due.value || null);
					this.editing = null;
					this.renderList();
				} finally {
					this.busy = false;
				}
			})();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
