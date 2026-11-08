# 六天改造作战图（2026-11-08 → 2026-11-14）

> 用户目标：UI 全面现代化 + 小宠物 + Agent 大跃升 + 显示思考 + 思考强度 + models.dev 全自动模型匹配 + 真正的个人书签管家。
> 规则：不停在"计划"，只记"做完的"。每批四道门全绿才提交。

## 一、硬门（每批必过）

1. `npx tsc --noEmit`
2. `npx tsx tests/agent.test.ts`（当前基线 **883**，只增不减）
3. `npm run build`（产物基线 **1.06 MB**，新增依赖必须报增量）
4. `node scripts/e2e-smoke.mjs`（基线 **199/199**）

另加两条自订约束：

- 每个行为改动必须配一条**能转红**的守卫（先证伪，再收工）。
- 不碰数据层语义：书签、撤销事务、Agent 循环既有契约不改；要改先加测试证明旧契约错了。
- 自动修复/自动化永不改用户书签（0.2.37 立的边界）。

## 二、六天主题

| 天 | 主题 | 交付判据 |
|---|---|---|
| D1 | 模型目录与思考强度（数据层） | models.dev 可拉可取可缓存可离线；思考档位按模型能力自动给；AIConfig 落 `reasoningEffort` |
| D2 | Agent 效率与上下文 | 工具/循环/上下文效率有实测数字；并行只读工具；上下文预算 |
| D3 | UI 现代化第一波 | 设计 token 升级 + 玻璃层 + 图标体系 + 动效基础；360px 窄面板零回归 |
| D4 | 小宠物（程序化角色） | 眼睛 morph + 弹簧物理 + 状态机 + 拖拽 Q 弹；零视频资产，包体增量 < 40 KB |
| D5 | 宠物 ↔ Agent 联动 + 管家感 | 宠物随 Agent 状态工作/睡觉/思考；记忆、习惯、主动建议落地 |
| D6 | 全量回归与发布 | 四道门全绿 + 性能基线 + 包体预算 + 发版 |

## 三、进度（按批追加，最新在上）

### D4-B4 · 宠物常驻 + 一次性开心 — 2026-11-09

- Agent 头部：`Bot` 图标 → `PetFace`（26px）**常驻**。宠物是这一栏的"人"，不是一个图标
- `shouldCelebrate(prevStreaming, streaming, lastFailed)`：一轮**正常**结束才给 1.6s 的 `happy`
  - 失败/取消也走 streaming 结束，一律庆祝会"在报错后面露喜色"——比不做表情更伤信任
- 状态推导集中在**一处**（`toolRunning` + `petState`），空态与头部复用同一个值
  （两处各算一遍会算出两个不同状态，用户会看到头部在干活、空态在发呆）
- 测试 986 → **988**（+2）
- **证伪**：去掉 `!lastFailed` →「失败后面露喜色」转红

**e2e 抖动（如实记录）**：第一次跑出现 1 项失败
`流式内容及时落盘 · {"saw":false,"delta":-1571}`；第二次 199/199、第三次 199/199。
判定为门禁自身抖动（项目历史上出现过同类），同时顺手做了两件**降低抖动面**的事：
`hasRunningTool` 用 `useMemo`（messages 引用不变就不重扫）、庆祝 effect 的依赖从
`[streaming, messages]` 收窄到 `[streaming]`（messages 走 `getState()`）。
不把"跑两次就绿"当结论，但也没掩盖第一次失败。

**门**：tsc ✅ · 单测 988 ✅ · build 744ms / 1.08 MB · e2e 199/199 · 112.1s
**下一批 D4-B5**：拖拽甩抛的 Q 弹手感（dsh-pet 的那套物理），以及 reduced-motion 下的替代反馈。

### D4-B3 · 宠物跟着 Agent 真实状态走 — 2026-11-09

- `pet/state.ts` 新增 `hasRunningTool(messages)`：扫**全部** assistant 消息的 tool 块
  （只看最后一条会在「取消 / 重发留下挂着的旧块」时误判——宠物会一直"在忙"）
- `chat-panel` 空态：`petState={stateFromAgent(streaming, hasRunningTool(messages))}`
  —— 宠物状态从写死的 `idle` 变成**推导值**
- 效果：思考时眯眼、工具跑起来时呼吸加快、任务结束回待机。
  Agent 干活时宠物不再发呆——那正是用户最需要它"在忙"的时刻
- 测试 983 → **986**（+3）
- **证伪**：把 `hasRunningTool` 改成只看最后一条 →「前面还有 running 块时不能被最新一条掩盖」转红

