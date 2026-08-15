import esbuild from "esbuild";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await esbuild.build({
	entryPoints: [path.join(__dirname, "parse-test.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2018",
	outfile: path.join(__dirname, "parse-test.cjs"),
	alias: { obsidian: path.join(__dirname, "obsidian-mock.ts") },
	logLevel: "error",
});

const mod = await import(pathToFileURL(path.join(__dirname, "parse-test.cjs")).href);
process.exit(mod.default ?? 0);
