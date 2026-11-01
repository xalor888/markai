# 改动清单（供 review）

> 从基线到今天，工作树里有哪些改动、各自为什么。**没有 commit / push**，全部留在工作树里等你决定。
>
> 规模：**31 个已跟踪文件被修改（+3378 / −230），另有 23 个新路径**（其中源码与脚本 16 个文件、文档 7 份）。
>
> **工作树干净度已检查**：`git diff --ignore-all-space` 与普通 diff 只差 51 行——
> 也就是说没有混进「大面积格式化」这类无意义改动，diff 里每一处都是实质修改。
> 四道门当前状态：`tsc ✅ · 单测 643 ✅（基线 549）· build ✅ 962 kB · e2e 97/97（基线 18）`
>
> 2026-11-01 做过一次逐文件缺陷审计，修掉 15 处源码缺陷 + 6 处文档/工程配置问题，
> 每处修复都配了「修复前必红」的回归测试。结论见 [`bug-audit-0.2.33.md`](bug-audit-0.2.33.md)。

## 一、按模块看

### 自动整理的核心（`src/lib/ai/`）

| 文件 | 改动 |
| --- | --- |
| `auto-organize.ts` | 三层决策（本地高置信 → 模型 → 新建 → 本地兜底 → 域名）；结果带 `via`（本地/模型/兜底）；`collectLooseBookmarks` 支持不限量；批量移动时复用下标缓存 |
| `organize-rules.ts` | **新**。本地规则：品牌识别、语义分类、文件夹匹配打分（100/80/70/60）、高置信阈值 90 |
| `organize-log.ts` | **新**。整理记录：环形缓冲、并发串行化、检索、按去向聚合、按来源统计、Markdown 导出、剩余时间估算 |
| `organize-optout.ts` | **新**。停用名单：文件名上限 100 条、LRU（保留最近的）、大小写归一 |
| `deletion-executor.ts` | 删除走 `jRemove`（先抓子树快照再删，因此可撤销） |

### 撤销（`src/lib/undo/`）

| 文件 | 改动 |
| --- | --- |
| `mutations.ts` | `jMove` 支持调用方提供「移动前下标」，避免逐条 `getChildren` 导致 O(n²)（1 万条从 402 秒降到 25 秒） |
| `recorder.ts` | 未改动核心；`MAX_UNDO_POINTS = 10` 保持不变（见「已知局限」） |

### UI（`src/components/`）

| 文件 | 改动 |
| --- | --- |
| `sidebar/bookmark-tree.tsx` | 树可收起；右键菜单补全；大文件夹整理前的规模确认（站内确认框） |
| `bookmark-list/bookmark-list.tsx` | 多选操作条、Esc 清除、批量整理前确认、`text-md` 字号统一 |
| `organize/organize-log-dialog.tsx` | **新**。整理记录面板：统计 / 判断来源 / 去向聚合 / 检索 / 只看失败 / 逐条撤销与重试 / 重试全部 / 补整理（进度 + ETA + 取消 + 重开恢复）/ 停用名单 / 导出 / 清空 |
| `common/error-boundary.tsx` | **新**。四个入口各包一层，正常时 `display: contents`（零布局影响） |
| `common/shortcuts-dialog.tsx` | **新**。`?` 打开，内容与真实绑定一致 |
| `common/onboarding-tip.tsx` | **新**。首次打开的三步提示（可跳过、只显示一次） |
| `common/confirm-host.tsx` | **新**。站内确认框，替代 `window.native confirm` |
| `options/config-form.tsx` | 三步引导、自动整理开关（含 AI 参与开关）、整理记录直达 |
| `popup/*` | 主次按钮分层、自动整理卡、待删卡 |
| `workspace/workspace.tsx` | 顶栏「左滚动 + 右固定」、窄屏树宽、提示条与确认框挂载 |

### 状态与消息

| 文件 | 改动 |
| --- | --- |
| `stores/uiStore.ts` | 树折叠、**待删清单的取消勾选**（跨打开保留，避免误删）、确认框请求 |
| `stores/bookmarkStore.ts` | 跨窗口同步（300ms 防抖） |
| `stores/aiStore.ts` | `undoLast` 返回布尔 + `silent` 模式（支持「撤销全部」）、跨窗口同步 |
| `lib/ai/types.ts` | 新增 `organize:list/clear/retry/retry:all/sweep/sweep:cancel/sweep:status/undo/optout:*` 等消息类型 |

### 设计 token（`src/assets/main.css`）

- 深色 accent 从 `#6366f1` 提到 `#818cf8`，配套把 accent 上的文字改成深色 —— 原值作**文字色**时对比度只有约 4.0:1，低于 WCAG AA
- 新增 `--text-md: 0.8125rem`（13px），把散落的 `text-[13px]` 编外值收进规范

## 二、新增的测试与脚本

| 文件 | 用途 |
| --- | --- |
| `tests/agent.test.ts` | 549 → **643** 断言（T76–T97 共 20+ 组，T98 为本轮审计的 6 条回归） |
| `scripts/e2e-smoke.mjs` | **新**。真实 Chrome 加载扩展跑 97 项交互检查（CDP，无第三方依赖） |
| `scripts/visual-audit.mjs` | **新**。15 个视图的截图（浅/深/窄/对话框/设置页） |
| `scripts/stress-sweep.mjs` | **新**。压测：造 N 条 → 补整理 → 量耗时与主线程帧 |

## 三、文档

| 文件 | 内容 |
| --- | --- |
| `docs/user-guide.md` | **新**。怎么用（操作指引，不是功能清单） |
| `docs/markai-coverage.md` | **新**。每条能力是「有断言」还是「只有视觉证据」，以及已知未覆盖 |
| `docs/markai-upgrade-roadmap.md` | **新**。逐轮记录：做了什么、踩了什么坑、哪个改动被撤回及原因 |
| `docs/markai-upgrade-report.md` | **新**。面向用户的结果汇报（性能数字、四门状态、未做清单） |
| `docs/bug-audit-0.2.33.md` | **新**。逐文件缺陷审计：14 处源码缺陷 + 6 处文档/配置问题，含「修复前必红」的实测证据 |
| `README.md` | 能力表更新 |

## 四、还没做的（已知局限）

| 项 | 说明 |
| --- | --- |
| 补整理的撤销粒度 | 每条整理一个撤销点，上限 10 —— 「补整理 200 条想整体反悔」只能退最近 10 步。**合并在一个点的方案试过、能合并，但撤销时「新建文件夹是递归删除」会伤到同批的其它书签，已回退** |
| 删除不可回退 | 「撤销全部」遇到含删除的轮次会停下并说明，这是刻意的安全边界 |
| 拖拽只测了三条主路径 | 跨文件夹移动 / 同层排序 / Ctrl 复制都有断言；文件夹深拷贝的更深层级没有 |
| `window.confirm` 已全部换成站内确认框，但**没有断言** | 要触发得先造 100+ 条的文件夹，成本高于收益 |

## 五、建议的 review 顺序

1. `src/lib/ai/auto-organize.ts` + `organize-rules.ts` —— 判断逻辑，最值得看
2. `src/lib/undo/mutations.ts` —— 性能修复（O(n²) → O(n)）
3. `src/components/organize/organize-log-dialog.tsx` —— 最大的新 UI
4. `src/assets/main.css` —— 对比度修复（深色 accent）
5. 其余按需

跑一遍：`npx tsc --noEmit && npx tsx tests/agent.test.ts && npm run build && node scripts/e2e-smoke.mjs`