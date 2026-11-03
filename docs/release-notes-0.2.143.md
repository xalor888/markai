# v0.2.143 — 取消只对 4 个工具有效

## 缺陷

0.2.141 加了 `executeTool` 的 `signal`，0.2.142 补了 3 个检测/移动类工具。
但**其余含长循环的工具一个都没接**。系统性扫了一遍 `src/lib/ai/tools.ts`：

| 工具 | 长循环 | 之前接 signal？ |
|---|---|---|
| `auto_categorize` | 156 行，双层循环 + 10 并发池 | ❌ |
| `dedupe_bookmarks` | 104 行，批量删除 | ❌ |
| `merge_folders` | 59 行，逐条移动 | ❌ |
| `sort_folder` | 逐条重排 | ❌ |
| `delete_all_bookmarks` | 全树收集 + 批量删 | ❌ |
| `propose_deletions` | 逐条删 | ❌ |
| `create_bookmarks` | 批量建 | ❌ |
| `export_bookmarks` | 遍历导出 | ❌ |
| `find_duplicates` / `stats` / `list_*` | 遍历 | ❌ |

`auto_categorize` 移动 1 万条书签（外层分组 + 内层 10 并发）——
用户点取消，它会**一直移完**。

## 修法

给所有含长循环的工具接上 signal，并在**两个位置**检查：

1. **入口**：堵住所有早退分支（如 `sort_folder` 的「子项不足，无需排序」）——
   那些分支在循环之前返回，不检查就等于取消无效
2. **循环内**：每轮检查一次

抽了个 `makeAbortCheck(signal)` 避免 11 处重复实现。

另外 `dedupe_bookmarks` 的 `catch {}` 会把取消错误当成"单条失败"吞掉——
把检查点放在 `try` **外面**，取消才会真正冒出去。

## 验证

新增一条**整类兜底**的测试：枚举所有含长循环的工具，signal 已取消时必须抛「已取消」。

```
PASS 所有含长循环的工具都能被取消打断（整类兜底）
```

这条测试**当场抓出 4 个漏网的**（`sort_folder` / `auto_categorize` / `dedupe_bookmarks` /
`propose_deletions`）——正是入口检查缺失导致的。

**证伪**（去掉 `sort_folder` 的入口检查）→ 转红：

```
✘ 所有含长循环的工具都能被取消打断（整类兜底）
❌ 这些工具在 signal 已取消时仍然照常执行：sort_folder(6ms, 正常返回)
```

以后有人新增一个长工具却忘了接 signal，这儿就会红。

## 数据

单测 **856**（+1）· e2e **199/199 · 116s** · tsc ✅ · build ✅
