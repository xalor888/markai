# v0.2.141 — 点「取消」，长工具还在跑

## 缺陷

`executeTool` 没有 `signal` 参数：

```ts
export async function executeTool(
  name: string,
  argsJson: string,
  onProgress?: (text: string) => void,
  // ← 没有 signal
): Promise<ToolOutput>
```

abort 只挡在**工具之间**（每次工具调用前后各有一道门，0.2.128 加的）。正在执行的长工具**一路跑完**。

`cleanup_sweep` 是最长的那个：先递归遍历整棵树，再对每个保留候选做**并发 HTTP 存活检测**。用户点「取消」，界面上已经显示取消了，它还在烧 CPU 和网络。

## 实测

1000 个候选 URL，每个 URL 检测耗时 5ms、20 并发：

| | abort 时刻 | 实际结束 | 结果 |
|---|---|---|---|
| **修复前** | 129ms | **426ms** | 正常返回一份完整结果 |
| **修复后** | 158ms | **158ms** | 抛「已取消」 |

修复前取消后还要再跑 **268ms**（1000 个 URL 的完整检测），而且是**正常返回**——调用方无从知道这轮已经被取消了。真实规模下（5000 条 + 真实网络往返），这个尾巴是分钟级。

## 修法

`executeTool` 增加可选 `signal`，透传给 handler；`cleanup_sweep` 在两处最慢的循环里检查：

```ts
const throwIfAborted = () => {
  if (signal?.aborted) throw new Error('已取消，这一步没有执行完');
};
```

- 递归遍历 `walk()` 每层检查
- 存活检测的并发池 `while` 每轮检查（这是最慢的一段：每个 URL 一次网络往返）

agent 调用时把 `signal` 传下去。

## 验证

```
PASS 取消能打断正在执行的长工具（不是等它跑完）
  [DBG] 首次进度 158ms，整体结束 158ms，抛错=true, 有结果=false
```

**证伪**（把 `throwIfAborted` 改成空操作）：

```
✘ 取消能打断正在执行的长工具
❌ 取消后应当抛错而不是正常返回（实际返回了结果，说明长工具的循环没检查 signal）
  [DBG] 首次进度 129ms，整体结束 426ms，抛错=false, 有结果=true
```

## 过程中的教训

这个测试我写坏了两次：

1. 第一版用带路径的 URL（`https://t37.test/0/0`），被分类成 `deep` 而不是 `root`，
   而 `keepOnly` 默认 `'root'` → **存活检测整段被跳过**，根本没测到并发池。
2. 第二版断言写成 `total < abortedAt + 600`，而 `abortedAt` 是 0、`total` 是 132 →
   **恒真**，又是一条空转的断言。

现在断言的是「抛错且信息含已取消、且没有结果」——这才是取消生效的证据。

## 数据

单测 **854**（+1）· e2e **199/199 · 114s** · tsc ✅ · build ✅
