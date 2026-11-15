# v0.2.170 — 整理时新子分类不再堆到书签栏根

## 现象

选中一个子文件夹（例如「软件工具」）让它整理，结果**书签栏根目录凭空多出一批分类文件夹**，
被整理的那个文件夹里反而什么都没建。整理完比不整理还乱。

## 根因（三处叠加，缺一处就不会这么糟）

1. **`create_folder` 的 `parentId` 是可选参数，省略时默认落到书签栏根。**
   这个默认值对「收藏当前页」是对的，对「整理某个文件夹」是灾难。
2. **注入给模型的上文只给了文件夹标题，没给 id。**

   ```ts
   text = `（当前上下文：用户正在查看书签文件夹「${folder.title}」）\n${text}`;
   ```

   模型知道"在整理软件工具"，但拿不到它的 id —— 于是 `create_folder` 只能省略 `parentId`，
   直接踩中第 1 条的默认值。**这是主因。**
3. **`list_bookmarks` 不传目标时读的也是书签栏。** 模型整理前先摸结构，
   读到的却是书签栏那几个兄弟文件夹，于是基于一份**错误的清单**去整理。

三处叠起来的效果：范围读错 → 决策错 → 落点错，而且每一步看起来"都执行成功了"。

## 修法

**工具层（兜底）**

- `assertFolder(parentId?, focusFolderId?)`：未指定父级时优先落在**本轮聚焦文件夹**，没有才回落书签栏。
  聚焦文件夹已被删时静默回落（不报错——模型没指定父级，报错只会让它重试同一个动作）。
- `ToolContext { focusFolderId }` 从 `runAgentTurn` → `executeTool` → 各 handler 透传；
  `create_folder` / `create_bookmark` / `create_bookmarks` / `auto_categorize` / `list_bookmarks` 全部接入。
- `create_folder` 新增 `parentPath`（与 `create_bookmarks` / `list_bookmarks` 同一口径）；
  走兜底时返回值带 `warning`，模型有机会自查"这真是我想去的地方吗"。
- `cleanup_sweep` **刻意不接入**：它只扫描不建东西，而"扫描整个书签库"是点「智能扫描清理」的明确预期。

**指令层（根因）**

- 新增 `lib/ai/context-note.ts`：上下文注入变成纯函数，两个约束写死在里面、不可漂移——
  **必须给 folderId**、**必须写明子分类建在内部**（并点明省略 `parentId` 的后果）。
- `background.ts` 把 `contextFolderId` 同时作为 `focusFolderId` 交给 `runAgentTurn`。
- 三处入口的指令都带上 id 与"建在内部"的要求：聊天起手 chip「整理此文件夹」、
  书签树右键「让 MarkAI 整理」、斜杠命令 `/整理`。
- 系统提示新增硬规则：整理某个文件夹时新子分类必须建在它内部，省略 `parentId` 会落到根目录；
  `create_folder` 的参数说明同步改写（模型只看 schema 时也不会省 `parentId`）。

## 验证

| 项 | 结果 |
| --- | --- |
| 单测 | **1088 项全过**（新增 `[organize]` 14 项） |
| `tsc --noEmit` | 通过 |

新增用例覆盖的实际行为（不是"看代码像对的"）：

- `assertFolder(undefined)` 仍回落书签栏 → **收藏场景的既有默认不变**
- `assertFolder(undefined, focusId)` → 落在 focusId；显式 parentId 永远优先
- focus 已被删除 → 静默回落书签栏，不抛错
- `create_folder` 不传 parentId + 有 focus → 建在 focus 内，`path` 写出真实落点，并带 `warning`
- 显式 parentId → 不带 warning（不无谓地吓模型）
- `parentPath` 优先于 focus 兜底
- `create_bookmark` 同样跟随 focus
- 没有 focus 的旧调用 → 仍落书签栏（向后兼容）
- `auto_categorize` 不传目标 → dryRun 不动书签栏，且统计口径是聚焦文件夹
- `list_bookmarks` 不传目标 → `folder` / `path` 指向聚焦文件夹，不返回书签栏的兄弟文件夹
- 文案构造器：带 id、带标题、要求建在内部、点明后果、给出可抄的调用形状；文件夹被删时不伪造 id；空标题不拼成「」

## 影响

- 只有「整理 / 归类」这类**带上下文**的会话受影响；
- 从 popup 收藏当前页、直接说"新建一个文件夹"（没有上下文）等场景的默认行为**没变**，仍是书签栏。