**门**：tsc ✅ · 单测 986 ✅ · build 855ms / 1.08 MB · e2e 199/199 · 112.1s
**下一批 D4-B4**：宠物的"存在感"——让它出现在侧边栏常驻位置（不只是空态），
并在任务完成时给一次 `happy`（一次性动画，不常驻）。

### D4-B2 · 宠物渲染（SVG + rAF + 状态机）— 2026-11-09

- `src/lib/pet/state.ts`：状态 → **连续参数**（眼型 / 开合 / 呼吸幅度与周期 / 视线范围 / 眨眼间隔）
  - `stateFromAgent(busy, toolRunning)`：工具在跑 > 本轮在跑 > 空闲
    （别让宠物在长任务时"发呆"——那正是用户最需要它"在忙"的时刻）
  - `breathScale` 用正弦：天然循环无接缝，呼吸不该有"缝"
  - 睡着 `gazeRange = 0`：跟随指针会立刻"醒"
- `src/components/pet/pet-face.tsx`：SVG 多边形 + rAF
  - **零依赖**（不引 motion；整个宠物让包体只从 1.07 → 1.08 MB）
  - reduced-motion 直接静态、**不跑 rAF**（侧边栏常驻时这也省电）
  - `aria-hidden`：宠物是装饰，状态已有文字表达
  - 呼吸只压纵轴（压横轴会让脸左右抖）
- Agent 空态：`BrandMark` → `PetFace`（角色比 logo 更有记忆点）
- 测试 978 → **983**（+5）
- **证伪**：睡着 `gazeRange` 改回 3 →「睡着时跟随指针会立刻"醒"」转红

**磁盘事故（值得记）**：本轮 e2e 第一次跑被 `ENOSPC` 中断，输出正是

```
E2E 结果（不完整 · 执行中断）：72/72 已完成项通过
```

0.2.163 修的那条「崩溃不许伪装绿灯」在这一刻救了我——首行明确写着"不完整"，
否则我会把"72 项通过"当成基线绿。清理 17 个旧 zip + `git gc` 后释放到 139Mi，重跑 199/199。

**门**：tsc ✅ · 单测 983 ✅ · build 847ms / 1.08 MB · e2e 199/199 · 112.5s
**下一批 D4-B3**：宠物接入真实 Agent 状态（busy/toolRunning 联动），从"会眨眼"变成"会陪你干活"。

### D4-B1 · 宠物眼睛（纯数据层）— 2026-11-09

新增 `src/lib/pet/eyes.ts`（纯函数，渲染留给 B2，所以每条规则都能单测）：

- 5 套眼型（`normal` / `happy` / `squint` / `tired` / `heart`），归一化 8 点多边形
  —— 不用图片、不用 Lottie、不用视频
- `lerpPoly`：点数不等**抛错**（截断出来的形状会静默变形，动画里表现为"眼睛抽搐"，极难归因）
- `applyLid`：只压 y 不压 x（否则眨眼时眼睛会左右抽动）；下限 **0.04**（留一条缝，不是压没）；
  上限 **1.08**（眨眼过冲那一下的手感）
- `queueBlink` / `consumeBlink`：闭 70ms → 过冲 1.08 → 回落 1.0；**14% 概率双眨**
  （每次都单眨反而机械）；一帧可连消费多条（掉帧时不积压）
- `gazeOffset`：近处 0.28 倍距离、远处饱和到 maxRadius（完全线性会把瞳孔甩出眼眶）
- `shapeOf`：未知状态名回落 `normal`（宠物不该因为一个拼错的状态名崩溃）

为什么不用 dsh-pet 的素材路线：它靠 100+ 段透明视频，一段就几百 KB；
程序化眼睛整套 < 5 KB，还能随状态**连续变形**（视频只能离散切换）。

测试 972 → **978**（+6）
**证伪时抓到第二个假守卫**：断言里用了 `LID_MIN` 常量本身，改常量测试跟着改，永远绿。
改成钉字面值 `0.04` 后，注入缺陷立刻转红。（第一个假守卫在 D3-B1 的深色切片。）

**门**：tsc ✅ · 单测 978 ✅ · build 979ms / 1.07 MB · e2e 199/199 · 113.2s
**下一批 D4-B2**：把眼型画成 SVG（`PetFace`），带 rAF 循环与 reduced-motion 降级。

### D3-B6 · 视觉回归审计（D3 收口）— 2026-11-09

