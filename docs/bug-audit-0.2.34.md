# 0.2.34 缺陷审计与修复

> 对象：`main` 分支工作树上已发布 0.2.33 之后的那批未提交改动（自动整理体系、时间线、
> 整理记录、E2E 等），做一次**独立复读**后的缺陷修复。
>
> 不 commit、不 push、不新增功能、不做无关重构；每处修复都配一条**修复前必红**的回归测试，
> 并逐条实测反证。结论：**15 处缺陷已修**（11 处用户可见 + 4 处工程/证据链），
> 新增 19 条断言，四道门现状 `tsc ✅ · 单测 662 ✅（基线 643）· build ✅ 962 kB`。

---

## 0. 怎么找到这些问题的

上一轮（[bug-audit-0.2.33.md](./bug-audit-0.2.33.md)）的审计对象是**新写的功能**；
这一轮的审计对象是**已经"看起来没问题"的旧代码**。方法是把三个层分头通读一遍
（引擎层 / UI 层 / 测试与脚本层），再把每一处"注释承诺的行为"和"代码实际的行为"逐条对照。

这样找到的问题有个共同特征：**测试全绿、构建全绿、功能"能用"**，但用户的真实体验是坏的。
`favicon` 那条尤其典型：它在外发数据，而没有任何测试会失败——因为没有测试测过"请求发给了谁"。

---

## 1. 修复一览

| # | 缺陷 | 严重度 | 用户可见后果 |
| --- | --- | --- | --- |
| **B1** | favicon 每行把书签域名发给 Google，而隐私文档承诺"不上传第三方" | **高**（但结论是**改文档，不改实现**——见 §2.1） | 承诺与实现不一致 |
| **B2** | 双击标题重命名必先开一个标签页 | 中 | 每次改名多留一个后台页 |
| **B3** | 拖拽调面板宽度每个 pointermove 写一次 storage | 中 | 大库下拖拽掉帧；写入量无意义 |
| **B4** | 面板宽度三处钳制值不一致 | 中 | 完整页调 640 → 侧边栏一拖就跳 |
| **B5** | `MessageView` 每条消息订阅整棵 `roots` | 中 | 任一次书签刷新 → 全部历史消息重渲染 |
| **B6** | 列表行选中判断是 O(n×m) 线性扫描 | 中 | 1200 条全选时百万级比较铺在渲染热路径 |
| **B7** | 右键菜单按 196px/28px 估算定位 | 低 | 12 项菜单从视口底部溢出约 50px |
| **B8** | `useCallback` 靠 WXT auto-import 兜住 | 中 | 换构建器/关 auto-import 即 ReferenceError |
| **B9** | 待删清单 `seenIds` / `initialSelectDone` 死代码 | 低 | 误导后来者以为还有"只勾新增项"逻辑 |
| **B10** | "一次最多打开 25 个"硬编码 6 处 | 低 | 改一处忘一处 → 实际 25、提示写别的数 |
| **B11** | 两个入口各写一套 seed 消费（≈60 行逐字重复） | 低 | 修一处忘一处 → 一个入口丢右键指令 |
| **B12** | `ok()` 对 20 条异步用例不 await | 中 | 失败时用例名丢失 → 反证脚本按名匹配落空 |
| **B13** | 隐私文档未披露图标外发 | 高（与 B1 配套） | 文档与实现冲突 |
| **B14** | 反证脚本的证据链缺口（同 B12） | 中 | `falsify.mjs` 的 `expectFail` 可能对不上 |
| **B15** | 本轮新增测试自身的守卫陷阱 | 低 | 守卫误伤注释，逼后来者删注释 |

---

## 2. 重点缺陷详述

### B1｜favicon 把域名发给 Google，而隐私文档承诺"不上传第三方"

> **这一条修了两次。第一次的修法是错的，回滚了。完整经过留在这里，因为它比结论更有用。**

