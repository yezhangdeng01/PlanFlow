# PlanBoard v1.2 UI 任务：计划管理 + 量化目标管理

项目：E:\文档\Hermes\planboard\（Obsidian 插件，TypeScript + esbuild）
先读 PRD.md 和 docs/DEV.md 了解架构。数据模型 v1.2 已由 Hermes 改好（src/stats.ts 的 PlanDef/PlanGoal/PlanGoalProgress、src/tasks.ts 的 AutoGoal/ensureAutoTasks 按 goal 分解），**不要重写 stats.ts / tasks.ts / achievements.ts**，只改 PlanBoardView.ts + styles.css。

## 背景

年度计划 frontmatter `plans` 现在是"大类 + goals 量化目标"两级：
```yaml
plans:
  写作:
    label: ✍️ 写作
    action: 1小时
    daily: true
    target: 发布 12 篇公众号文章
    goals:
      - name: 公众号文章
        count: 12
        unit: 篇
        start: 2026-08-10
        end: 2026-12-31
  学习:
    label: 📖 学习
    action: 1小时
    daily: true
    target: 完成 1 条 AI 视频 + 读 10 本书
    goals:
      - name: AI视频
        count: 1
        unit: 条
        start: 2026-08-10
        end: 2026-12-31
      - name: 阅读
        count: 10
        unit: 本
        start: 2026-08-12
        end: 2026-12-31
```
- PlanDef（stats.ts 已导出）含：name/type/target/targetCount/goals[PlanGoal]/action/label/color/tradingDay
- PlanGoal：name/count/unit/start?/end?
- PlanProgress（年度视图数据）新增：goals: PlanGoalProgress[]（含 done/percent）、action、label、color、tradingDay
- 纯打卡计划（健康/复盘）goals 为空数组，isNumeric=false

## 任务

### 1. 年度视图（renderYearPanel）计划卡改造

现有每个计划卡结构（参考代码）：header（标题+进度数字+进度条）+ 任务列表 + 「＋ 为此计划新建任务」按钮。改成：

```
┌─ ✍️ 写作  [✏️] [🗑️]           ← 卡头右侧 icon-btn（.planboard-icon-btn 复用）
│  发布 12 篇公众号文章
│  ████████░░ 1/12 篇  (整体进度条保留，percent=Σgoals)
│  ┌─ 🎯 量化目标 ──────────┐
│  │ 公众号文章  0/12 篇 ▓▓░░ │  ← 每 goal 一行：名称 + done/count unit + 迷你进度条 + [✏️][🗑️]
│  └───────────────────────┘
│  （任务列表，复用 renderTaskItem）
│  [+ 新建任务] [+ 量化目标]     ← 两个按钮
└───────────────────────────
```

- goal 行 class：`.planboard-goal-row`，名称 `.planboard-goal-name`，数字 `.planboard-goal-count`，进度条 `.planboard-goal-bar`（内 fill `.planboard-progress-fill` 复用），按钮 icon-btn
- 无 goals 的计划不显示量化目标区
- 打卡型计划（isNumeric=false）：进度条显示打卡率（现有逻辑），不显示量化目标区
- 顶部（year panel header 下方）加「＋ 新增大类」按钮（.planboard-btn-primary），点击打开 PlanEditModal(null)
- 每计划卡「＋ 量化目标」按钮 → GoalEditModal(plan, null)

### 2. 首页年度目标卡（refreshToday 里的年度目标区）适配 goals

现有每计划一行 `doneCount/targetCount unit`。改为：
- 有 goals 的计划：每 goal 一行小字 `阅读 0/10 本`（名称 + 数字），合计进度条保留（percent）
- 无 goals（打卡型）：保持现状（打卡率）

### 3. 节奏提示（computeMonthRhythmHints）按 goal 算

现在按计划 targetCount 提示「本月应有 X 个」。改为**按 goal 独立提示**：每 goal `本月应有 ceil(count × 月权重) - 已完成 goal 任务数`（已完成 = 该 goal 前缀任务勾选数），密度过滤 `goal.count/总月数 < 0.5` 跳过（AI视频 1/5 月不提示，阅读 10/5=2 提示「阅读：本月应有 2 本」）。文案格式：`⚠️ {goal.name}：本月应有 {n} {unit}，当前 {done} {unit}`。

### 4. 三个 Modal（新建 Modal 类，仿现有 TaskModal 写法）

**PlanEditModal(plan: PlanDef | null)**（新增或编辑大类）：
- 字段：名称（text）、图标 label（text，如 ✍️）、动作 action（text，如 "1小时"）、目标描述 target（textarea）、颜色（下拉 8 色：#f59e0b/#10b981/#3b82f6/#ef4444/#8b5cf6/#ec4899/#14b8a6/#f97316）、每日打卡 checkbox（daily）
- 保存：写回年度计划 frontmatter plans（编辑=改该计划字段；新增=追加；名称重复拒绝）
- 新增时自动给 color（未选时轮换默认色）

**GoalEditModal(planName: string, goal: PlanGoal | null)**（新增或编辑量化目标）：
- 字段：名称（text）、数量（number）、单位（text，默认"个"）、开始日期（date input）、结束日期（date input）
- 保存：写回该计划的 goals 数组（编辑=替换；新增=追加；同计划内重名拒绝）
- 编辑已存在的 goal：若其分解任务已生成（任务池有「{goal.name}（第 N …」），提示「修改数量会重新分解，已有任务保留」——数量只影响后续配额（ensureAutoTasks 幂等按已有任务数继续）

**删除确认**：PlanEditModal 不带删除；删除用计划卡 🗑️ 按钮 → confirm() 提示「删除计划将同时删除其全部任务（含分解任务），确定？」→ 删 frontmatter 条目 + 任务池该计划任务行；goal 🗑️ → confirm()「删除该量化目标及其分解任务？」→ 删 goals 条目 + 任务池「{goal.name}（」前缀任务行

### 5. frontmatter 写回（关键，不能破坏文件）

写一个函数 `writePlansToFile(app, path, plans: PlanDef[])`：
- 读原文件，用 `^---\n([\s\S]*?)\n---` 提取 frontmatter 块
- **手动 YAML 序列化 plans 段**（不要用 js-yaml，无依赖）：按上述结构生成 `plans:` 缩进块（2 空格层级，label/action/daily/target/tradingDay/goals），**保留 frontmatter 里其他字段**（type/period/start/end 原样）
- 替换 frontmatter 中的 plans 段（正则 `^plans:[\s\S]*?(?=^\S|\n---)` 定位），正文一字不动
- 用 vault.process 写回；selfWrite 由调用方（视图）处理
- 序列化细节：daily 写 `daily: true`；tradingDay 有才写；goals 数组 `- name: ...` + 2 空格子字段；字符串含中文冒号无需引号（保持现有文件风格）

### 6. 计划颜色

injectPlanColorStyles 现在读 settings.planColors。改为：读年度计划 defs（frontmatter color 字段）∪ settings.planColors（settings 覆盖），生成规则不变（plan-tag 和 gantt-bar 都生效）。

## 验证要求

- npm run build 零错误
- 复制 main.js manifest.json styles.css 到 E:\文档\workbuddy\Obsidian库\.obsidian\plugins\planboard\（若沙箱拦截则报告，由 Hermes 手动部署）
- 年度视图渲染不报错（新字段已由 stats 提供）
- 不要改用户数据（年度计划.md / 任务.md 只在 Modal 保存时写入）

## 最终报告

文件清单、构建结果、部署结果（成功/被拦）、遗留问题。
