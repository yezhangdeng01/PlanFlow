# PlanBoard v1.5 开发日志

> 2026-08-13（v1.4 → v1.5 设计改版 + 联动修复）

## 今日完成

### 启动与音效
- 启动闪烁根治：`layout-change` 防抖 700ms（借鉴 homepage 插件）——恢复稳定后一次性打开，6s 上限兜底
- 打开视图音效去除：`updateTaskBadge` 首次渲染不播（prev !== ""）+ 今日徽章 `badgeInitialized` 哨兵——只有真实升档才响
- 设置页新增"成就音效"开关（achievementSound，默认 true）

### 视觉改版（专业设计评审驱动，claude-design 方法论）
- **全站主题色**：紫 → 低饱和浅蓝（--pb-accent #8ab4d8 / --pb-accent-dim #5d87b0），定义在 **:root**（modal 可达——body 级容器）
- **今日页布局重排**：日期行 → 年度目标 → 今日打卡/总结 → 月/周任务（CSS order，执行优先）
- **顶部日期 + 时段问候**（updateHomeDate，8月13日 周四 · 早上好…）
- **去框降噪**：年度/月/周卡透明化；今日打卡/总结卡保留 + 左侧浅蓝强调条（唯一焦点）
- **v1.5 年度总览 banner**：浅蓝渐变 + 19px/800 标题 + 数字 16px + 进度条 8px（文件最末尾，覆盖去框规则）
- 月/周徽章对齐今日（14px/700 + 渐变 + pop 动画 + 音效 + tooltip）
- tab/subtab/primary 按钮对比度：深蓝底白字 + **!important**（Obsidian 主题 button 规则特异性覆盖问题）
- 空态引导（月/周"暂无任务 + 新建"按钮）、看板卡片 hover、plan-card 透明化 + 标题 15px/700

### 功能联动
- **goal 编辑 → 分解任务重建**：删除旧分解任务（`目标名（第 N 期）` 前缀匹配）+ 按新时间/数量重新 ensureAutoTasks
- 打卡勾选/增删 → 总结三行实时联动（toggleCheckItem 等补 updateSummary）
- 并排卡片联动拖高（月↔周、打卡↔总结，linked getter 运行时解析）
- 月/周列表默认内容自适应高度（0 = auto，旧 180px 迁移）；拖拽后固定
- 总结三行并列一行（✅ 3/6 ⬜ 3/6 💪 鼓励），只统计数量不列项

## 遗留待办（未做）
1. **徽章语义区分**：今日徽章（达成率）vs 月/周徽章（任务完成率）同款——可加文字前缀
2. **周/月视图"临时任务"卡**与计划卡区分度（临时任务用虚线边框）
3. **跨日自动建笔记**选项（启动时今日笔记缺失自动创建）
4. **看板空列**已有"暂无任务"✓（完成项确认）

## 技术坑（教训）
- `--pb-*` 变量定义在 `.planboard-root` **不够**——modal 是 body 级，必须 :root
- Obsidian 主题的 `button` 规则特异性 > 插件类——primary 按钮需 `.planboard-btn.planboard-btn-primary` + !important
- `app:reload`（CDP executeCommand）会丢调试端口——需杀进程重启带 `--remote-debugging-port=9222`
- `.planboard-card` 基类在文件 58 行——去框/覆盖规则必须放**文件末尾**（顺序优先）
- 月/周徽章 class 是 `planboard-progress-bar--mini`（固定 64px）——紧凑条覆盖需 flex:1
