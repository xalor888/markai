# v0.2.145 — 撤销历史分不出「取消掉的半步」

## 缺陷

被取消的轮次和正常做完的轮次，在撤销历史里**长得一模一样**：

```
删除 1 项        ← 正常做完的
删除 1 项        ← 取消掉的半步
```

用户点了取消之后回头看历史，无法确认哪一条对应刚才那半步，**也就不知道该不该撤销它**。

## 修法

`UndoPoint` 增加 `interrupted?: boolean`，在 `runAgentTurn` 的 `finally` 里按 `signal.aborted` 标记：

```ts
await endUndoTransaction(params.messageId, { interrupted: params.signal.aborted });
```

`describeUndoHistory` 的摘要据此加后缀：

```ts
summary: p.interrupted ? `${base}（已中断）` : base
```

## 验证

```
[DBG] 正常: 删除 1 项 · 取消: 删除 1 项（已中断）
PASS 被取消的轮次在撤销历史里标「已中断」
```

同时断言了反向：**正常完成的轮次不该带这个标记**。

**证伪**（去掉后缀）→ 转红：

```
❌ 取消的轮次必须标出来，实际：删除 1 项
```

## 数据

单测 **858**（+1）· e2e **199/199 · 117s** · tsc ✅ · build ✅
