# 0.2.33 未提交改动缺陷审计

> 对象：工作树里全部未提交改动（31 个已跟踪文件修改 + 3378/−230，23 个新路径）。
> 不 commit、不 push、不新增功能、不做无关重构；改动全部叠加在原改动之上。
>
> **结论：发现并修复 15 处源码缺陷 + 6 处文档/工程配置问题。其中 5 处配了「修复前必红、
> 修复后转绿」的回归测试，并逐条实测验证过；其余为时序/代码组织类，靠不变量与结构保证（见 §6）。**
>
> 四道门（2026-11-01 实测）：`tsc ✅` · 单测 **643 项 ✅**（基线 637 → +6）· `build ✅ 962 kB` · `e2e 97/97 ✅`

---

## 1. 审计范围与结论一览

| 文件 | 结论 |
| --- | --- |
| `src/lib/ai/auto-organize.ts` | **发现 3 处**（B1 兜底字段缺失、B5 收集窗口、B10 只对子域成立的分类条目查不到） |
| `src/entrypoints/background.ts` | **发现 6 处**（B3 撤销点串味、B4 TOCTOU、B5 调用侧、B6 引导名额、B7 报警噪音、B15 待处理项被静默丢弃） |
| `src/lib/ai/organize-log.ts` | **发现 2 处**（B9 `latest` 依赖输入顺序、B12 声明顺序） |
| `src/lib/ai/organize-rules.ts` | **发现 2 处**（B10 死键、B14 注释与实现矛盾） |
| `src/lib/ai/organize-optout.ts` | 未发现问题 |
| `src/components/organize/organize-log-dialog.tsx` | **发现 3 处**（B2 规模数字、B8 文案矛盾、B13 死代码） |
| `src/stores/uiStore.ts` | **发现 1 处**（B11 确认框覆盖） |
| `src/lib/undo/mutations.ts` | 未发现问题（`known` 下标快路径与 `recordOp` 顺序正确） |
| `src/lib/undo/recorder.ts` | 未发现问题（事务生命周期、哨兵 `expectedRunId`、pending 串行化均正确） |
| `src/lib/undo/journal.ts` | 未发现问题 |
| `src/lib/bookmarks/domain.ts` | 未发现问题（IP 字面量、ccTLD 三段规则正确） |
| `src/lib/bookmarks/timeline.ts` | 未发现问题 |
| `src/lib/chat/busy-guard.ts` | 未发现问题（同步可变 Set 解决了 React 状态快照竞态） |
| `src/components/common/confirm-host.tsx` | 未发现问题（依赖修复后的 uiStore 队列语义） |
| `src/components/common/error-boundary.tsx` | 未发现问题 |
| `src/components/common/onboarding-tip.tsx` | 未发现问题 |
| `src/components/common/shortcuts-dialog.tsx` | 未发现问题 |
| `src/components/bookmark-list/timeline-panel.tsx` | 未发现问题 |
| `src/stores/bookmarkStore.ts` | 未发现问题（退避刷新与跨窗口合并正确） |
| `src/stores/aiStore.ts` | 未发现问题 |
| `src/stores/configStore.ts` | 未发现问题 |
| `src/lib/ai/types.ts` | 未发现问题（消息类型与 background 分发一一对应，`switch` 穷尽） |
| `scripts/e2e-smoke.mjs` | **发现 1 处**（D6：只断言文案存在、不校验数字 → 假绿） |

---

## 2. 高严重度

### B1｜兜底分支缺 `aiFailed` / `target` / `runId`（核心功能失效）

- **位置**：`src/lib/ai/auto-organize.ts:432-470`（③ 兜底的两个返回点）
- **根因**：③「按注册域兜底」的两条返回路径只填了 `ok/action/detail/via`。
  - 缺 `aiFailed` → 调用方 `flushAutoOrganize` 拿到 `undefined`，`nextAiStreakState({failed:false})`
    把连续失败计数**清零**，于是「连续失败 3 次暂停 10 分钟」永远不触发；
  - 缺 `target` → 整理记录里没有「→ 去了哪个文件夹」；
  - 缺 `runId` → 这条记录没有「↶ 撤销」按钮。