- 跑通 `scripts/visual-audit.mjs`（CDP，无第三方依赖）：**15/15 张截图落盘**到 `.output/visual/`
- **发现审计素材本身不真实**：种子里书签栏只有一个文件夹 → 列表是空的 → 浮层盖在空白上，
  玻璃"没有东西可糊"，截图看起来和实心白卡一模一样。补齐 10 个书签（带幂等判断，重复跑不重复注入）
- **深色浮层边界几乎看不见**：`--glass-border` 10% 在近黑底上等于没有 → 提到 **16%**，浮层边界才分得出来
- 结论记下（写进设计约束，免得以后有人问"为什么玻璃看不出来"）：
  **玻璃在半透明 + 平坦背景上必然接近实心，它的效果依赖背后有内容**。
  这条同时解释了为什么玻璃只能用在浮层——浮层才有东西可糊
- 测试 970 → **972**（+2）
- **证伪**：边框改回 0.1 →「深色玻璃边框足够可辨」转红

**门**：tsc ✅ · 单测 972 ✅ · build 1.275s / 1.07 MB · e2e 199/199 · 113.5s
**D3 完成（6/6）**。下一批 D4-B1：小宠物的「眼睛」——从 grok-icon-study 的多边形眼 morph 移植，
纯 SVG、零依赖、不用任何视频资产。

### D3-B5 · 窄面板密度（先量，结论是不调）— 2026-11-09

新增 `scripts/measure-density.ts`（离线，从源码解析行高，不硬编码）：

```
行高 h-10 = 40px · 600px 面板 → 11 行 · 800px → 16 行 · 1000px → 21 行
若改 h-9(36) → 18 行 / h-11(44) → 14 行
```

- **结论：不调行高**。40px 是桌面端的舒适值；低于 32 点不准（触控与精细鼠标都不稳），
  高于 44 一屏放不下几行。要提升"信息密度"应该靠折叠/分组，而不是把行压扁。
- 守卫：行高必须落在 32–44px；窄宽度回归（360/300/260 三档）必须仍然出现在 e2e 里
- 测试 968 → **970**（+2）
- **证伪**：改成 h-7（28px）→「低于 32 的可点击区底线」当场转红

**门**：tsc ✅ · 单测 970 ✅ · build 1.078s / 1.07 MB · e2e 199/199 · 114.1s
**下一批 D3-B6**：视觉回归审计（浅/深两套截图 + 玻璃层叠在三种底色上的实际观感），D3 收口。

### D3-B4 · 图标标尺与动效降级 — 2026-11-09

- 消灭 10px 图标：`config-form` 3 处 `h-2.5` → `h-3`
  （项目既有规矩「11px 以下一律不用」，这三处是漏网的）
- `prefers-reduced-motion` 加**通配兜底**：`animation-duration` / `transition-duration` 0.01ms
  - 用 0.01ms 而不是 0：设成 0 会让 `transitionend` / `animationend` 不触发，
    依赖事件收尾的代码（等过渡结束再卸载浮层）会永远等不到回调
- 测试 965 → **968**（+3）
  - 不许出现 `h-2.5`
  - 图标主力尺寸集中在 12/14px：实测 **93.9%**（153/163），标尺没有散
  - reduced-motion 必须有通配兜底，且不许写成 `0ms`
- **证伪**：删掉通配块 →「缺少动画时长兜底」转红

**门**：tsc ✅ · 单测 968 ✅ · build 1.615s / 1.07 MB · e2e 199/199 · 114.9s
**下一批 D3-B5**：窄面板密度——360px 宽下面板一屏能看多少行书签，先量再调。

### D3-B3 · 浮层家族收口 — 2026-11-09

- 三处浮层统一 `markai-glass`：右键菜单（`bookmark-tree`）、更多菜单（`more-menu`）、
  命令面板（`command-palette`）；加上 B1/B2 的 Toast 与对话框，浮层家族 **5 个成员**同一语言
- 刻意**不动**的一处：`workspace.tsx` 的侧栏抽屉（`h-full border-r`）—— 它是**容器**不是浮层，
  背后没有可模糊的内容，上玻璃只会糊到自己的纯色底（B1 就定下的边界，这次是实践它）
- 测试 962 → **965**（+3）：玻璃统一 / ESC 可关（4 处）/ 不再有「实心底 + 投影」的裸浮层
- **证伪**：把 more-menu 的 `markai-glass` 去掉 →「所有浮层都走同一个玻璃层」转红

**门**：tsc ✅ · 单测 965 ✅ · build 1.556s / 1.07 MB · e2e 199/199 · 113.5s
**下一批 D3-B4**：图标与动效基础——图标尺寸收成一套标尺；动效只用 CSS（不引 motion，护住包体）。