- **位置**：`src/components/common/favicon.tsx`
- **最初判断**：图标源是 `https://www.google.com/s2/favicons?sz=32&domain=<host>`，
  书签树/列表/时间线/待删清单/整理记录**五处**都用它——每渲染一行，就把该行站点的
  **域名**发一次。而 [privacy.md](./privacy.md) 写的是「不上传你的书签库到开发者或第三方，
  除了你选的模型服务商」。书签域名属于书签库。这不是偏好问题，是**文档在承诺代码没做到的事**
  ——恰好是这个仓库最在意的那类问题（T29 系列守着文档与 manifest 不漂移，却漏了这条真正外发的路径）。
- **我第一次的修法**：换成 Chrome 自带的本地图标源 `chrome.runtime.getURL('/_favicon/?pageUrl=…')`，
  新增 `favicon` 权限，同步两份文档。编译过、662 条断言过、e2e 97/97 过。
- **为什么这个修法是错的（实测）**：`_favicon` **只查本机浏览历史里的 favicon 缓存**。
  对从未访问过的站点——包括从别处导入的书签、很久没打开的站——它返回的是
  **Chrome 内置的同一张默认灰球**，而且是 `200 OK`。探测结果：

  | 请求 | 状态 | 字节 |
  | --- | --- | --- |
  | `github.com` | 200 | 601 |
  | `news.ycombinator.com` | 200 | 601 |
  | `tailwindcss.com` | 200 | 601 |
  | `nonexistent-domain-xyz123.com` | 200 | 601 |

  四者 PNG **字节完全相同**（头部指纹一致）——就是那张灰球。

  更糟的是它骗过了组件自己的兜底逻辑：`<img>` 的 `onLoad` 照常触发，于是
  `loaded=true`、首字母占位被隐藏，整列变成一模一样的灰球。**比没有图标更差**，
  因为再也分不出哪行是哪个站。截图见证：8 行书签全部同色灰球。
- **回滚与最终修法**：图标源改回 Google s2（功能恢复），**把改进放在文档上**——
  在 privacy.md 明确写出：图标来自 Google、请求里只带域名、不带标题/完整网址/收藏时间、
  Google 能看到"这台机器问过哪些站的图标"但看不到具体页面，并给出"想彻底断开就改
  `src` 返回空串"的做法。`favicon` 权限一并撤掉（用 Google s2 不需要）。
- **为什么会搞错**：我把"文档不许撒谎"读成了"实现必须按文档改"。实际上两条路都对——
  要么改实现，要么改文档。**代价小、收益大的那条是改文档**：图标是给人看的核心体验，
  为一个域名把整列图标变成灰球，是拿功能换心安。
- **验证**：T99 三条守卫（外发必须在 privacy.md 披露 / 不残留 `favicon` 权限 /
  本地图标源的实测结论必须留在注释里防后人再踩）。反证实测：删掉 privacy.md 那段 → 变红。
- **收尾证据**：重建 + 重截图后，时间线那 8 行恢复成「真实图标 + 首字母兜底」的混合状态
  （Hacker News 橙、GitHub 猫头、MDN 紫色首字母 `D`）——与改动前一致。
  缺陷申报者的原话是对的：*"插个图标没啥问题吧"*。

### B2｜双击重命名必然先打开一次链接

- **位置**：`src/components/bookmark-list/bookmark-list.tsx:1119`、`src/components/sidebar/bookmark-tree.tsx:426`（旧）
- **根因**：书签行是**单击即打开**，标题又支持**双击重命名**。旧实现用一个 350ms 的
  `lastClickAt` 去抖"忽略第二次 click"——但**第一次 click 已经执行了打开**。
  浏览器的事件顺序是 click → click → dblclick，所以去抖只是把后果从"开两个标签页"
  降成"开一个标签页"。原注释写的是"避免双击标题时先开两个标签页"，
  它描述的正是这个被误认为已解决的问题。
- **修法**：把「打开」本身推迟到双击窗口之后。新增 `src/lib/bookmarks/delayed-open.ts`：
  `schedule()` 排一次打开，`cancel()` 取消（双击到达时调用），`dispose()` 在卸载时清理。
  窗口取 250ms（它是"单击打开"的可感知延迟，主流系统双击阈值下限也在 250 附近）。
  **文件夹不进这条路径**——展开/选中必须即时，且双击文件夹没有第二语义。
- **验证**：T99 四条（双击取消后一次都不打开 / 单击只打开一次 / 连续 schedule 只开一次 /
  dispose 后不打开）。反证实测：把 `cancel` 改成空函数 → 变红。