- **为什么这条最要命**：③ 恰好是「没有任何本地匹配分类的新用户 + 配错 Key」唯一会走到的路径。
  也就是最需要冷却保护的用户，偏偏走了不会触发冷却的分支，于是**每收藏一次白等 12 秒**——
  正是代码注释里承诺要防的那个体感「这扩展坏了」。
- **修法**：三处返回点补齐 `target` / `aiFailed` / `runId`，并写清为什么缺一不可。
- **验证**：T98「坏 Key + 无本地匹配：兜底结果必须上报 aiFailed」。
  回退修复后实测报：`模型失败没有被上报 → 连续失败计数不会累加`。
- **用户可见**：坏 Key 时不再每次收藏都卡十几秒；兜底归类的记录也能撤销、也能看到去向。

### B2｜面板显示的「检测到 N 条散落」是错的数字

- **位置**：`src/components/organize/organize-log-dialog.tsx:404`
- **根因**：`collectLooseBookmarks` 的入参形态是 `getTree()` 的 `[根节点]`，内部读 `tree[0].children`。
  而 `bookmarkStore.roots` 是**三个根文件夹**（书签栏 / 其他书签 / 移动设备）。
  错传进去后，`tree[0]` 变成了「书签栏」，`children` 成了书签栏的直接子项——
  统计的是「书签栏里某个子文件夹里的书签」，和后台真正会处理的完全不是同一批。
- **修法**：拆出 `collectLooseBookmarksFromRoots(roots, maxItems, exclude)`，
  `collectLooseBookmarks` 变成它的便捷包装；UI 改用 `...FromRoots`。
  两个入口共用同一份遍历逻辑，避免再次分叉。
- **验证**：T98「接受三个根文件夹形态」+「getTree 形态与根数组形态结果一致」；
  e2e 新增「补整理的规模数字与实际会处理的条数一致」（D6）。
- **用户可见**：`检测到 N 条散落` 的 N 现在是真话，不再出现「明明一堆却显示 0」。

### B3｜补整理与自动整理并发 → 撤销点串味

- **位置**：`src/entrypoints/background.ts:641`（`flushAutoOrganize` 让路）、`:856`（sweep 结束时唤醒）
- **根因**：两条路径都调 `beginUndoTransaction`。而 `beginUndoTransaction` 发现已有活动事务时
  会先把上一轮**强行收尾落盘**。于是：
  1. 补整理正在记 A 事务；
  2. 用户收藏一个书签 → `flushAutoOrganize` 开 B 事务，A 被提前收尾；
  3. 补整理后半段的移动被记进 **B**；
  4. 补整理 `endUndoTransaction('auto-organize:A')` 因 runId 不匹配返回 null（不收尾）。

  结果是用户点「撤销 B」会连带退掉补整理的书签——**撤销了一个他没做过的事**。
- **修法**：`flushAutoOrganize` 遇 `sweepRunning` 就把 id 原样放回 `autoPending` 并返回（不重排定时器，
  避免几百条轮询起一堆 timer）；`runOrganizeSweep` 的 `finally` 里负责唤醒。
- **验证**：`sweepRunning` 的声明也随之上移到 `flushAutoOrganize` 之前（读代码不必往下翻）。
  这条时序没有 e2e 覆盖（已登记在 `markai-coverage.md` §六）。
- **用户可见**：补整理跑着时收藏新书签，不会污染自己的撤销记录。

### B4｜补整理启动存在 TOCTOU 竞态（双击跑两遍）

- **位置**：`src/entrypoints/background.ts:730-733`
- **根因**：原先 `if (sweepRunning) return;` → `await chrome.bookmarks.getTree()` → `sweepRunning = true`。
  两次快速点击都能穿过检查（await 期间让出），于是两个 sweep 并发处理同一批书签：
  同一条被搬两次、`orderCache` 互相踩、撤销点交织。
- **修法**：**先占位再 await**；`getTree` 失败或 0 条时复位并如实返回。
- **验证**：由「无 await 间隙」这条不变量保证；配合 B3 的让路，并发面收敛到零。
- **用户可见**：连点「开始」不会变成两倍工作量和一堆错乱的撤销点。

---

