# v0.2.140 — 两个窗口同时整理：在 B 点撤销会连 A 的改动一起还原

## 缺陷

待办池最后一项「并发两个窗口同时整理时的撤销点竞争」，查下去是真的。

`beginUndoTransaction` 遇到已有事务会**强制收尾**：

```ts
export async function beginUndoTransaction(runId: string) {
  if (active) await endUndoTransaction();   // ← 没传 runId，强行关掉别人的
  ...
}
```

于是两个窗口同时跑 Agent 时：

1. 窗口 A 开始，删了 `a1`
2. 窗口 B 开始 → **强制关掉 A 的事务**（A 的 `a1` 被收尾成独立撤销点，还好）
3. 窗口 A 继续删 `a2` → **这条落进了 B 的事务**
4. 用户在 B 窗口点「撤销」→ **把 A 的 `a2` 也一起还原了**

`endUndoTransaction(expectedRunId)` 早就有防抢占守卫（迟到的收尾不动别人的事务），
**但记账这一侧没有对称的保护**。

实测（逐条打点）：

```
pointA: null          ← A 的事务被强行关掉，它自己的收尾被 runId 守卫拒绝
pointB: ops=["delete:6170"]   ← B 的撤销点里出现了 A 的第二个删除
```

## 修法

给记账动作带上「当前归属轮次」：

```ts
let recordingOwner: string | null = null;
export function setRecordingOwner(runId: string | null) { recordingOwner = runId; }

export function recordOp(op: UndoOp): void {
  if (!active) return;
  if (recordingOwner !== null && active.runId !== recordingOwner) {
    droppedBecauseSuperseded++;   // 归属不符 → 丢弃，不写进别人的事务
    return;
  }
  active.ops.push(op);
  ...
}
```

agent 在每个工具执行前后设置/清除归属。

**取舍**：丢掉这条撤销记录，好过「撤错对象」——前者少一条可撤销，
后者会让用户在 B 窗口点一下就把 A 窗口刚做的删除也还原掉。

## 验证

```
PASS 两个轮次交错：后开始的不该把先开始的后续操作吞进自己的撤销点
```

验三件事：B 的撤销点里**没有 A 的操作**；A 被抢占前完成的那个操作**保留为独立撤销点**；A 的收尾被 runId 守卫拒绝。

## 顺带修：三个测试在 IIFE 外面并发跑

同一轮发现 `命令面板派发的自定义事件` / `TOOL_DEFINITIONS 里声明的每个工具` / `每个已实现的工具都有中文标签` 三个用例写在 **IIFE 之外**的模块顶层——`await` 让它们与主套件**并发执行**，共享 `storageMap` 与模块级 `store`。

证据：它们打印在输出第 9/10/18 行，而主套件的汇总在第 1137 行。

已移进 IIFE（现在打印在第 1133–1135 行）。失败也终于能被正确报告：

```
✘ 命令面板派发的自定义事件，都有人接
❌ 测试失败: AssertionError: 只派发了 3 个事件
```

（修复前它们抛错时「全部通过」已经先打印了。）

## 数据

单测 **853**（+1）· e2e **199/199 · 115s** · tsc ✅ · build ✅
