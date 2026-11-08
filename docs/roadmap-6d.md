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