### D3-B2 · 对比度可执行 + 对话框接入玻璃 — 2026-11-09

- 新增 `src/lib/ui/contrast.ts`（纯函数）：`parseHex` / `parseCssColor` / `relativeLuminance` /
  `contrastRatio` / `composite`（半透明合成）/ `AA_NORMAL`
- 测试**从 main.css 解析真实 token** 再算，不是硬编码颜色：
  - 浅色 / 深色都按**最坏底层**（background 与 card 两者取最小）验证正文与次要文字 ≥ 4.5:1
  - 玻璃不透明度必须 ≥ 0.6（低于这个值小字号必然掉出 AA）
- 对话框（`ui/dialog.tsx`）接入 `markai-glass`
- 测试 957 → **962**（+5）
- **证伪**：把浅色 `--color-foreground` 调浅到 `#b6bcc6` →「浅色玻璃上正文只有 1.88:1」当场转红

**为什么这件事值得单独一批**：玻璃是半透明的，文字实际压在「玻璃叠在底板」的**合成色**上。
只看 token 里两色算对比度是不够的（半透明会让实际背景变亮或变暗，而 11–12px 最怕这个）。
现在这条检查是**可执行**的：谁把 token 调坏，测试会报出具体比值，而不是等人肉眼发现。

**门**：tsc ✅ · 单测 962 ✅ · build 1.067s / 1.07 MB · e2e 199/199 · 114.7s
**下一批 D3-B3**：浮层家族收口（右键菜单 / 命令面板 / Select 下拉统一用玻璃），并给「浮层必须可键盘关闭」加守卫。

### D3-B1 · 玻璃层（只在浮层用 · 全 token 化 · 有降级）— 2026-11-09

- `main.css`：新增 5 个 glass token，浅/深两套
  - 浅色 `rgb(255 255 255 / .72)`、深色 `rgb(21 26 33 / .72)`；低于 60% 时小字号在这上面达不到 AA
- `.markai-glass`：`backdrop-filter: blur(12px) saturate(1.4)` + 1px 描边 + inset 顶部高光 + 浮层阴影
  - **只用于应用内浮层**（Toast / 对话框 / 菜单）：扩展页面无法模糊背后的网页，
    玻璃放在侧边栏容器上只会糊到自己的纯色底，看起来像脏——这是最容易做反的一处
  - 抄 react-bits `GlassSurface` 的 **CSS 回退档**，不抄它的 WebGL2 着色器路径（常驻 rAF 吃 GPU）
  - `@supports not (backdrop-filter)` → 退回 `--color-card` 实心：宁可没有玻璃感，也不让文字压在透底上
- Toast 改用 `markai-glass`（去掉 `bg-card` 与 `shadow-lg`，玻璃类内部已含高光+阴影）
- 测试 952 → **957**（+5）
- **证伪时发现自己的守卫是假的**：第一版把 `.dark` 片段切到文件末尾，于是
  `.markai-glass` 里的 `var(--glass-surface)` 也被算进"深色已定义"——深色漏定义**永远测不出来**。
  改成只切到 `@layer base` 后，注入缺陷立刻转红。守卫先要能转红才算守卫。

**门**：tsc ✅ · 单测 957 ✅ · build 1.043s / 1.07 MB · e2e 199/199 · 115.3s
**下一批 D3-B2**：把玻璃层铺到对话框与右键菜单（浮层家族统一语言），并加一条
"浅色/深色对比度"的可执行检查。

### D2-B6 · 历史工具结果转写（让模型看见"查过什么"）— 2026-11-08

- 新增 `extractHistoryText(m)`：正文 + **工具结果摘要**，不含思考
  - 每条截 160 字符（保留结论"命中 12 条…"，丢掉逐条 JSON——那才是 token 大头）
  - 状态标出来（`[工具 list_bookmarks（canceled）] 已取消`），免得模型以为拿到的是完整结果
  - 不直接发 tool 块：历史里没有配对的 `tool_call_id`，直接发会 400
- **预算与发送必须用同一份文本**：`selectHistory` 的 `full` 与组装循环的 `content` 都换成它
  —— 唯一能保证"估算 = 实际发出去"的做法，否则又是一条超窗 400 的老路
- 升级上一批那条契约测试：从「历史只发 text」改成「正文 + 工具摘要 + 思考不进历史」
- 测试 947 → **952**（+5）
- **证伪**：把组装换回 `extractText` → 守卫当场转红

