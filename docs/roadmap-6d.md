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
| D2 | 思考内容显示 + Agent 效率 | reasoning 流式渲染（可折叠、可复制）；Agent 工具/循环/上下文效率实测数字 |
| D3 | UI 现代化第一波 | 设计 token 升级 + 玻璃层 + 图标体系 + 动效基础；360px 窄面板零回归 |
| D4 | 小宠物（程序化角色） | 眼睛 morph + 弹簧物理 + 状态机 + 拖拽 Q 弹；零视频资产，包体增量 < 40 KB |
| D5 | 宠物 ↔ Agent 联动 + 管家感 | 宠物随 Agent 状态工作/睡觉/思考；记忆、习惯、主动建议落地 |
| D6 | 全量回归与发布 | 四道门全绿 + 性能基线 + 包体预算 + 发版 |

## 三、进度（按批追加，最新在上）

### D1-B1 · models.dev 目录层（纯逻辑）— 2026-11-08

- 新增 `src/lib/models/types.ts`：目录模型/Provider/思考档位的统一形状
- 新增 `src/lib/models/catalog.ts`：
  - `normalizeCatalog()` 把 models.dev 的 `api.json` 压成内部形状（丢掉用不上的字段）
  - `resolveReasoningPolicy()` 把 `toggle` / `effort` / 空数组三种形态归一成"UI 该怎么画"
  - `matchProvider()` 把本地 preset id（`moonshot`/`zhipu`）对齐 models.dev 的 `moonshotai`/`zhipuai`
  - `fallbackCatalog()` 内置最小快照：断网/接口挂了也不至于"一个模型都没有"
- 单测：真实 `api.json` 片段 + 边界（缺字段、空 options、未知 provider）

**当前状态 ✅ 四道门全绿**：tsc ✅ · 单测 **902**（+19）· build 620ms / 1.06 MB（未接线，tree-shaken 无增量）· e2e 199/199 · 111.2s
**证伪**：把 `resolveReasoningPolicy` 改成「见到 toggle 就停」→ 「同时给 toggle 与 effort」当场转红；还原后复绿。

**下一批 D1-B2**：`src/lib/models/store.ts` —— chrome.storage 缓存（24h TTL + 手动刷新）+ background `ai:catalog` 消息 + 失败时回退内置快照并如实标注来源。

### D1-B1 之前 · 调研结论

- 本地 `providers.ts` 的模型清单已经**过期**：`deepseek-chat` / `deepseek-reasoner` / `kimi-k2` / `kimi-latest` 在 models.dev 里已查不到（新版改成了 `deepseek-v4-*` / `kimi-k2.7-*`）。这本身就是"必须接目录"的证据。

## 四、技术事实（调研得出，别重新发明）

- `https://models.dev/api.json`：5.7 MB / 235 providers / `access-control-allow-origin: *`
- 模型字段：`reasoning`、`reasoning_options`（`{type:"toggle"}` 或 `{type:"effort",values:[...]}` 或 `[]`）、`interleaved.field`（**思考流字段名**，实测为 `reasoning_content`）、`limit.{context,input,output}`、`cost.{input,output, cache_read}`
- 本地 preset 与 models.dev 的 id 不一致，需映射：`moonshot→moonshotai`、`zhipu→zhipuai`
- grok-icon-study：程序化角色（`eyes.js` 多边形眼 morph + blink queue、`pose.js` gaze、`math.js` spring/lerpPoly/centroid、`tables.js` 25 眼型/18 身形/弹簧表）
- dsh-pet：视频驱动桌宠，可借鉴的是**状态机与手感**（待机呼吸/随机动作/拖拽甩抛/Q 弹），不是它的素材（100+ 视频塞不进扩展）
