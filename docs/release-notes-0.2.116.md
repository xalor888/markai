# v0.2.116 — 同一个上限，代码里写着两份

## 缺陷

两处「同一个数、两份独立定义」：

| 上限 | 执行方（真正保留） | 诊断方（阈值） |
|---|---|---|
| 撤销点条数 | `MAX_UNDO_POINTS = 10` · `undo/recorder.ts` | `MAX_UNDO_POINTS = 10` · `health/diagnostics.ts` |
| 整理记录条数 | `ORGANIZE_LOG_LIMIT = 200` · `ai/organize-log.ts` | `MAX_LOG_ENTRIES = 200` · `health/diagnostics.ts` |

今天两边相等，所以诊断是对的。但**改一个忘一个**只有两种结果：

- 执行方调大、诊断不变 → **误报**：「整理记录超出上限（450/200）」，可 500 才是真上限
- 诊断调大、执行方不变 → **永不触发**：死诊断（0.2.101 那类）

而**单测各自绿着**——因为两边都「是对的」。

这是上一轮（上下文窗口边界）同一类问题的又一例，而且这里**已经重复了**，不是假设。

## 修法

诊断模块改成**再导出**，不再自己定义：

```ts
import { MAX_UNDO_POINTS } from '@/lib/undo/recorder';
import { ORGANIZE_LOG_LIMIT as MAX_LOG_ENTRIES } from '@/lib/ai/organize-log';
export { MAX_UNDO_POINTS, MAX_LOG_ENTRIES };
```

`fixes.ts` 的 import 不用动（它本来就从 diagnostics 导入，现在顺理成章拿到共享值）。

## 验证

```
PASS  保留上限只有一处定义，诊断只是再导出
```

源码契约 + 运行时相等断言双重确认。

**证伪**：把诊断模块换回自定义（值故意不变，还是 10）→

```
诊断模块自己定义了上限："export const MAX_UNDO_POINTS = 10"。
必须从执行方导入，否则又会漂移。
```

> 值没变也能抓到——守的是「有没有共享」，不是「数值等不等」。

## 过程中自己错了一次

第一次证伪写成 `export const MAX_UNDO_POINTS = 12`，撞上另一条硬编码期望 12 步的既有测试，
红的是那条而不是我的。按纪律**先怀疑证伪脚本**，改成值相同的自定义后正确复现。

## 数据

单测 **839**（+1）· e2e **149 项 · 86s** · tsc ✅ · build ✅
