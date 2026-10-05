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
  {
    // 手写 SVG 图表文件（从 PlanBoardView 搬移而来）。
    //
    // 两条豁免的理由（社区规范禁止 eslint-disable 注释，豁免只能走配置，
    // 所以这里按**文件**限定粒度 —— charts.ts 就是纯图表，最精确）：
    // ① no-static-styles-assignment —— 图表配色是运行时按数据算出来的：热力图绿档随主题切换、
    //    柱高与扇区色按完成度插值、计划色还要再柔化。规则建议改用 CSS class + setCssProps，
    //    但 class 只能表达有限档位，表达不了连续插值；硬塞进 CSS 变量反而更绕。
    // ② prefer-create-el —— svgEl 必须用 createElementNS 建 SVG 命名空间元素，
    //    Obsidian 的 createSvg() 建的是 HTML 元素，没有等价实现。
    //
    // 这两条规则在非图表代码（PlanBoardView / daily / stats / tasks）里仍然生效。
    files: ["src/charts.ts"],
    rules: {
      "obsidianmd/no-static-styles-assignment": "off",
      "obsidianmd/prefer-create-el": "off",
    },
  },
]);