### B3+B4｜面板宽度：每个 pointermove 写一次 storage，且三处钳制互相打架

- **位置**：`src/components/workspace/workspace.tsx:68,413,436`（旧）、`workspace.tsx:64`（旧加载钳制）
- **根因（两个独立问题叠在一起）**：
  1. `persistChatWidth` 既 `setState` 又 `chrome.storage.local.set`，而它被挂在
     `onResize` 上——拖一次面板触发几十上百次 storage 写入；
  2. 宽度上限写了三套：加载时钳 `200–640`、完整页拖拽钳 `200–640`、侧边栏拖拽钳 `200–560`，
     渲染又用 `maxWidth: min(100%, 560px)`。于是"在完整页把面板拖到 640，再打开侧边栏"，
     内部宽度是 640、视觉是 560，**一按拖拽手柄就跳**。
- **修法**：抽出 `src/lib/chat-width.ts`（`CHAT_WIDTH_MIN/MAX/MAX_COMPACT` + `clampChatWidth`），
  全应用只留这一份口径；拖拽中只改 state/ref，**松手（onDragEnd）才落盘**；
  加载时按**当前形态**重新钳制（旧值来自另一种形态也能纠正）。
  非有限数（`NaN`/`±Infinity`）一律回落下限——否则 CSS 会拿到 `NaNpx`，面板整个消失。
- **验证**：T99 五条（compact 下 640→560 / 完整页 4096→640 / NaN 与 ±Infinity→下限 /
  上限小于下限时取下限 / 两个上限的相对关系）。反证实测：把 `upper` 写死 640 → 变红。

### B5｜`MessageView` 每条消息订阅整棵书签树

- **位置**：`src/components/chat/message-view.tsx:166`（旧）
- **根因**：组件用 `useBookmarkStore((s) => s.roots)` 订阅整个数组。每次 `loadTree()` 都是新引用，
  于是**任何一次书签刷新都会让全部历史消息重渲染**。组件上的 `memo` 比的是 props，
  对 store 订阅完全无效——它一直在白付。
- **修法**：改成 selector 只返回**这条消息自己那条上下文路径的字符串**（用 `useCallback`
  固定 selector 引用）。路径没变的消息拿到同一个原始值，不触发重渲染。
- **验证**：T99「MessageView 不再订阅整棵 roots」。

### B8｜`useCallback` 靠 WXT auto-import 才编译得过

- **位置**：`src/components/bookmark-list/bookmark-list.tsx:2`（旧）
- **根因**：文件里 11 处调用 `useCallback`，但 react import 行里没有它——
  `tsc --noEmit` 与 `build` 都能过，是因为 WXT 把整个 React 注入成了全局
  （`.wxt/types/imports.d.ts:21`）。同仓其它文件都显式 import。
  一旦关掉 auto-import、或换构建器、或把该文件搬出 WXT 项目，就是运行时 `ReferenceError`。
- **修法**：显式 import。
- **验证**：T99「bookmark-list 显式 import useCallback」。

### B12+B14｜测试 harness 对 20 条异步用例不 await（证据链缺口）

- **位置**：`tests/agent.test.ts:593`（`ok()`）+ 20 处 `ok(name, async () => …)`
- **根因**：`ok()` 是同步函数，拿到 async 函数返回的 Promise 就丢掉了。
  断言在 `ok` 返回**之后**才结算，而 `passed++` 与 `✔` 已经打印。
  用例若失败，异常变成 unhandledRejection（进程崩在别处，报告里看不到是哪一条），
  `scripts/falsify.mjs` 按 `expectFail` 匹配**用例名**就落空。
  也就是说：这 20 条不是"假绿"（进程确实会非零退出），而是**证据链断了一节**。
- **修法**：新增 `async function okA()`，把 20 处改为 `await okA(...)`；✔ 只在断言真的通过后打印。
- **验证**：T99「测试自身不再出现 `ok(name, async …)` 这种不等待的写法」（守卫正则扫自身）。
  改造后重跑全量：662 项仍全绿——说明这 20 条本来就是通过的真用例，
  现在只是把"通过"这件事变成了**可归因**的。

