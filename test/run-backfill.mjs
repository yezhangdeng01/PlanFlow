import esbuild from "esbuild";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await esbuild.build({
	entryPoints: [path.join(__dirname, "backfill-test.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2018",
	outfile: path.join(__dirname, "backfill-test.cjs"),
	alias: { obsidian: path.join(__dirname, "obsidian-mock.ts") },
	logLevel: "error",
});

const mod = await import(pathToFileURL(path.join(__dirname, "backfill-test.cjs")).href);
// esbuild 的 cjs interop 会把 default 包成 { default: n }，两种形态都兜住
const code = typeof mod.default === "object" && mod.default !== null ? mod.default.default : mod.default;
process.exit(typeof code === "number" ? code : 0);
