/**
 * 年度计划文件的 frontmatter 读写（v1.0.5 从 PlanBoardView.ts 类外搬入，字节级切割未改逻辑）。
 *
 * readRawPlans / writePlansToFile / serializePlans / yamlScalar / rotatePlanColor / toPlanDef
 * 全是纯函数（只有 writePlansToFile 碰 vault），无视图依赖。
 */
import { App, TFile, parseYaml } from "obsidian";
import { PlanProgress } from "./stats";
import type { PlanDef } from "./stats";

/** Palette offered in PlanEditModal (spec v1.2); empty choice = auto-rotate. */
export const PLAN_COLOR_OPTIONS = ["#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
export function readRawPlans(content: string): Map<string, Record<string, unknown>> {
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!fmMatch) return new Map();
	let data: Record<string, unknown> | null | undefined;
	try {
		const parsed: unknown = parseYaml(fmMatch[1]);
		data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return new Map();
	}
	const raw = data?.plans;
	const map = new Map<string, Record<string, unknown>>();
	if (Array.isArray(raw)) {
		for (const el of raw) {
			if (!el || typeof el !== "object") continue;
			const obj = el as Record<string, unknown>;
			const name = obj.name ?? obj.plan ?? obj["名称"] ?? obj["计划"];
			if (typeof name === "string") {
				map.set(name, obj);
			} else {
				const key = Object.keys(obj)[0];
				if (key) {
					const val = obj[key];
					map.set(key, val && typeof val === "object" ? (val as Record<string, unknown>) : {});
				}
			}
		}
	} else if (raw !== null && typeof raw === "object") {
		for (const key of Object.keys(raw)) {
			const val = (raw as Record<string, unknown>)[key];
			map.set(key, val && typeof val === "object" ? (val as Record<string, unknown>) : {});
		}
	}
	return map;
}

/**
 * Write the `plans` list back into the annual note's frontmatter (spec v1.2 #5).
 * The plans block is re-serialized manually (no js-yaml); every other frontmatter
 * field and the note body are preserved. Callers manage `selfWrite`.
 */
export async function writePlansToFile(
	app: App,
	file: TFile,
	plans: PlanDef[],
	dailyByPlan?: Record<string, boolean>
): Promise<void> {
	await app.vault.process(file, (content) => {
		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
		if (!fmMatch) return content;
		const inner = fmMatch[1];
		const lines = inner.split("\n");
		const plansIdx = lines.findIndex((l) => /^plans:(\s|$)/.test(l));
		let newInner: string;
		if (plansIdx === -1) {
			// 无 plans 键：插到 frontmatter 顶部。
			const ser = serializePlans(plans, dailyByPlan).replace(/\n$/, "");
			newInner = ser + (inner ? "\n" + inner : "");
		} else {
			// 定位 plans 块结束：下一行非空且不缩进（顶层 key），或 inner 末尾。
			let end = lines.length;
			for (let i = plansIdx + 1; i < lines.length; i++) {
				if (lines[i].length > 0 && !/^\s/.test(lines[i])) {
					end = i;
					break;
				}
			}
			const before = lines.slice(0, plansIdx).join("\n");
			const after = lines.slice(end).join("\n");
			const ser = serializePlans(plans, dailyByPlan).replace(/\n$/, "");
			newInner = (before ? before + "\n" : "") + ser + (after ? "\n" + after : "");
		}
		return content.replace(fmMatch[0], `---\n${newInner}\n---`);
	});
}

/** Manually serialize the `plans:` frontmatter block (2-space indent, spec v1.2 #5). */
export function serializePlans(plans: PlanDef[], dailyByPlan?: Record<string, boolean>): string {
	const lines: string[] = ["plans:"];
	for (const p of plans) {
		lines.push(`  ${yamlScalar(p.name)}:`);
		if (p.label) lines.push(`    label: ${yamlScalar(p.label)}`);
		// v7.6：不再序列化 `action`。它仍在 PlanDef 上（只读），仅供 stripLegacyDuration()
		// 剥老笔记标题里的「1小时」用；这里一旦重写 plans 块，旧 `action:` 行随之消失。
		lines.push(`    daily: ${dailyByPlan?.[p.name] ?? (p.type === "check")}`);
		if (p.target) lines.push(`    target: ${yamlScalar(p.target)}`);
		if (p.color) lines.push(`    color: ${yamlScalar(p.color)}`);
		if (p.goals.length > 0) {
			lines.push("    goals:");
			for (const g of p.goals) {
				lines.push(`      - name: ${yamlScalar(g.name)}`);
				lines.push(`        count: ${g.count}`);
				if (g.unit) lines.push(`        unit: ${yamlScalar(g.unit)}`);
				if (g.start) lines.push(`        start: ${yamlScalar(g.start)}`);
				if (g.end) lines.push(`        end: ${yamlScalar(g.end)}`);
				// v7.20: 量化到每日打卡（可选，默认不写 = 关）
				if (g.daily) {
					lines.push("        daily: true");
					// v7.21: 打卡项自定义内容——与默认（目标名/计划名/目标窗口/无复盘）
					// 全部一致时不写 dailyItem，旧数据保持 `daily: true` 不迁移。
					const di = g.dailyItem;
					if (di && (di.name !== g.name || di.plan !== p.name || di.start !== g.start || di.due !== g.end || di.review)) {
						lines.push("        dailyItem:");
						lines.push(`          name: ${yamlScalar(di.name)}`);
						lines.push(`          plan: ${yamlScalar(di.plan)}`);
						if (di.start) lines.push(`          start: ${yamlScalar(di.start)}`);
						if (di.due) lines.push(`          due: ${yamlScalar(di.due)}`);
						if (di.review) lines.push("          review: true");
					}
				}
			}
		}
	}
	return lines.join("\n") + "\n";
}

/** Quote a YAML scalar only when plain style could be misread (spec: 中文冒号无需引号). */
export function yamlScalar(value: string): string {
	const v = value.trim();
	if (v === "") return '""';
	if (
		/^[-?!&*#{[|>'"%@`]/.test(v) || // leading YAML indicator
		/:\s/.test(v) || // "key: value" ambiguity
		/:\s*$/.test(v) || // trailing colon
		/ #/.test(v) || // comment after space
		/[[\]{} ,]/.test(v) // flow indicators / space separators
	) {
		return JSON.stringify(v);
	}
	return v;
}

/** Pick the next free palette color for a new plan (spec v1.2 #4: 轮换默认色). */
export function rotatePlanColor(defs: PlanDef[]): string {
	const used = new Set<string>(defs.map((d) => d.color).filter(Boolean));
	for (const c of PLAN_COLOR_OPTIONS) {
		if (!used.has(c)) return c;
	}
	return PLAN_COLOR_OPTIONS[defs.length % PLAN_COLOR_OPTIONS.length];
}

/** Build a PlanDef from a PlanProgress for editing (PlanProgress lacks type/targetCount). */
export function toPlanDef(prog: PlanProgress): PlanDef {
	return {
		name: prog.plan,
		type: prog.isNumeric ? "numeric" : "check",
		target: prog.target,
		targetCount: prog.targetCount,
		goals: prog.goals.map((g) => ({ name: g.name, count: g.count, unit: g.unit, start: g.start, end: g.end })),
		action: prog.action,
		label: prog.label,
		color: prog.color,
		daily: true,
	};
}