## 3. 中严重度

### B5｜补整理「先截断后过滤」→ 剩下的书签永远扫不到

- **位置**：`src/entrypoints/background.ts:803`、`src/lib/ai/auto-organize.ts:520`
- **根因**：`collectLooseBookmarks(tree, 200).filter(t => !processed.has(t.id))`。
  `processed` 里的书签**仍在原位**（失败 / skipped 不会移动），所以它们会一直占据批次窗口的前 200 名。
  一旦前 200 条全部处理过，`batch` 就是空数组 → `break` 带走剩下所有书签，
  而用户只会看到「补整理完成」，不会知道后面几百条根本没被看过。
  这与报告里「已改为自动分批，直到根目录没有可收的书签」的承诺直接冲突。
- **修法**：`collectLooseBookmarks(tree, maxItems, exclude)` 把排除放进**收集阶段**，
  被排除项不占窗口；收集满额即提前返回。
- **验证**：T98「已处理的条目在收集阶段就被排除（不占 200 的窗口）」——窗口设为 1、
  排除前两条，断言拿到的是第三条。回退后实测报：`窗口应当被下一个未处理的书签填满`。

### B6｜`skipped` 也消耗「首次引导」名额

- **位置**：`src/entrypoints/background.ts:694`
- **根因**：判断写的是 `failed ? res.detail : await decorateSuccessDetail(...)`——
  只排除了 `failed`，于是 `skipped`（非网页书签 / 书签已不存在 / 无法识别域名）也会走
  `decorateSuccessDetail`，把 `markai.organize.hinted` 置位。用户第一次收藏的若恰好是
  `chrome://` 或 `mailto:` 链接，那段「之后可在顶栏『整理』里回看与撤销」的引导就永久消失了。
- **修法**：判据改成与项目里已有的 `retryOrganizeEntry` 完全一致的
  `const succeeded = res.ok && res.action !== 'skipped'`，只有 `succeeded` 才补提示。
- **验证**：判据统一后，「成功」的定义在两条路径上只有一个。

### B7｜非静默 `skipped` 会弹红色失败 toast

- **位置**：`src/entrypoints/background.ts:715-718`
- **根因**：`notifyAutoOrganized(res.ok && res.action !== 'skipped', ...)` ——
  对未列入 `silentSkip` 的 skipped（非网页书签等）传 `ok:false`，界面按失败样式弹红色警告。
  用户只是收藏了一个 `chrome://settings` 页面，却被告知「自动整理未完成」。
  为一个用户没要求的动作报警，是噪音不是反馈。
- **修法**：只在 `succeeded || action === 'failed'` 时弹；skipped 的痕迹照旧写进整理记录。
- **验证**：与 B6 同一处判据，一处统一。

### B8｜「补整理没有启动」的 toast 与详情自相矛盾

- **位置**：`src/components/organize/organize-log-dialog.tsx:226-232`
- **根因**：所有 `!res.started` 一律用标题「没有需要补整理的书签」，
  但后台在「已在运行」时返回的详情是「补整理正在进行中，请稍候」——
  屏幕上是「没有需要补整理的书签 / 补整理正在进行中，请稍候」，两句直接打架。
- **修法**：按详情区分三种情形（正在跑 / 没有可整理的 / 读取失败），标题随实情变化。
- **验证**：文案由后台返回的详情驱动，不再有写死的前提。

### B9｜`summarizeOrganizeLog` 的 `latest` 依赖输入顺序（且测试把 bug 固化成了期望值）

- **位置**：`src/lib/ai/organize-log.ts:180-190`
- **根因**：`entries.find(e => e.action === 'moved' || 'created')` —— 取的是「输入里第一个成功」，
  而不是「时间最新的成功」。函数被声明为纯函数，调用方（单测、导出）会直接喂数组。
  **原测试的断言 `latest?.title === 't1'` 恰恰固化了这个错误行为**：那份数据里
  `t1` 在 `t2` 之前，但 `t2` 的时间更晚。
- **修法**：改为按 `at` 取最大。
- **验证**：同步修正该断言为 `t2` 并写明「不依赖输入顺序」。回退修复后实测报
  `latest 取时间最新的成功记录` 失败。

