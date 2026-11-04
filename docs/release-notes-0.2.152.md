# v0.2.152 — 假警报：用户去找那 100 条，永远找不到

## 缺陷

v0.2.151 给「待删列表超过 2000 条」加了提示，但 `dropped` 算的是
`merged.length - 上限`，**不区分被挤掉的是什么状态**。

而 `pendingDeletions` 数组里混着三种状态：

| 状态 | 含义 |
|---|---|
| `pending` | 用户还没看到 |
| `executed` | 已经删了 |
| `declined` | 用户拒绝了 |

`resolveDeletions` 只改 `status`、**不删条目**，所以处理完的记录永久留在数组里。
超限时 `slice(-2000)` 挤掉的是**最旧**那批——大多数情况下是死记录。

于是：

1. 用户清理完一大批（2000 条全变 `executed`/`declined`）
2. 再来新提议 → 挤出 100 条旧死记录
3. 弹出「待删列表已达上限，**100 条提议未列出**」
4. 用户去找这 100 条 —— **永远找不到**，因为它们本来就已经处理过了

更糟的是：`deletionsCapWarned` 是一次性 flag，被这次**假警报**消耗掉之后，
等真正丢 `pending` 提议时，反而**一声不响**。

## 实测

```
[DBG] 待处理 100 条，toasts=["待删列表已达上限，100 条提议未列出"]   ← 被挤掉的全是 executed
```

## 修法

只统计**丢失的 pending**（用户真的少看到了）：

```ts
const keptIds = new Set(kept.map((p) => p.id));
const droppedPending = merged.filter((p) => !keptIds.has(p.id) && p.status === 'pending').length;
if (droppedPending > 0 && !deletionsCapWarned) { /* 提示 */ }
else if (droppedPending === 0) { deletionsCapWarned = false; }  // 复位，下次真丢还能提示
```

挤掉死记录属于正常清理，不弹警报；`droppedPending === 0` 时把 flag 复位，
避免一次假警报把后续真警报吃掉。

## 验证

新增 1 项单测（868 → **869**）：2000 条**全部 executed** + 新来 100 条 pending →
断言新的 100 条全在 **且** toasts 为空。

**证伪**（改回不区分状态）→ 转红：

```
[DBG] 待处理 100 条，toasts=["待删列表已达上限，100 条提议未列出"]
✘ 只丢已处理记录时不该弹「提议未列出」的假警报
❌ 被挤掉的全是已处理记录…实际 toasts=["待删列表已达上限，100 条提议未列出"]
```

## 顺带：这个 flag 原本测不了

`deletionsCapWarned` 是模块级私有变量，**跨用例残留**——第一次证伪时测试没转红，
因为前一个用例已经把它置 `true`，假警报被吞掉了。加了 `resetDeletionsCapWarnedForTest()`
让用例彼此独立，证伪才真正生效。

## 数据

单测 **869**（+1）· e2e **199/199 · 121s** · tsc ✅ · build ✅
