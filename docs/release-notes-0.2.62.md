# v0.2.62 — 第三处盲写：丢的是你所有能撤销的步骤

## 情况

`readUndoState()` 读失败时，返回的是：

```ts
{ points: [], terminalRunIds: [], notice: '读取撤销记录失败' }
```

`points: []` 的真实含义是**"我不知道有什么"**。

而 `endUndoTransaction()` 直接拿它当基线：

```ts
const state = await readUndoState();
const candidates = [point, ...state.points].slice(0, MAX_UNDO_POINTS);
await writeUndoPoints(...);   // ← 写回去
```

于是读失败一次，用户已有的**所有撤销点被覆盖成一个**。

后果：他再也退不回之前任何一次整理。而撤销记录里还存着**被删书签的子树快照**——
那部分数据是彻底没了。

这和 0.2.60（聊天记录）、0.2.61（API Key）是同一个结构，这是第三处。

## 修法

给 `UndoState` 加 `readError` 字段——读失败时带上原因。写盘路径检查它：

```ts
if (state.readError) {
  state = await readUndoState();      // 先原样重试一次（读失败通常是瞬时的）
  if (state.readError) {
    // 仍失败 → 放弃本次写入
    lastWriteError = { message: '…本次改动没有写入撤销历史（避免覆盖已有的撤销点）' };
    return null;
  }
}
```

**宁可少一步撤销，也不能抹掉之前所有步骤。**

中断恢复那条路径（`recoverInterruptedTransaction`）一样处理：读不到就不提升 pending，
**pending 留在原地**，下次启动读取正常时再提升——所以那段改动本身也不会丢。

## 测试

**T120** 两条：

1. 读失败 → 磁盘上 `p1,p2,p3` **一个不少**、不报告"已写入"、并给出可见说明
2. 读正常 → 旧点保留 + 新点追加到最前（没把功能改坏）

**证伪**：去掉拦截 → 「读失败时放弃写入，磁盘上已有的撤销点一个不少」立刻转红。

## 三处盲写，同一个结构

| 版本 | 存储 | 被覆盖的东西 |
|---|---|---|
| 0.2.60 | `markai.ai` | 全部聊天记录 |
| 0.2.61 | `markai.config` | API Key / 端点 / 模型 / 删除模式 |
| 0.2.62 | `markai.undo` | 全部撤销点（含被删书签的快照） |

**共同结构**：读失败 → 内存退化成空/默认 → 保存时整对象覆盖。

台账里剩最后一处待查：`markai.organize.log`。

## 数据

单测 **768**（+2）· e2e **78 项 · 50s** · tsc ✅ · build ✅
