/**
 * Minimal mock of the Obsidian module for offline parsing tests.
 * Only implements what src/daily.ts, src/tasks.ts, src/stats.ts import.
 */
export class App {}
export class TFile {}
export class TFolder {}
export class Notice {}

/** Tiny YAML subset parser covering the frontmatter shapes PlanBoard reads. */
export function parseYaml(src: string): any {
	const lines = src.split("\n");
	let pos = 0;

	const indentOf = (l: string): number => l.search(/\S/);
	const stripComment = (s: string): string => s;

	function parseNode(indent: number): any {
		while (pos < lines.length) {
			const line = lines[pos];
			if (!line.trim() || line.trim().startsWith("#")) {
				pos++;
				continue;
			}
			break;
		}
		if (pos >= lines.length) return null;
		const first = lines[pos];
		if (indentOf(first) < indent) return null;

		if (first.trim().startsWith("- ")) {
			const arr: any[] = [];
			while (pos < lines.length) {
				const line = lines[pos];
				if (indentOf(line) < indent) break;
				if (!line.trim() || line.trim().startsWith("#")) {
					pos++;
					continue;
				}
				if (!line.trim().startsWith("- ")) break;
				const content = stripComment(line.trim().slice(2).trim());
				const lineIndent = indentOf(line);
				if (content === "" || content.endsWith(":")) {
					pos++;
					arr.push(parseNode(lineIndent + 2));
				} else {
					const idx = content.indexOf(":");
					if (idx !== -1) {
						const obj: Record<string, unknown> = {};
						const key = content.slice(0, idx).trim();
						const val = content.slice(idx + 1).trim();
						obj[key] = val === "" ? parseNode(lineIndent + 2) : val;
						pos++;
						while (pos < lines.length) {
							const nl = lines[pos];
							if (indentOf(nl) <= lineIndent) break;
							const nidx = nl.trim().indexOf(":");
							if (nidx === -1) {
								pos++;
								continue;
							}
							const nkey = nl.trim().slice(0, nidx).trim();
							const nval = stripComment(nl.trim().slice(nidx + 1).trim());
							obj[nkey] = nval === "" ? parseNode(indentOf(nl) + 2) : nval;
							pos++;
						}
						arr.push(obj);
					} else {
						arr.push(content);
						pos++;
					}
				}
			}
			return arr;
		}

		const obj: Record<string, unknown> = {};
		while (pos < lines.length) {
			const line = lines[pos];
			if (indentOf(line) < indent) break;
			if (!line.trim() || line.trim().startsWith("#")) {
				pos++;
				continue;
			}
			const idx = line.trim().indexOf(":");
			if (idx === -1) {
				pos++;
				continue;
			}
			const key = line.trim().slice(0, idx).trim();
			const val = stripComment(line.trim().slice(idx + 1).trim());
			if (val === "") {
				pos++;
				obj[key] = parseNode(indentOf(line) + 2);
			} else {
				obj[key] = val;
				pos++;
			}
		}
		return obj;
	}

	return parseNode(0);
}

export function stringifyYaml(value: any): string {
	return JSON.stringify(value, null, 2);
}
