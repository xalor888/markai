# MarkAI v0.2.26 发布说明

## 概述

v0.2.26 修掉一个**显示层恒为 0** 的 bug：中栏列表里每个文件夹的副文本永远显示
「文件夹 · 0 项」，而文件夹里实际有内容。由用户报告发现。

## 根因：数据源根本不带这个字段

中栏渲染文件夹副文本的写法是：

```tsx
文件夹 · {node.children?.length ?? 0} 项
```

但中栏的行来自两种 API：

- 浏览模式 → `chrome.bookmarks.getChildren(id)`
- 搜索模式 → `chrome.bookmarks.search(query)`

**这两者返回的 `BookmarkTreeNode` 都不填充 `children`**——MDN 对 `getChildren` 的措辞是
「不包括子文件夹中包含的任何子节点」。只有 `getTree()` / `getSubTree()` 会填充。

于是 `node.children` 恒为 `undefined` → `?? 0` → 每个文件夹都显示 `0 项`。
文件夹里有多少东西都无所谓，这不是显示逻辑写错，是**读了一个数据源不提供的字段**。

## 为什么测试从来没抓到（替身比真实 API 更慷慨）

`tests/agent.test.ts` 的 `toApi()` 会**递归补 `children`**，替身环境下的节点永远带子树。
真实 `getChildren()` 不补。这类"读 node.children"的 bug 在替身里永远绿，只有真机会暴露——
是本项目此前没意识到的测试盲区。

## 修法

1. 新增 `buildFolderChildCounts(roots)`（导出在 `src/stores/bookmarkStore.ts`）：
   输入**必须是 `getTree()` 的结果**，整树走一次建「文件夹 id → 直接子项数」索引
   （一次 O(树)，避免每行各查一次整棵树）。书签不入索引，空文件夹记 0。
2. 中栏改用 `useMemo(() => buildFolderChildCounts(roots), [roots])`，把计数以
   `folderCount` 传给 `BookmarkRow`。
3. **取不到真实数字时只渲染「文件夹」，不再渲染假的「0 项」**——把"未知"当成 0
   正是这次 bug 的形状，不能留。

## 同类位置排查（都不受影响）

| 位置 | 数据源 | 结论 |
|---|---|---|
| `bookmark-dialogs.tsx` 删除确认计数 | `findNode(roots, …)` | 取自整树，正确 |
| `move-picker.tsx` / `bookmark-tree.tsx` | 整树 | 正确 |
| `tools.ts` stats / export | `findNode` 或 getSubTree | 正确 |
| 中栏顶部 `{children.length} 项` | getChildren 返回的真实数组 | 本来就对 |

## 测试与反证

- 全量自动化测试：**481 项全绿**（478 → 481，新增 T70 三条：
  索引按直接子项计数 / 书签不入索引 / **行节点不带 children 时计数仍来自整树**）。
  T70 第三条是冲着真实 API 行为构造的——特意喂一个不带 `children` 的行节点。
- 行为级反证：共 **165 条**（164 → 165）。本版发布前对新增的那条做了定向实跑
  （`node scripts/falsify.mjs --only=中栏文件夹子项数`），**RED ✔**，
  回滚后变红的正是预期用例，恢复后全绿。全量仍未跑完（一条 ≈ 17 秒，165 条约 47 分钟），
  这一缺口继续如实记录，不当成已解决。
- 门禁：`npm run compile` ✔ / `npm test` 481 全绿 ✔ / `npm run build` ✔（853.42 kB）。

## 顺带修正

README「测试」一节的计数此前是历史漂移值（468 项 / 161 条反证），本版按实测更正为
**481 项 / 165 条**。

## 升级建议与已知事项

- **无破坏性变更**：配置、聊天与撤销记录完全向后兼容。
- **建议升级**：文件夹子项数是导航大书签库时判断"要不要点进去"的依据，恒为 0 会误导。
- **真机验证仍是空白**：证据是「替身测试 + 定向反证 + 对 Chrome API 行为的文档核实」，
  不构成在真实 Chrome 里的行为证明（P3）。
- 产物资产只有 **chrome zip**（MV3，Chrome/Edge 手动加载）；不产出 Firefox 产物——
  它从未在真实 Firefox 里装过一次，按本项目「不发没人验证过的产物」的标准不该发布。