**预期效果**：模型重新看见那 66% 的内容。用户问「刚才那些重复的」时它不必再查一遍 ——
省一次往返，也不再显得"不记事"。这是 D2 里唯一直接改善用户可感知体验的一条。

**门**：tsc ✅ · 单测 952 ✅ · build 926ms / 1.07 MB · e2e 199/199 · 112.9s
**D2 完成（6/6）**。下一批 D3-B1：UI 现代化第一步——设计 token 升级（玻璃层），
先做可测的纯样式层，不动结构。

### D2-B5 · 历史与压缩实测（工具结果 66% 对模型不可见）— 2026-11-08

- 导出 `selectHistory` 供测量与测试（纯函数，无副作用）
- 测量脚本新增两段，三条结论：

  1. **压缩几乎不会触发**：800 条普通消息只有 14,390 tok，远低于 128K 预算的 95,742。
     只有把工具结果算进去（约 214 轮 × 447 tok）才可能触到阈值。
  2. **压缩不花往返**——它是**本地摘要**（每条截 200 字符），不额外调用模型。
     （上一轮我猜"压缩本身花一次往返"，这是错的；测量纠正了猜测。）
  3. **真正的问题在这里**：历史组装只发 `text` 块。200 轮里工具结果 **14,000 tok 全部没进请求**，
     占历史可发送内容的 **66.1%**。模型只看到三分之一的对话——这就是"记不住刚才那些重复的"
     的直接原因；用户一问，它只能重查一遍，多一次往返。

- 测试 943 → **947**（+4）。其中一条把「历史只发 text 块」钉成**显式契约**
  （历史里的 tool 块没有配对的 `tool_call_id`，直接发会 400；要改必须先改这条）
- **证伪**：把 `autoCompress` 分支改坏 → 既有守卫当场转红（「开了压缩时不该再出现'未包含在内'」）

**门**：tsc ✅ · 单测 947 ✅ · build 998ms / 1.07 MB · e2e 199/199 · 114.2s
**下一批 D2-B6**：把历史工具结果转写成**可发送的摘要消息**（不破坏 tool_call 配对），
让模型看见"查过什么"——这是最直接的"少一次往返"。

### D2-B4 · 思考也进草稿（新块把老洞捅开了）— 2026-11-08

- `stream-draft.ts`
  - `StreamDraft.reasoning?`（旧草稿没有这个字段 = 空，不做版本迁移）
  - `appendDraft(messageId, text, kind)`：思考与正文分开累积（混在一起就再也拆不开）
  - `readDraft` 读 reasoning；新增 `mergeDraftReasoning`（只往更完整方向合）
  - `finalizeDraft` 的「可重排」判断从 `kind === 'text'` 放宽到 `text | reasoning`
- `background.ts`：`chat:reasoning` → `appendDraft(..., 'reasoning')`
- `aiStore.ts`（恢复路径）：`withDraft` 按块重建 `[reasoning][text]`
- 测试 938 → **943**（+5）
- **证伪**：把 withDraft 的过滤改回 `kind === 'text'` →「含思考块的消息也必须被草稿补全」转红

**为什么必须现在做**：加 reasoning 块之前那条过滤是 `kind === 'text'`。加了之后，
**每一轮带思考的回复都会被整条跳过草稿合并**——这正是 0.2.x 修过的「切标签页丢内容」
重新裂开。新功能把老洞捅开，是这类改动最典型的翻车方式（B6 当时把它记成"已知限制"，
这一批把它补掉，并留下守卫不让它再裂）。

**门**：tsc ✅ · 单测 943 ✅ · build 1.137s / 1.07 MB · e2e 199/199 · 113.5s
**下一批 D2-B5**：上下文压缩实测（压缩前后省多少、压缩本身花多少往返）。

### D2-B3 · 工具能力分类单一来源（并行集合不再抄两份）— 2026-11-08

- 删掉 `agent.ts` 里复制的那份 `READ_TOOLS`（15 项）；并行执行与「跳过逐回次确认」统一走 `classifyTool`
- `turn-plan.ts` 导出 `READ_TOOL_NAMES`（供守卫做快照断言）
- 顺带**升级一条旧守卫**：它原本断言「两处定义必须一致」，单一来源后失去意义；
  改成「只允许定义一处 + 并行集合必须来自 classifyTool」，防的是"以后又抄一份回来"
- 测量脚本新增分类统计：**只读 15 / 写 14 / 声明 3 / 闸门 2 / 未分类 0**
- 测试 935 → **938**（+3；另有 1 条旧守卫等价升级）
- **证伪**：往 READ_TOOLS 塞 `move_bookmark` → 名单快照当场转红

