/**
 * Gantt drag interactions (v1.3, written by Hermes — not the model).
 *
 * Event-delegated pointer drag on `.planboard-gantt-bar`:
 * - drag the bar body  → shift start & due together (whole-bar move)
 * - drag `.is-left` handle  → adjust start only
 * - drag `.is-right` handle → adjust due only
 * - click (no drag, <3px movement) → open the task editor via callback
 *
 * Writes back through `editTask` (keeps checked state), then refreshes the view.
 * Axis granularity: week/month → days; year → weeks (7-day steps).
 */
import { App } from "obsidian";
import type { PoolTask } from "./tasks";
import { editTask } from "./tasks";

export interface GanttDragOptions {
	/** Resolve the PoolTask for a pool line number (from the view's latest render). */
	resolveTask: (line: number) => PoolTask | undefined;
	/** Open the task editor modal. */
	onEdit: (task: PoolTask) => void;
	/** Called after a successful write-back so the view can refresh. */
	onChanged: () => void;
}

interface DragState {
	bar: HTMLElement;
	track: HTMLElement;
	line: number;
	start: string | null;
	due: string | null;
	axis: "week" | "month" | "year";
	mode: "move" | "left" | "right" | null;
	pointerId: number;
	startX: number;
	lastX: number;
	startLeft: number;
	startWidth: number;
	trackWidth: number;
	dragged: boolean;
}

const MIN_DRAG_PX = 3;

