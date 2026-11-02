# v0.2.46 — 「收藏到书签栏」其实存到了「其他书签」

## 问题

弹出窗里那个按钮，鼠标悬停的提示写着：

> 收藏当前标签页到**书签栏**

但它调用的是：

```js
chrome.bookmarks.create({ title, url })   // 没有 parentId
```

Chrome 在**不传 parentId 时，默认落到「其他书签」**。

实测（headless）：

```
创建后的 parentId = "2"   ← 其他书签
根文件夹 = ["1:书签栏", "2:其他书签"]
```

所以你点完「收藏当前页面」，去书签栏里找——找不到。它会躺在「其他书签」里。

## 修法

把这段逻辑从 popup 里抽到 `src/lib/bookmarks/save-tab.ts`，显式解析书签栏的 id 再传：

```js
const tree = await chrome.bookmarks.getTree();
const barId = tree[0]?.children?.[0]?.id;   // 虚拟根的第一个孩子就是书签栏
await chrome.bookmarks.create({ parentId: barId, title, url });
```

不硬编码 `'1'`：虽然 Chrome 一直这么做，但那是实现细节。

## 为什么这么久没被发现

**测试的 mock 写错了。**

mock 里是 `parentId: opt.parentId ?? '1'` —— 默认值给了「书签栏」，
与 Chrome 的真实行为**正好相反**。于是任何"忘了传 parentId"的代码，
在测试里都会表现得完全正确。

这一条比 bug 本身更重要：**测试替身不忠实，比没有测试更危险**，因为它会给你虚假的安全感。

mock 已改成 `?? '2'`，与 Chrome 一致。改完 733 项旧测试全绿——说明没有测试依赖那个错误默认值。

## 顺带：弹出窗第一次有了自动测试

弹出窗是用户点得最多的入口，但 e2e 里**一次都没打开过**。现在覆盖 4 条：

- 能正常渲染（不是白屏、没掉进错误边界）
- 版本号与 manifest 一致
- 待办卡片与整理卡片都在
- 整理摘要读的是真实 storage 数据（种 2 条 → 显示 2）

## 回归

T111 四条：

- 必须显式进书签栏（证伪时报 `应进书签栏(id 1)，实际 2`）
- 重复网址不重复创建
- **子串相近但不同网址不算重复**（`search` 是子串匹配，必须再比一次 url）
- 非 http(s) 页面不收藏

## 数据

单测 **737**（+4）· e2e **43 项**（+4）· tsc ✅ · build ✅
