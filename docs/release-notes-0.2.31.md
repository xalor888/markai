# v0.2.31 — 长期记忆 + 品牌标识统一 + Agent 参数容错

## 一、长期记忆（跨会话的偏好与规则）

Agent 此前每次整理都是"白纸开局"：用户说过的偏好（"技术类按语言分类"、"清理时保留最近三个月"）只在当轮对话里有效，下次会话要全部重说一遍。

### 数据层（`src/lib/ai/memory.ts`）

- `MemoryItem`：`content` + `category`（preference / rule / habit / custom）+ `enabled` + 时间戳，存 `chrome.storage.local` 的 `markai.memories`
- **查重合并**：完全相同的内容重复添加 = 激活 + 更新类型 + 刷新时间，不产生重复条目
- `getMemories()` 按更新时间降序；`searchMemories()` 内容与分类中文名都参与匹配
- `formatMemoriesForPrompt()`：只注入启用项，上限 30 条，带 `[偏好] / [规则]` 标签

### Agent 三工具（zod 严格校验）

| 工具 | 分类 | 行为 |
|---|---|---|
| `remember` | declare | 写入记忆库；同内容去重合并 |
| `recall_memories` | read（可并行） | 按关键词查询或返回全部 |
| `forget_memory` | declare | 按 id 或关键词匹配删除；无匹配如实回执 |

**为什么是 declare 而不是 write**：这三个工具只动记忆库、不动书签库，不需要用户逐次确认；`recall_memories` 是纯读，归读类可并行执行。

### 动态注入（`agent.ts`）

每轮对话从存储读取启用中的记忆拼进 system prompt 的【长期记忆】小节，并附遵守语义（"与本次新指令冲突时以新指令为准"）。`fixedOverheadTokens()` 同步计入记忆占用的 token，上下文预算与护栏不受影响；显式传入 `AgentTurnParams.memories` 快照时优先于存储（可测试、可注入）。

### 系统提示（`prompts.ts`）

新增【长期记忆机制】小节：用户表达偏好或说「记住…」「以后…」时主动调用 `remember`；说「忘记…」时调用 `forget_memory`；整理/归类/清理时主动结合已注入的记忆执行，不重复询问。

### UI 两处入口

- **设置页「长期记忆」卡片**：输入 + 类型下拉 + 添加；列表可启停（Checkbox）/ 删除 / 一键清空（带确认对话框与条数明示）
- **聊天面板工具栏 Brain 按钮**：生效数徽标；下拉面板可查看、启停、删除，空态引导"直接对我说「记住：…」"；「管理全部 →」跳设置页
- 两处共用 `useMemoryStore`，经 `chrome.storage.onChanged` **跨窗口实时同步**

## 二、品牌标识统一

此前三副面孔：`BrandMark` 用 lucide 的 `BookMarked` 占位、设置页顶栏是手写 "M" 方块、四个 HTML 页面没有 favicon（浏览器标签页显示默认图标）。

- **`BrandIcon`（新）**：与 `scripts/generate-icons.mjs` 同一几何的矢量版 —— Indigo `#4f46e5` 圆角卡片 + 白色 V 缺口书签；`fill-accent` 走主题 token，深浅色自动跟随，任意尺寸清晰
- **`BrandMark` 重写**：统一使用 `BrandIcon`，新增 `lg` 档与可选 `subtitle`，工作区顶栏 / popup / 聊天空态自动获得新图标
- **设置页 `OptionsHeader`**：删掉 "M" 方块，换 `BrandMark subtitle="设置"`
- **四个入口 HTML**（options / page / popup / sidepanel）全部补上 `<link rel="icon" href="/icon/32.png">`

## 三、Agent 参数容错（`normalizeToolArgs`）

模型传参的类型微差此前直接撞 zod 报「参数不合法」，触发空转重试。现在 `executeTool` 在校验前自动矫正：

- 字符串布尔：`"true"` / `"false"` → 布尔（dryRun / background / recursive 等）
- 数字字符串：`"10"` → `10`（limit / offset / depth / beforeYear 等）
- 单字符串数组：逗号分隔自动拆分，单个值自动包裹（ids / urls / folderIds）

## 四、测试

新增 T74（19 项）：记忆 CRUD 与查重、搜索、提示词注入（空列表/停用项/上限）、三个工具的执行与拒绝路径、参数容错、三表一致性（定义 ↔ 元信息 ↔ 分类）、Agent 集成（存储注入与显式快照）。**519 项全部通过**。

顺手修了 T72 的守卫误报：`border-dashed` 是边框线型不是颜色 token，白名单补了 `BORDER_STYLE` 关键字。

## 升级说明

无破坏性变更。旧配置无需迁移；记忆库初始为空，对话中说「记住…」即可开始积累。
