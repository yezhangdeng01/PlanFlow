/**
 * 测试入口：把 test/*.ts 用 esbuild 现场打成 cjs 再跑（Obsidian 模块走 obsidian-mock）。
 *
 * 为什么这样跑：src/ 是 ESM + 吃 obsidian 模块，Node 直跑不了；
 * 而「手工复制一份业务逻辑到 cjs」的做法会让测试测副本（改了 src 测不出来）——
 * 这里坚持从 src/ 打包，保证测的是真代码。
 *
 * 用法：
 *   node test/run-test.mjs              跑全部
 *   node test/run-test.mjs parse        只跑 parse-test（文件名含 parse）
 *   node test/run-test.mjs charts       只跑 charts-test
 */
import esbuild from "esbuild";
import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? "";

// 找出所有 *-test.ts（排除 mock 与 run-* 胶水）
const entries = fs
	.readdirSync(__dirname)
	.filter((f) => f.endsWith("-test.ts") && (!filter || f.includes(filter)))
	.sort() // 固定顺序，便于对照输出
	.map((f) => path.join(__dirname, f));

if (entries.length === 0) {
	console.error(`没有匹配的测试文件（filter="${filter}"）`);
	process.exit(2);
}

let failed = 0;
let total = 0;
for (const entry of entries) {
	const name = path.basename(entry);
	console.log(`\n${"═".repeat(60)}\n▶ ${name}\n${"═".repeat(60)}`);
	const outfile = path.join(__dirname, name.replace(/\.ts$/, ".mjs"));
	// target es2022 + format esm：测试文件里可以直接写顶层 await。
	// 之前用 cjs/es2018，导致 async IIFE 里的断言还没跑完进程就退出了（输出为空）。
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "es2022",
		outfile,
		alias: { obsidian: path.join(__dirname, "obsidian-mock.ts") },
		logLevel: "error",
	});
	// 动态 import 会等顶层 await 完成，异步断言因此能被完整等待。
	// 约定：套件用 `export default 0|1` 汇报结果（1 = 有断言失败），
	// 失败时也会抛错 —— 两者都算失败，但**不能用 process.exit**：
	// 那会掐断本 runner，后面的套件永远跑不到（曾因此只跑出 2/4 个套件）。
	try {
		const mod = await import(pathToFileURL(outfile).href);
		const code = mod.default;
		if (typeof code === "number" && code !== 0) failed = 1;
	} catch (e) {
		console.error(`✗ ${name} 失败:`, e instanceof Error ? e.message : e);
		failed = 1;
	}
}

console.log(`\n${"═".repeat(60)}`);
if (failed === 0) console.log(`✅ 全部 ${entries.length} 个套件通过`);
else console.log(`❌ 有套件失败（共 ${entries.length} 个套件）`);
process.exit(failed);
