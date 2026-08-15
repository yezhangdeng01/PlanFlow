# PlanFlow

> 个人计划总览：每日打卡、周/月/年目标进度、看板与甘特——六视图一体的 Obsidian 计划流系统。
> **数据是纯 Markdown**：计划定义在笔记 frontmatter，打卡即勾选任务，所有视图实时聚合，无需配置任何查询。

📖 **完整图文使用说明（设计理念 / 功能性 / 易用性）：[docs/USAGE.md](docs/USAGE.md)**

![今日视图](docs/screenshots/today.png)

## ✨ 功能

| 视图 | 能力 |
|---|---|
| **今日** | 年度目标进度条 + 今日打卡（勾选即写回笔记）+ 今日总结（自动派生/手动撰写）+ 月/周任务预览 |
| **周 / 月** | 按周/月窗口聚合任务，进度条 + 完成率统计 |
| **年度** | 计划卡片 masonry 布局，**拖拽排序（真交换/插列/跨列移动）**、卡片高度自由调节、量化目标 |
| **看板** | 按计划分组的任务看板，列头拖拽调宽（宽度重叠判定） |
| **甘特** | 时间轴任务条，拖拽调期 |

其他特性：
- 🏆 打卡连续天数（streak）+ 周/月完成度徽章（铜/银/金）
- 📊 按计划的完成率统计、年度目标自动进度
- 🎨 深空蓝主题色 + 珊瑚橙行动区 + 计划色点缀（明暗主题适配）
- 📝 每日笔记自动生成（代码内模板），总结可自动派生

## 🚀 安装

### 方式一：BRAT（推荐，支持自动更新）

1. 安装 [BRAT](obsidian://show-plugin?id=obsidian42-brat) 插件
2. BRAT 设置 → Add Beta plugin → 输入 `yezhangdeng01/PlanFlow`
3. 启用 PlanFlow（后续发新版自动更新）

### 方式二：手动安装

1. 下载 [最新 Release](https://github.com/yezhangdeng01/PlanFlow/releases) 的 `main.js`、`manifest.json`、`styles.css`
2. 在 vault 中创建 `.obsidian/plugins/planflow/` 目录，放入三个文件
3. Obsidian 设置 → 第三方插件 → 启用 PlanFlow

## 📂 数据格式（vault 内纯 Markdown）

```
raw/计划/                  ← 可在设置中修改根路径
├── 2026/
│   ├── 年度计划.md         ← 计划定义（frontmatter: plans）
│   ├── 任务.md             ← 任务池（所有计划的任务）
│   ├── 成就.md             ← 徽章记录
│   ├── 每日/2026-08-15.md  ← 每日打卡笔记（自动生成）
│   └── 周/2026-W33.md      ← 周目标（自动聚合）
```

**年度计划 frontmatter 示例**：

```yaml
---
plans:
  - name: 阅读
    type: 量化
    target: 24
    unit: 本
    desc: 读书笔记
  - name: 健身
    type: 习惯
    target: 100
    unit: 天
---
```

任务通过 `#计划/写作` 标签或 frontmatter 归属计划，日期窗口（本周=ISO 周、本月=自然月）自动聚合到对应视图。

## 🛠 开发

```bash
npm install
npm run build    # tsc + esbuild → main.js
npm run typecheck
```

## ⚠️ 说明

- UI 目前为中文（数据格式与字段名保持英文，便于国际化）
- 纯本地运行：无网络调用、无遥测、无数据外发

## 📄 许可

MIT © 2026 JCH