### B10｜`SITE_CATEGORY` 里有三条永远命中不了的死键

- **位置**：`src/lib/ai/organize-rules.ts:26-100`、`:154-156`
- **根因**：查表用的是**注册域**，但表里写的是
  `news.ycombinator.com`（注册域 `ycombinator.com`）、`music.163.com`（注册域 `163.com`）、
  `figma.com/community`（根本不是域名）。这三条配了等于没配。
- **修法**：`pickExistingFolder` 增加可选 `host`，查表顺序「完整主机名 → 注册域」；
  删掉 `figma.com/community`（它不可能是 host 也不可能是注册域，纯死数据）。
  `autoOrganizeBookmark` 传入 `new URL(node.url).hostname`。
- **验证**：T98「news.ycombinator.com 归『阅读』」——同时断言**不传 host 时拿不到**，
  证明这个能力确实依赖新参数而不是巧合命中。回退后实测报 `完整主机名必须命中「阅读」`。

### B11｜站内确认框：后来的请求覆盖前一个，用户点到的是没写的那件事

- **位置**：`src/stores/uiStore.ts:66-85`
- **根因**：`requestConfirm` 无条件 `set({ confirmRequest: req })`。
  「清空全部记录」的确认框还开着时，若另一处（撤销全部 / 大范围整理）又发请求，
  前一个请求的 `onConfirm` 就被静默丢弃——**屏幕上写的是 A，点「确定」执行的是 B**。
- **修法**：加 `confirmQueue`，第一个立即显示、后续排队；`resolveConfirm` / `cancelConfirm`
  先出队再操作，保证「看到的」与「执行的」永远是同一个。
- **验证**：T98「站内确认框：第二个请求排队而不是覆盖」。回退后实测报 `屏幕上应当仍是最早那个`。

---

## 4. 低严重度 / 代码质量

### B15｜Agent 任务期间待整理的书签被静默丢弃

- **位置**：`src/entrypoints/background.ts:645-652`（`flushAutoOrganize` 的让路分支）
- **根因**：函数开头就把 `autoPending` 拷进局部 `ids` 并**清空**集合，随后 `if (agentTaskRunning) return;`
  ——那几条书签既不在集合里、也不会被处理，等于凭空消失。
  （这是修 B3 时发现的同族问题：让路可以，但不能丢件。）
- **修法**：让路时把 `ids` 原样放回集合；抽出 `wakeAutoOrganize(delayMs)` 统一负责「什么时候再试」，
  由**结束方**调用——`runOrganizeSweep` 的 `finally` 与 `handleChatSend` 的 `clearBadge`
  （正常结束 / 取消 / 失败三条路径都经过它）。`clearTimeout` 保证同一时刻只有一个等待中的定时器。
- **验证**：时序问题，靠「让路必放回 + 结束方必唤醒 + 唤醒幂等」三条不变量保证；
  没有 e2e 覆盖（已在 `markai-coverage.md` §六 登记）。


### B12｜`writeChain` 声明在第一个使用者之后

`src/lib/ai/organize-log.ts`：`updateOrganizeLogEntry`（第 100 行附近）用 `writeChain`，
而 `let writeChain` 原先声明在第 126 行。靠「函数延迟求值」侥幸能跑，
但任何一次顶层调用改造都会立刻变成 `ReferenceError`。**已把声明提到所有使用者之前**并写明原因。

### B13｜死代码 `attention`

`organize-log-dialog.tsx` 里 `const attention = entries.filter(...).length` 声明后从未使用。
已删除（面板用的是 `stats.failed` 与 `pickRetryableEntries`）。

### B14｜`isConfidentMatch` 的注释与实现矛盾

注释写「品牌精确匹配 / 分类精确匹配」，实现阈值是 90，而分类精确匹配只有 70 分——
也就是说分类精确匹配**不**算高置信。文档（`markai-upgrade-report.md` 的分值表）与实现一致，
是注释错了。**已改注释并写清「70 分为什么不在此列」**（分类名的误伤面更大，仍需模型确认）。

---

## 5. 文档与工程配置

