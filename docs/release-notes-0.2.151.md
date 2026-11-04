# v0.2.151 — 待删列表满了，多出来的提议悄悄消失

## 缺陷

`chat:tool_done` 里对 `pendingDeletions` 做了 `.slice(-2000)`：

```ts
pendingDeletions: dedupeProposals([
  ...s.pendingDeletions,
  ...(evt.record.deletions ?? []),
]).slice(-2000),
```

上限本身有道理（注释写明：一键清理一次可提交上千条，200 条会截断）。但：

- `propose_deletions` 单次上限 **1000 条**
- `cleanup_sweep` 还能**分页多次调用**（返回 `remaining`，模型用 `offset` 继续）

**3 批就是 3000 条** —— 第 3 批到达时，最早的 1000 条被无声丢掉。

后果：用户在待删列表里看到 2000 条，以为这就是全部，审批完就以为清理干净了。
剩下那 1000 条**看起来像"没问题"**，实际是提议被丢了——这正是「静默部分结果」里
最隐蔽的一种：不是少了数据，而是少了"应该被删的东西"的告警。

## 实测

三批各 1000 条（共 3000）打进 `handleOutbound`：

```
[DBG] 保留 2000 条（提交了 3000），提示语：[]
```

上限正常生效，但**一句提示都没有**。

## 修法

把丢弃的条数算出来，一次性告知：

```ts
const merged = dedupeProposals([...s.pendingDeletions, ...(evt.record.deletions ?? [])]);
const dropped = Math.max(0, merged.length - PENDING_DELETIONS_LIMIT);
if (dropped > 0 && !deletionsCapWarned) {
  deletionsCapWarned = true;
  pushToast(`待删列表已达上限，${dropped} 条提议未列出`, {
    description: `单次最多保留 ${PENDING_DELETIONS_LIMIT} 条待确认项。处理完当前这批后，再让 Agent 整理一次即可看到剩下的。`,
    variant: 'destructive',
  });
}
return { pendingDeletions: merged.slice(-PENDING_DELETIONS_LIMIT) };
```

提示带**可执行的下一步**（处理完这批再整理一次），不只是一句「超限了」。
`deletionsCapWarned` 保证连发多批时不刷屏。

## 验证

新增 1 项单测（866 → **867**）：三批各 1000 条打进真实的 `handleOutbound`，
断言保留 2000 条 **且** 有告知。

修复后：

```
[DBG] 保留 2000 条（提交了 3000），提示语：["待删列表已达上限，1000 条提议未列出 …"]
```

**证伪**（去掉 pushToast）：

```
[DBG] 保留 2000 条（提交了 3000），提示语：[]
✘ 删除提议超过 2000 条时要告诉用户有被丢弃的
❌ 丢弃了 1000 条提议却没有告诉用户——用户会以为 2000 条就是全部
```

## 数据

单测 **867**（+1）· e2e **199/199 · 118s** · tsc ✅ · build ✅