### B7｜右键菜单按估算尺寸定位

- **位置**：`src/components/sidebar/bookmark-tree.tsx:1113-1116`（旧）
- **根因**：宽度按 `w-52` 估成 196px（实际 208px），行高按 28px 估（实际 `py-2` + `text-xs`
  行高约 33px）。12 项菜单累计误差约 50px，会从视口底部溢出去，最后几项被
  `max-h` + `overflow-y` 兜住（能滚，但一打开就看不到全貌）。
- **修法**：`useLayoutEffect` 里 `getBoundingClientRect()` **实测**后再落位。
  layout effect 在绘制前执行，所以看不到跳动。
- **验证**：T99「右键菜单按真实 DOM 尺寸定位」（守卫源码：不得再出现 `innerWidth - 196`）。

### B11｜两个入口各写一套 seed 消费逻辑

- **位置**：`src/entrypoints/sidepanel/main.tsx:66-97` 与 `src/entrypoints/page/main.tsx:99-130`（旧，逐字重复）
- **根因**：`consumeSeed` / `queueSeed` 完全复制。修一处忘一处就会变成
  「主入口修好了、另一个入口还在丢右键指令」，而这类不一致在 review 里极难看出来。
- **修法**：抽出 `src/lib/chat/seed.ts`；两个入口只 import。排队订阅仍然**只建一次**
  （`useAIStore.subscribe` 没有去重，重复订阅会重复发送同一条队首指令）。
- **验证**：T99「侧边栏与完整页的种子消费逻辑只有一份」。

### B9/B10｜死代码与硬编码

- `deletions-dialog.tsx:47,56` 的 `seenIds` / `initialSelectDone` 已无任何读取
  （逻辑早改为由 `uncheckedIds` 反向派生），删掉，避免后来者以为还有"只勾新增项"。
- `MAX_OPEN_AT_ONCE = 25` 原先硬编码在 6 处（3 个打开分支 + 3 处提示文案）。
  改成常量 + `tooManyToast()`，让"实际开了几个"和"提示说几个"不可能不一致。

---

## 3. 反证记录（修复前必红，实测）

| 回滚的修复 | 首个失败用例 | 判定 |
| --- | --- | --- |
| `cancel` 改成空函数 | 双击取消后书签一次都不打开 | **RED ✅** |
| 宽度上限写死 640 | 侧边栏上限下 640 被钳成 560 | **RED ✅** |
| 删掉 privacy.md 的图标披露段 | favicon 的域名外发必须在 privacy.md 里如实披露 | **RED ✅** |
| 在 wxt.config.ts 加回 `favicon` 权限 | 不再申请 favicon 权限 | **RED ✅** |

> 补充一条上一轮留下的证据：把 `permissions.md` 的清单改回不带某项时，**先红的是改动前
> 就存在的 T29 全量一致性守卫**——说明「文档 ↔ manifest 不漂移」这条纪律一直有效，
> 新权限/新条目自然被它接管。

> ⚠️ **一条已经作废的反证**：B1 的第一版修法（改本地图标源）当时也配了反证
> 「favicon 组件不再请求任何第三方图标服务」，它确实能红——**但它守的是一个错的目标**。
> 测试通过不等于方向对：那条断言会让后人不敢改回 Google s2，哪怕改回来才是对的。
> 换成"必须披露"之后，断言测的是**承诺与实现是否对得上**，而不是"用了哪个源"。

---

## 4. 四道门（2026-11-01 实测）

| 门 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **✅ 退出码 0** |
| `npx tsx tests/agent.test.ts` | **✅ 662 项全通过**（基线 643，本轮 +19） |
| `npm run build` | **✅ 962.29 kB**，`manifest.permissions` 为原始六项（无 `favicon`） |
| `node scripts/e2e-smoke.mjs` | **✅ 97/97 通过**（真机 Chrome for Testing；回滚 B1 后重跑，非旧数据） |

### e2e 结果：97/97

改动涉及真实交互（双击延迟、拖拽宽度、菜单定位、图标源），所以 e2e 是必跑项——
`e2e-smoke.mjs` 里大量点击类断言，如果它们假设"点完立即打开"，双击延迟会直接把它们打红。