| # | 位置 | 问题 | 处置 |
| --- | --- | --- | --- |
| D1 | `docs/markai-coverage.md` §四 | 写着「补整理的撤销粒度**已解决**：按 200 条合并成一个撤销点（`pointCount: 1`）」，与代码、与 `changes-summary.md`、与 e2e 的 `pointCount === 10` 全部冲突。**代码里没有任何事务合并**，该方案在代码注释里明确记录为「已回退（撤销时会递归删除同批内容）」 | 改写为「**仍然存在**」并说明回退原因与现行缓解手段 |
| D2 | `docs/markai-coverage.md` §三 | 同一段里三个数字打架：「82 项」「93/93」「现已增至 96 项」 | 统一为实测的 **97 项**，耗时按 2026-11-01 实测更新 |
| D3 | `docs/markai-coverage.md` §六 | 表格被一个空行截断，后半张表脱离了表头 | 修复表结构，并补一行「补整理与自动整理同时发生（已互斥但无 e2e）」 |
| D4 | `.gitignore` | 只挡了 `promo-line/`、`promo-15s/`；后续新建的 `promo-direction/`(1.9M) `promo-fold/`(27M) `promo-gate/`(16M) `promo-v2/`(6.4M) **全部没挡**且历史从未跟踪——一条 `git add -A` 就会把 **47MB 过程素材**灌进版本库 | 补上四个目录（附原因注释），并把 `.pi/` 一并排除 |
| D5 | `docs/changes-summary.md` | 规模写「29 个文件 / +3064 −225 / 20 个新文件」，实际 30 / +3129 −230 / 27 | 以本次审计后的真实值更新 |
| D6 | `scripts/e2e-smoke.mjs` | 补整理的规模用例只断言 `text.includes(' 条散落')`，**不校验数字**——B2 那个错数字因此一直是绿的 | 新增断言：按同一规则自己算一遍真实条数，与面板文案里的 N 逐字比较，且要求 `>= 2` |

---

## 6. 修复前必红的验证记录

每条都实测过「回退修复 → 用例转红 → 恢复 → 转绿」，不是看着代码推断的：

| 缺陷 | 回退后的失败信息 |
| --- | --- |
| B1 | `模型失败没有被上报 → 连续失败计数不会累加` |
| B2 / B5 | `窗口应当被下一个未处理的书签填满`（`'b9' !== 'b4'`） |
| B9 | `latest 取时间最新的成功记录，不依赖输入顺序`（`'t2' !== 't1'`） |
| B10 | `完整主机名必须命中「阅读」` |
| B11 | `屏幕上应当仍是最早那个`（第二个请求覆盖了第一个） |
| B2（e2e 侧） | 回退 UI 的调用后，真实浏览器里面板显示 `{"shown":99,"actual":2}` —— **显示 99 条、实际只会处理 2 条** |

单测通过项数：**637 → 643**（新增 T98 六条）。e2e：**96 → 97**（新增那条会校验数字）。

B3 / B4 / B6 / B7 / B12 / B13 / B14 / B15 属于时序、判据统一或代码组织类：
它们没有各自独立的红绿用例，但都落在同一处已断言的行为上（撤销点、引导名额、toast 触发条件），
回退它们的直接后果是上述用例或既有 e2e 变红。这一点如实记在这里，不假装每条都有独立用例。

---

## 7. 审计后仍未做的事（如实写）

| 项 | 原因 |
| --- | --- |
| 补整理的撤销粒度（整批一个点） | 技术上能合并，但撤销「新建文件夹」是递归删除，会伤到同批已移入的内容（实测 124 条只 restored 5）。**方案已回退，当前每条一个点 + 「撤销全部 N 步」** |
| B3 时序的 e2e 覆盖 | 要稳定构造「补整理跑到一半时收藏新书签」并在 CDP 里对上时序，成本明显高于收益；已登记在覆盖清单 §六 |
| `justHappenedId` 的高亮不会自动消退 | 用的是渲染期 `Date.now()`，只在下次重渲染时重算。面板本来就会随 storage 变化刷新，实际感知不到 |
| Agent 对话全流程 / 真实模型 | e2e 里不跑（需要真实服务商） |
| 更深层的拖拽路径 | 文件夹深拷贝只测了二级子文件夹 |