**这一批纠正了一个认知**：并行只读**早就实现了**（`Promise.all` 过滤只读集合），它不是待做项。
真正值得做的是把它变成单一来源并加守卫——因为"并行集合"和"确认集合"一旦各自维护，
迟早互相矛盾（0.2.149 修过一次同类事故）。分类完整性的价值也在此：新增工具若忘了分类，
会变成 `unknown`（既不并行也不确认），测试直接拦下。

**门**：tsc ✅ · 单测 938 ✅ · build 2.328s / 1.07 MB · e2e 199/199 · 113.5s
**下一批 D2-B4**：思考草稿落盘（补 B6 记的已知限制）+ 上下文压缩的实测数字。

### D2-B2 · 目录接进上下文预算（修 B1 暴露的 8 倍缺口）— 2026-11-08

- `src/lib/models/runtime.ts`：进程内同步索引
  - `setActiveCatalog` / `lookupActiveModel` / `activeCatalogSize`
  - 同名冲突**保留先出现的**（后到的覆盖会让同一次会话里窗口忽大忽小）
  - 未预热返回 null → 调用方回落本地表（红线：目录不可用绝不能变成"没有预算"）
- `providers.getModelContextWindow`：目录优先 → 本地表兜底
  - 实测 `gpt-5.6`：128,000 → **1,050,000**（8 倍）
- `background`：SW 启动即 `ensureCatalogWarm()`（不阻塞任何动作）；`ai:catalog` 拉完立刻 `setActiveCatalog`
  （设置页看到的能力与 Agent 用的预算必须是同一份目录）
- 测试 932 → **935**（+3）
- **证伪**：删掉目录优先那两行 →「1M 模型不再被当成 128K」转红

**门**：tsc ✅ · 单测 935 ✅ · build 931ms / 1.07 MB · e2e 199/199 · 111.6s
**下一批 D2-B3**：真正的成本项——工具往返次数。先统计一轮里模型平均发几次调用、哪些只读工具可并行。

### D2-B1 · Agent 成本基线（离线测量，不调 API）— 2026-11-08

新增 `scripts/measure-agent-cost.ts`，只算每轮请求必然携带的固定开销与上下文预算：

```
系统提示词   1,203 tok
计划模式说明   143 tok（仅 planMode）
工具定义 34 个 5,455 tok   ← 固定开销的 82%
小计          6,658 tok
128K 预算：固定开销占 6.5%，历史可用 95,742 tok
一次工具往返（用户消息 + 工具调用 + 12 条结果）447 tok → 128K 能装约 214 轮
工具定义前三名：cleanup_sweep 441 / export_bookmarks 364 / auto_categorize 343
```

**测量暴露的三件事**（这才是跑这个脚本的目的）：

1. **`gpt-5.6` 被当成 128K**——本地窗口表里没有这个型号，而 models.dev 说它是 1,050,000。
   目录已经能给正确值，但 `getModelContextWindow` 还没接上它（D1 留下的缺口），
   等于给 1M 的模型只发 128K 的预算，压缩阈值提前 8 倍触发。→ D2-B2 修
2. **上下文不是瓶颈**（128K 能装 214 轮），真正的成本是**工具往返次数**：每次往返都是一次
   完整请求 + 模型重读全部工具定义与历史。优化方向因此是"少往返"，不是"少带历史"。
3. 工具定义每轮都付一次，平均 160 tok/个，最贵的 `cleanup_sweep` 441 tok。

**门**：脚本离线运行 ✅（无网络、无 API）

### D1-B6 · 思考内容可折叠展示 — 2026-11-08

- `ChatBlock` 新增 `{ kind: 'reasoning'; text }`；`ChatOutbound` 新增 `chat:reasoning` 事件
  —— 不复用 `chat:delta`：前端只能靠字符串特征去猜的写法，迟早会把正文误判成思考
- `agent.ts`：`onReasoning` → `chat:reasoning`（单独投递）
- `aiStore.ts`
  - `appendReasoningDelta`：同类型合并、换类型另起块 → 思考与正文顺序天然正确 `[reasoning][text]`
  - 16ms 合并 + `flushDeltaNow` 一并冲刷（否则工具块会插到思考前面）
  - `chat:restart` 时作废未落盘的思考（否则重试成功后新旧思考拼在一起）
  - `messageWeight` 计入思考长度（跨窗口合并时「思考更完整」的一方不能被「思考为空」覆盖）
- `message-view.tsx`：原生 `<details>` 折叠区——流式时自动展开显示「正在思考…」，结束后收起为
  「思考过程 · N 字」，`max-h-72` 内部滚动（长思考不挤走答案），`data-testid="reasoning-block"`
