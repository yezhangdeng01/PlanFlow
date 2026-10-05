import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // 本插件 UI 文本为中文，sentence case 规则（针对英文）不适用
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  // 曾在此豁免 charts.ts 的 no-static-styles-assignment / prefer-create-el——
  // v1.1.2 起已按扫描器要求改用 setCssStyles / createSvg，豁免删除，规则全量生效。
]);