结果全部通过，其中与本轮改动直接相关的：

- `拖拽：从列表拖进树里的文件夹，书签真的换了父目录` ✅
- `拖拽同层排序：拖到上一行上边缘会插到它前面` ✅（顺序 `排序C → 排序A → 排序B`）
- `Ctrl+拖拽：复制到目标文件夹，源位置仍然保留` ✅
- `Ctrl+拖拽复制整个文件夹：子树被深拷贝` ✅
- `极端书名（200 字符 / emoji / RTL / CJK / 空白 / 超长域名）：行高一致且长文本被截断` ✅
- `320px（侧边栏最小宽度）：对话框不超过视口` ✅

> 这一轮的 97/97 是在**回滚 B1 之后**的产物上重跑的（第一版的数字作废，不拿来充数）。
>
> 为什么双击延迟没打红任何一条：e2e 用 `waitFor()` 条件轮询而不是"点完立刻断言"，
> 250ms 的延迟被轮询吸收。这也说明该脚本的写法是稳的——它测的是**最终状态**，不是时序。

慢调用 Top 8 全部是 e2e 自己的页面求值（最大 6.0s 的一次对话框查询），与产品代码无关。

---

## 5. 已知未修（诚实标注）

| 项 | 为什么没修 |
| --- | --- |
| **列表/树无虚拟化** | 1200 条实测可用（README 记录了 16–35ms 首屏）。加虚拟化会重写三套键盘模型与拖放落点计算，风险远大于收益；本轮只把选中判断从 O(n×m) 降到 O(1)。**这是当前最大的性能天花板，未来若要做到上万条必须动它。** |
| **`tools.ts` 2112 行 / `bookmark-tree.tsx` 1223 行没有内聚边界** | 拆分是纯重构，会打断 `falsify.mjs` 的 174 条源码锚点（锚点按文件内容匹配），必须与反证门禁一起重做。不在"修缺陷"范围内。 |
| **React 组件层无渲染测试** | 需要引入 jsdom/testing-library，是本仓库刻意避免的依赖（测试层零依赖）。现状靠 e2e 的 DOM 断言兜。 |
| **E2E 依赖一条硬编码 macOS Chrome 路径，CI 不跑** | 需要给 CI 装 Chrome for Testing，涉及流水线改造。已如实记录在 [markai-coverage.md](./markai-coverage.md)。 |
| **chat-panel 三个覆盖层不是 Dialog（无 Esc 关闭、覆盖时输入框仍可 Tab 到）** | 属于交互设计取舍而非 bug：它们是有意的面板内浮层，不是模态框。改动会影响现有键盘模型，留待产品决策。 |

---

## 6. 本轮改动清单

**源码**
- `src/components/common/favicon.tsx` — 图标源**保持不变**（Google s2）；只补注释记下"本地图标源试过、是坏的"
- `src/lib/bookmarks/delayed-open.ts` — **新**，单击延迟打开器
- `src/lib/chat-width.ts` — **新**，面板宽度唯一口径
- `src/lib/chat/seed.ts` — **新**，种子消费共享模块
- `src/components/bookmark-list/bookmark-list.tsx` — 显式 import / 延迟打开 / 选中 Set
- `src/components/sidebar/bookmark-tree.tsx` — 延迟打开 / 菜单实测定位 / `MAX_OPEN_AT_ONCE`
- `src/components/chat/message-view.tsx` — 订阅收敛到单条路径
- `src/components/workspace/workspace.tsx` — 宽度节流落盘 + 统一钳制
- `src/components/deletions/deletions-dialog.tsx` — 删死代码
- `src/entrypoints/sidepanel/main.tsx`、`src/entrypoints/page/main.tsx` — 改用共享 seed
- `wxt.config.ts` — **未改动**（第一版加的 `favicon` 权限已撤回）
- `tests/agent.test.ts` — `okA()` + 20 处 await + T99 组（19 条）

**文档**
- `docs/permissions.md` — **未改动**（回滚时一并撤回）
- `docs/privacy.md` — **新增图标外发的如实披露**（来源、传什么、不传什么、怎么彻底断开）