- 测试 927 → **932**（+5）
- **证伪**：删掉 agent 的 `onReasoning` →「解析了却不投递」转红
- **已知限制（诚实记下）**：思考内容**不落盘草稿**（`stream-draft` 只存正文），SW 被杀时会丢思考，
  正文不受影响。D2 里把 draft 扩成 `{text, reasoning}` 解决。

**门**：tsc ✅ · 单测 932 ✅ · build 2.099s / 1.07 MB · e2e 199/199 · 111.9s
**D1 完成（6/6）**。下一批 D2-B1：Agent 效率——先把现状数字打出来（工具往返次数、上下文占比、
每轮耗时），再谈优化；没有数字的「优化」一律不做。

### D1-B5 · 档位注入请求 + 思考流解析 — 2026-11-08

- `src/lib/models/request.ts`：`reasoningPayload(providerId, effort)`
  - 默认（`auto` / 未设置）**不加任何字段**——请求体一字不变，不可能因为新增思考参数把原本能用的端点打成 400
  - OpenAI → `reasoning: { effort }`；其余 OpenAI 兼容端点 → 扁平的 `reasoning_effort`
  - `none` 也要发出去（用户要的是"关掉思考"，不是"什么都不说"）
- `ai/stream.ts`：`SseResult.reasoning` + `onReasoning` 回调；`reasoning_content` 与 `reasoning` 两种字段名都认；
  与 `content` **分开累加**（思考绝不能串进气泡，这是最容易出的错）；空串增量不触发回调
- `ai/client.ts`：`StreamHandlers.onReasoning`、`AssistantTurn.reasoning`、流式与非流式请求体都注入
- 测试 922 → **927**（+5）
- **证伪**：`reasoningPayload` 去掉 `auto` 判断 →「auto 一律不加字段」转红

**门**：tsc ✅ · 单测 927 ✅ · build 1.042s / 1.07 MB · e2e 199/199 · 112.8s
**下一批 D1-B6（收口）**：思考内容在聊天里可折叠展示（`ChatBlock` 加 `reasoning` 块 + 落盘 + 增量渲染）。

### D1-B4 · 设置页接上目录（思考强度控件按能力动态给）— 2026-11-08

- `src/lib/models/control.ts`：`reasoningControl(policy, modelId)` 五种结局
  —— `effort` / `toggle` / `unsupported` / `immutable` / `unknown`，**后三种都是"不给控件"**；
  `toggleOptions()` 是 toggle 型的唯一选项来源（UI 不许再抄一遍）
- `config-form.tsx`
  - 目录加载走 background 代理；`catalogNotice` **原样显示** store 给的来源文案（缓存/离线快照/失败原因）
  - 思考强度 Field：`role="radiogroup"` + 分段按钮，`data-testid="reasoning-effort"`，非交互时 `disabled`
  - **自动匹配**：换模型即换控件——`findModel` 取该模型 policy，`pickEffort` 算出实际会发的档位；
    用户选的档位在新模型不可用时，直接提示「你选的「很高」在该模型不可用，实际按「高」发送」
- 测试 916 → **922**（+6）
- **证伪**：把 toggle 分支的 `mode` 改成 `'immutable'` →「只能开关的模型」转红
- 未做（有意挪后）：跨 provider 的模型搜索框与价格/能力徽标，放到 D1-B6（B5 先打通"真发出去"的链路）

**门**：tsc ✅ · 单测 922 ✅ · build 557ms / 1.07 MB · e2e 199/199 · 112.0s
**下一批 D1-B5**：档位真正注入请求（`client.ts`）+ 思考流解析（`stream.ts` 认 `reasoning_content`）。

### D1-B3 · 思考强度配置（白名单 + 归一化）— 2026-11-08

- `ai/types.ts`：`ReasoningEffort` 类型 + `AIConfig.reasoningEffort`（`'auto'` = 跟随模型）
- `providers.ts`：`normalizeReasoningEffort`（白名单 `auto/none/minimal/low/medium/high/xhigh/max`，其余一律 `auto`）+ `resolveConfig` 白名单接上
- `configStore.ts`：默认 `'auto'`
- 测试 913 → **916**（+3）。其中一条是**白名单完整性守卫**：从 `AIConfig` 接口源码解析出全部 15 个字段，逐个断言出现在 `resolveConfig` 的返回值里——直接防「UI 存进去、background 读出来被静默丢弃」那次历史事故
- **证伪**：把白名单里那行删掉 →「保留思考强度」当场转红