/** Convert a date string to a Date at UTC midnight (avoids TZ drift). */
function parseUtc(date: string): Date {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

function fmtUtc(d: Date): string {
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDays(date: string, n: number): string {
	const d = parseUtc(date);
	d.setUTCDate(d.getUTCDate() + n);
	return fmtUtc(d);
}

function dayDiff(a: string, b: string): number {
	return Math.round((parseUtc(b).getTime() - parseUtc(a).getTime()) / 86400000);
}

/**
 * Attach delegated pointer-drag handling on a root element (the view's content
 * element — attach once in onOpen; the DOM rebuilds on refresh but delegation
 * keeps working).
 */
export function attachGanttDrag(app: App, rootEl: HTMLElement, opts: GanttDragOptions): void {
	let drag: DragState | null = null;

	rootEl.addEventListener("pointerdown", (e: PointerEvent) => {
		const bar = (e.target as HTMLElement).closest<HTMLElement>(".planboard-gantt-bar");
		if (!bar) return;
		const track = bar.closest<HTMLElement>(".planboard-gantt-track");
		if (!track) return;
		const line = Number(bar.getAttribute("data-line") ?? "-1");
		if (line < 0) return;

		const start = bar.getAttribute("data-start") || null;
		const due = bar.getAttribute("data-due") || null;
		const axis = (bar.getAttribute("data-axis") as DragState["axis"]) ?? "month";

		const handle = (e.target as HTMLElement).closest<HTMLElement>(".planboard-gantt-handle");
		let mode: DragState["mode"] = "move";
		if (handle) mode = handle.classList.contains("is-left") ? "left" : "right";
		if (mode !== "move" && (!start || !due)) mode = "move"; // undated bars: whole move only (no-op guard below)

		const trackWidth = track.clientWidth;
		drag = {
			bar,
			track,
			line,
			start,
			due,
			axis,
			mode,
			pointerId: e.pointerId,
			startX: e.clientX,
			lastX: e.clientX,
			startLeft: parseFloat(bar.style.left || "0"),
			startWidth: parseFloat(bar.style.width || "0"),
			trackWidth,
			dragged: false,
		};
		bar.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	});

	rootEl.addEventListener("pointermove", (e: PointerEvent) => {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const dx = e.clientX - drag.startX;
		if (!drag.dragged && Math.abs(dx) > MIN_DRAG_PX) {
			drag.dragged = true;
			drag.bar.addClass("is-dragging");
		}
		if (!drag.dragged) return;

		// Live preview in PERCENT (bar left/width are percentages; px would shrink the bar).
		const dxPct = (dx / drag.trackWidth) * 100;
		const startLeftPct = drag.startLeft; // already parsed from style (percent)
		const startWidthPct = drag.startWidth;
		const gantt = drag.track.closest(".planboard-gantt");
		const cells = gantt ? gantt.querySelectorAll(".planboard-gantt-axis-cell").length : 31;
		const minW = 100 / Math.max(cells, 1); // one axis unit
		let left = startLeftPct;
		let width = startWidthPct;
		if (drag.mode === "move") {
			left = startLeftPct + dxPct;
			left = Math.max(0, Math.min(left, 100 - width));
		} else if (drag.mode === "left") {
			const maxLeft = startLeftPct + startWidthPct - minW;
			left = startLeftPct + dxPct;
			left = Math.max(0, Math.min(left, maxLeft));
			width = startWidthPct + (startLeftPct - left);
		} else {
			// right handle: left stays fixed, only width changes
			width = Math.max(minW, Math.min(startWidthPct + dxPct, 100 - startLeftPct));
		}
		drag.bar.style.left = `${left}%`;
		drag.bar.style.width = `${width}%`;
		drag.lastX = e.clientX;
	});

	const finish = async (e: PointerEvent): Promise<void> => {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const d = drag;
		drag = null;
		d.bar.removeClass("is-dragging");
		try {
			d.bar.releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		if (!d.dragged) return; // left-click without drag = nothing (edit is right-click)
		if (!d.start || !d.due || d.mode === null) return;
		const task = opts.resolveTask(d.line);
		if (!task) return;

		// Pixels → date delta. Axis cells give the window size:
		// week → 7 days, month → days-in-month, year → 12 months (drag snaps to weeks).
		const gantt = d.track.closest(".planboard-gantt");
		const cells = gantt ? gantt.querySelectorAll(".planboard-gantt-axis-cell").length : (d.axis === "week" ? 7 : d.axis === "year" ? 12 : 31);
		let dayDelta: number;
		if (d.axis === "year") {
			const pxPerWeek = d.trackWidth / 52;
			dayDelta = Math.round((d.lastX - d.startX) / pxPerWeek) * 7;
		} else {
			const pxPerDay = d.trackWidth / cells;
			dayDelta = Math.round((d.lastX - d.startX) / pxPerDay);
		}

		let newStart = d.start;
		let newDue = d.due;
		if (d.mode === "move") {
			newStart = addDays(d.start, dayDelta);
			newDue = addDays(d.due, dayDelta);
		} else if (d.mode === "left") {
			newStart = addDays(d.start, dayDelta);
			if (dayDiff(newStart, d.due) < 1) newStart = addDays(d.due, -1);
		} else {
			newDue = addDays(d.due, dayDelta);
			if (dayDiff(d.start, newDue) < 1) newDue = addDays(d.start, 1);
		}
		if (newStart === d.start && newDue === d.due) return;

		await editTask(app, task, { text: task.text, plan: task.plan, start: newStart, due: newDue });
		opts.onChanged();
	};

	rootEl.addEventListener("pointerup", (e: PointerEvent) => {
		if (drag && e.pointerId === drag.pointerId) void finish(e);
	});
	rootEl.addEventListener("pointercancel", (e: PointerEvent) => {
		if (drag && e.pointerId === drag.pointerId) {
			drag.bar.removeClass("is-dragging");
			drag = null;
		}
	});

	// Right-click on a bar opens the task editor (left click is reserved for dragging).
	rootEl.addEventListener("contextmenu", (e: MouseEvent) => {
		const bar = (e.target as HTMLElement).closest<HTMLElement>(".planboard-gantt-bar");
		if (!bar) return;
		e.preventDefault();
		const line = Number(bar.getAttribute("data-line") ?? "-1");
		if (line < 0) return;
		const task = opts.resolveTask(line);
		if (task) opts.onEdit(task);
	});
}
