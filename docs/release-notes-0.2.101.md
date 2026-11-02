# v0.2.101 — 健康检查里有三条诊断，用户永远看不到

## 怎么发现的

给健康检查补一条契约测试：「每个带 fix 的诊断，跑完对应修复后不得再出现」——
正是 0.2.68 / 0.2.69 栽过的坑（修复按钮修不好，用户看到「点了没反应」）。

写测试时发现**种子怎么摆都触发不了**这些诊断。一路查下去，是两个真缺陷。

## 缺陷一：撤销相关的诊断全是死代码

`readSnapshot` 把**整个存储对象**塞进快照：

```ts
const undoPoints = store['markai.undo'];   // { points, notice?, terminalRunIds? }
```

而 `diagnose` 只认数组：

```ts
const raw = asArray(snapshot.undoPoints);  // 对象 → []
```

于是：

- `undo.corrupt`（清理损坏的撤销点）
- `undo.overflow`（保留最近 N 个）

**在真实健康检查里永远不触发**，对应的两个修复按钮用户根本看不到。

**单测为什么一直是绿的**：它们直接调 `diagnose()` 并传了正确形状的数组，
从没走过 `readSnapshot` 这条真实路径。

> 典型的「测试的形状和生产环境的形状不一样」。

## 缺陷二：Base URL 诊断也被归一化吃掉了

`readSnapshot` 为了「诊断看到的配置和运行时实际用的是同一份」会走 `resolveConfig`，
而它会 `normalizeBaseUrl`——把任何不带协议的值补上 `https://`。

归一化之后 `new URL()` 一律通过，所以 `config.invalid-baseurl` 同样永远不触发，
「修正为合法地址」那个按钮也是死代码。

## 修法

1. `readSnapshot` 取 `.points`
2. 快照新增 `baseUrlRaw`（用户**原始输入**），诊断优先看它，缺省时回退 `baseUrl`
   （直接调 `diagnose()` 的老调用方和既有单测不受影响）

## 验证

新增契约测试：五个可修复的诊断，各自摆出坏状态 → 跑修复 → **不得再出现**。

**证伪**：把 `readSnapshot` 改回传整个对象 → `undo.corrupt` 前置断言立刻转红。

## 数据

单测 **825**（+1）· e2e **143 项 · 87s** · tsc ✅ · build ✅