**门**：tsc ✅ · 单测 916 ✅ · build 811ms / 1.06 MB · e2e 199/199 · 112.0s
**下一批（已由 B4 完成一半）**：设置页接上目录 + 思考强度控件。

### D1-B2 · 目录缓存与加载（IO 注入，所以"失败不许伪装成功"可测）— 2026-11-08

- `src/lib/models/store.ts`
  - `encodeCatalog` / `decodeCatalog`：版本不符、结构坏一律 → `null`（**不做"尽力修复"**：半份目录比没有更危险）
  - `isCatalogFresh`：内置快照（`fetchedAt=0`）永不算新鲜；时钟回拨也按不新鲜（宁可多拉一次）
  - `loadCatalog`：缓存 → 联网 → 失败退旧缓存 → 再退内置快照；每一步都把「这份数据来自哪」写进 `error`
  - `describeFetchError`：超时 / 网络 / HTTP 状态分开说人话
  - `fetchCatalogJson`：30s 超时，**只在 background 用**（避免侧边栏与设置页各自拉 5.7 MB）
- 协议新增 `ai:catalog` / `ai:catalog:result`（`ok = error === null`，`refreshed` 与 `error` 各自独立，UI 能如实标「离线快照，可能过期」）
- 测试 902 → **913**（+11），其中 6 条异步用例用 `await okA`（项目自带的守卫当场抓到我第一版写成 `ok(... async)` 不等待）
- **证伪**：把失败分支的 `error` 改成 `null`（静默假装成功）→「拉取失败但有缓存」当场转红，还原复绿

**门**：tsc ✅ · 单测 913 ✅ · build 663ms / 1.06 MB（background 216 KB）· e2e 199/199 · 112.6s
**下一批 D1-B3**：`AIConfig.reasoningEffort` + `resolveConfig` 白名单 + 迁移（白名单漏项正是 0.2.x 踩过的坑）。

### D1-B1 · models.dev 目录层（纯逻辑）— 2026-11-08

- 新增 `src/lib/models/types.ts`：目录模型/Provider/思考档位的统一形状
- 新增 `src/lib/models/catalog.ts`：
  - `normalizeCatalog()` 把 models.dev 的 `api.json` 压成内部形状（丢掉用不上的字段）
  - `resolveReasoningPolicy()` 把 `toggle` / `effort` / 空数组三种形态归一成"UI 该怎么画"
  - `canonicalProviderId()` 把本地 preset id（`moonshot`/`zhipu`）对齐 models.dev 的 `moonshotai`/`zhipuai`
  - `fallbackCatalog()` 内置最小快照：断网/接口挂了也不至于"一个模型都没有"
- 单测：真实 `api.json` 片段 + 边界（缺字段、空 options、未知 provider）

**当前状态 ✅ 四道门全绿**：tsc ✅ · 单测 **902**（+19）· build 620ms / 1.06 MB（未接线，tree-shaken 无增量）· e2e 199/199 · 111.2s
**证伪**：把 `resolveReasoningPolicy` 改成「见到 toggle 就停」→ 「同时给 toggle 与 effort」当场转红；还原后复绿。



### D1-B1 之前 · 调研结论

- 本地 `providers.ts` 的模型清单已经**过期**：`deepseek-chat` / `deepseek-reasoner` / `kimi-k2` / `kimi-latest` 在 models.dev 里已查不到（新版改成了 `deepseek-v4-*` / `kimi-k2.7-*`）。这本身就是"必须接目录"的证据。

## 四、技术事实（调研得出，别重新发明）

- `https://models.dev/api.json`：5.7 MB / 235 providers / `access-control-allow-origin: *`
- 模型字段：`reasoning`、`reasoning_options`（`{type:"toggle"}` 或 `{type:"effort",values:[...]}` 或 `[]`）、`interleaved.field`（**思考流字段名**，实测为 `reasoning_content`）、`limit.{context,input,output}`、`cost.{input,output, cache_read}`
- 本地 preset 与 models.dev 的 id 不一致，需映射：`moonshot→moonshotai`、`zhipu→zhipuai`
- grok-icon-study：程序化角色（`eyes.js` 多边形眼 morph + blink queue、`pose.js` gaze、`math.js` spring/lerpPoly/centroid、`tables.js` 25 眼型/18 身形/弹簧表）
- dsh-pet：视频驱动桌宠，可借鉴的是**状态机与手感**（待机呼吸/随机动作/拖拽甩抛/Q 弹），不是它的素材（100+ 视频塞不进扩展）
