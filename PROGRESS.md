# PlanBoard 交互优化 — 进度状态（2026-08-14 v1.7.4 更新）

> 目的：上下文压缩后恢复工作的唯一依据。新会话先读本文件，再读 docs/DEV.md 与 PRD.md。

## 任务背景
用户对 PlanBoard（Obsidian 插件）提的交互优化需求链：
看板视图拖拽移动 → 年度视图卡片下缘拖拽调高 → 取消并列卡强制对齐 → 卡片颜色区分 →
标签与起止日期同行（v1.7.3，用户拍板方案）→ 列拖拽改回"宽度重叠判定"（用户纠正：鼠标判定因抓取点不固定导致感受差异）。

## v1.7.4 已完成（2026-08-14 晚，已构建部署）
1. **列拖拽 computeRef 改回宽度重叠判定**（src/PlanBoardView.ts，attachColSort 内）：
   - 用被拖列视觉 rect（`col.getBoundingClientRect()`，含 transform=跟手位置）与目标列求**水平宽度重叠比例 ≥ 1/3**（分母=双方较小宽度），与抓取偏移无关。
   - 保留末尾检测（被拖列中心 > 所有列 maxRight + 8 → end）；方向=被拖列中心 vs 目标列中心（左→before，右→after）。
   - 列间 gap 无吸附（无重叠不判定）——与列表项拖拽语义一致。
2. **新增 `.planboard-task-meta` 样式**（styles.css）：
   - `order: 2 + flex-basis: 100%` 强制第二行；`margin-left: 26px` 与 checkbox 对齐；`font-size: 10.5px; opacity: 0.9`。
   - `.planboard-check-item .planboard-item-actions { order: 1 }` 保证操作按钮留在第一行右侧。
   - 注意：li 的 `flex-wrap: wrap`（.planboard-check-item 全局）是 meta 换行的前提，勿删。
3. **清理旧 CSS 规则**（styles.css 删约 300 行）：
   - 删除所有针对"tag/dates 作为 li 直接子元素"的 order / flex-basis:100% / margin-left:26px 规则（v1.6 多次迭代残留，全部失效）。
   - 保留：`.planboard-check-text` 统一 `flex: 1 1 auto; min-width: 0`；`.planboard-plan-grid .planboard-plan-tag { display: none }`（年度卡内标签冗余隐藏）。
