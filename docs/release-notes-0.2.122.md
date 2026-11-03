# v0.2.122 — 撤销过的操作，还能再撤一次

## 缺陷

撤销系统有两道守卫，防止**已被消费的撤销点**被残留的 pending 重新提升：

1. `terminalRunIds.includes(pending.runId)` —— runId 已记账
2. `state.points.find(p => p.runId === pending.runId)` —— 正式点还在

但 `MAX_TERMINAL_RUN_IDS = 50`：**终态列表只留最近 50 条**。正式点也只有 10 步保留窗口。

两道守卫同时失效时：

```
撤销点已消费 → runId 进终态列表
  → 又跑了 50+ 轮 → runId 被挤出终态列表
  → 正式点也掉出 10 步窗口
  → 而 pending 恰好残留（clearPending 失败过）
  → 下次启动：两道守卫都不认它
  → 陈旧 pending 被提升成一个**新的可回放撤销点**
```

**用户能对一个已经发生、且已经撤销过的操作再撤一次。** 删除类逆操作会**重复重建子树**——凭空多出一批重复书签。

`clearPending` 的注释原本写着「清不掉最多是多一次无害的重复提升」——**那句话是错的**。

## 修法

撤销点被消费时，把 pending 槽写成**墓碑**而不是删除：

```ts
{ runId, ops: [], containsDelete: false, orderCheckpoints: [], terminal: true, updatedAt }
```

墓碑只占一个 key、**不随轮次增长**，所以没有上界问题。恢复时 `pending.terminal` 独立挡住提升，
不依赖那个 50 条的列表。墓碑是惰性的——`ops` 为空，任何读取路径都不会把它当成在途事务，
下一轮 `savePendingFrom` 会用新事务覆盖它。

顺带把 `clearPending` 那句错注释改掉。

## 验证

```
PASS 终态 runId 的残留 pending 不被提升（墓碑 + 终态列表双守卫）
```

三段：A 基本情形（runId 在终态列表）／B **墓碑独立挡住**（终态列表被 50 条 filler 挤满，
墓碑是唯一还认它的东西）／C 墓碑是惰性的，不挡新轮次。

**证伪**：只关掉墓碑写入 →

```
消费后 pending 槽应是墓碑，实际 undefined
```

## 诚实的残余风险

墓碑自己也是一次 storage 写。若它和 `writeUndoPoints` **连续两次**都失败，
仍会退回 50 条终态列表那道守卫。相比修复前（一次失败就穿），窗口窄了一个量级。

## 数据

单测 **844**（+1）· e2e **152 项 · 91s** · tsc ✅ · build ✅