4. **构建部署**：`npm run build` 通过 → 已复制 main.js + manifest.json + styles.css 到
   `E:\文档\workbuddy\Obsidian库\.obsidian\plugins\planboard\`。

## 待验证（用户操作）
- Obsidian 里重载插件（禁用再启用或重载），验证：
  a) 看板列头拖拽：换位判定是否随列整体重叠触发（不再依赖鼠标位置）；
  b) 任务项第二行：tag + 起止日期同行、与 checkbox 缩进对齐、今日打卡/周/月/看板/年度各视图显示正常；
  c) 今日打卡项（tag 仍在 label 内，结构未改）显示不变。
- 若有问题反馈，按上述代码位置修。

## UI 专业评估结论（2026-08-14，真实 CDP 验证）
已建立真实环境验证通道：Obsidian 常驻 --remote-debugging-port=9222，CDP 截图/几何测量脚本 test/screenshot.js + test/cdp-probe.js，历史截图在 E:\tmp。
真实环境实测（今日视图，root 宽 1236）：
1. **年度目标条 4 项视觉间距 = 0（确认 bug）**：styles.css:1718-1723 `.planboard-goal-strip-item { margin: -4px -4px }` 与 strip `gap: 8px` 叠加 → 8-4-4=0，实测 goalGaps [0,0,1]，4 个 pill 粘连。修复：gap 改 16px 或删负 margin。
2. **打卡/总结卡当前恰好等高（327px）**——但这是内容巧合（align-items:start 下各自自然高度拼巧），打卡加项/总结写长即破。建议 802-804 改回 stretch（配合 v1.7 联动拖拽无副作用），规范化为永远等高。
3. **今日打卡 header 真实环境正常**（h=38，按钮 30px）——模拟页的 58px/50px 是缺 Obsidian 主题 normalize 的失真。真实只有无 streak/badge 显示时才清爽，有连续打卡时会挤（P2 观察项）。
4. **任务 meta 第二行正常**（缩进 26px、第二行定位正确）✓ v1.7.4 生效。
5. masonry 年度视图 + 拖拽排序（insertBefore）与 CSS columns 的视觉顺序冲突——未实测，P1 隐患。
6. 今日打卡项（tag 在 label 内）vs 任务池项（meta 结构）行形态不统一——P2。
优先级：P0-1 目标条间距（可立即修）；P1-2 等高规范化；P1-3 masonry 拖拽实测；P2 观察项。

## 代码结构备忘（v1.7.4 现状）
- renderTaskItem（src/PlanBoardView.ts:1661+）：li = label(checkbox+标题) + div.planboard-task-meta(tag? + dates?) + actions。
- renderCheckItem（今日打卡，1148+）：tag 仍在 label 内（checkbox+标题+tag），**未改**——旧 label 布局仅今日打卡在用。
- 临时任务（1328+）：label 内 temp-due/temp-source，与 meta 无关。
- 列拖拽：attachColSort(board, col, plan) 只挂"按计划分列"的看板；状态列（📋🔥✅）不挂拖拽。
- **年度计划卡卡头（v1.7.4 改）**：只留"＋ 新增量化目标"outline pill 按钮（与年度 header"＋ 新增计划"呼应）；✏️🗑️ 已移除 → 计划编辑/删除移到**卡头右键菜单**（contextmenu + Menu，新 import Menu）；拖拽 onCapture 已加 `e.button !== 0` 左键过滤（右键让位菜单）。
- **拖拽调高（v1.7.4 修）**：所有带把手卡 flex column + handle **绝对定位贴底**（position:absolute; bottom:0——不依赖 flex auto margin，内容溢出也不突出，v1.7.4 二修）；**自由缩放 min 80**（无内容钳制，可向上拖小）；内容承接：年度卡 `.planboard-plan-tasks` flex:1+min-height:0+overflow-y:auto（滚动），各卡 overflow:hidden 兜底；home 卡 padding-bottom 4px（把手以下留 4px）；渲染时保存值 >0 即应用（含小于内容的，滚动承接）。
- **年度卡拖拽排序（v1.7.4 大改：JS 显式两列容器）**：CSS columns → `grid > .planboard-plan-col ×2`（flex），渲染按高度贪心分列（colH 累加）；attachPlanSort 列感知：`columns` 参数 + `othersAll()`（跨列取卡）+ `parentOf()`；swap 三情况（相邻前/相邻后/不相邻含跨列）——**拖放精确**：插间隙=列内插入、对准=交换、拖到列底=列内末尾，不再受 columns 列平衡牵连。实测：大卡插小卡堆间隙✓、跨列交换✓、列内插✓、拖高 handle 贴底✓。旧 columns 的问题（插中间不可控）已根治。

## 今日视图 v1.7.4 五项（用户 2026-08-15 要求，已部署验证）
- ① 整页标题：onOpen 加 `.planboard-page-title`（"计划总览" 22px/800，tabs 上方）
- ② 年度目标条进度条垂直居中：goal-strip mini bar `align-self:center; margin-top:4px`（实测 diff 2px）
- ③ 新建笔记模板：daily.ts buildDailyTemplate 删除 "- **今日完成**/未完成/感想收获" 三行（用户已删过、代码不应再写入）
- ④ 写复盘按钮避让 handle：`.planboard-summary-card { padding-bottom: 20px }`（4px 时按钮被绝对定位 handle 覆盖 12px）
- ⑤ 配色**最终版**（v1.7.4 七改，采纳专业建议"边框弱化+颜色点缀"）：三卡统一 `1px 浅灰细边框`（4px 彩色边框层级扁平、喧宾夺主）；banner=淡蓝渐变背景（信息区，明暗主题分别适配）；行动区=**珊瑚橙 #ef8354** 卡头色条（check 卡 header ::before + summary 卡 title ::before，后者需 inline-block）+ 写复盘按钮 outline 珊瑚橙（特异性需 .planboard-btn.planboard-review-btn 高于 .planboard-btn-outline）。进度条 margin-top 7px（bar 中心与文字像素级对齐）。vision_cli.py 完整评价：界面精致、banner 突出。
- 整页标题"计划总览"已删除（用户不需要，v1.7.4 加了又删）

## 关键历史决策（勿翻案）
- 标签+日期**放同一行**（用户拍板），标题第一行完整显示、不再被标签挤换行。
- 拖拽判定**用重叠不用鼠标位置**（用户纠正两次，抓取点不固定是根因）——列表项=面积重叠(1/3)，列=宽度重叠(1/3)。
- 看板任务卡拖拽已取消（中心判定滞后体验差）；列头拖拽排序=重叠判定 + boardColumnOrder 持久化。
- 卡片颜色区分：全框 4px 低饱和边框（0.28 透明度）+ 卡头淡彩。
- 年度视图卡片下缘拖拽调高已实现；并列卡强制对齐已取消。

## 环境备忘
- 项目：E:\文档\Hermes\planboard（非 git 仓库，无版本控制）
- 部署目标：E:\文档\workbuddy\Obsidian库\.obsidian\plugins\planboard\
- 本会话状态：上下文已重度压缩（多次降级摘要），务必以本文件 + 实际读文件为准，不要依赖历史对话记忆。
- 工具坑：search_files 对中文路径（E:\文档）报 IO error —— 用 terminal grep 或 read_file 代替。
