# v0.2.142 — 取消只对一半工具有效

## 缺陷

0.2.141 给 `executeTool` 加了 `signal`，但**只接进了 `cleanup_sweep` 的两处循环**。
批量检测类工具一个都没接：

| 工具 | 上限 | 最坏耗时（8s 超时） |
|---|---|---|
| `check_urls` | 50 个 URL / 5 并发 | **80 秒** |
| `check_urls_bulk` | 不限条数 / 20 并发 | 500 个 → **200 秒** |

用户点「取消」，界面已经显示取消了，检测还在跑。

更糟的是 `check_urls` **连进度都不报**——用户看不到「正在检测 12/50」，
既不知道进度、也不知道该不该点取消。

## 修法

1. `check_urls` / `check_urls_bulk` 的并发池 `while` 每轮检查 `throwIfAborted()`
2. `check_urls` 补上**节流进度上报**（每 250ms 一次，与 `check_urls_bulk` 一致）——
   没有进度就没有可取消的反馈
3. `move_bookmarks` 的逐条移动循环也加检查（中断点天然正确：已移动的已由 `jMove` 记进撤销点）

## 验证

```
PASS 取消能打断所有批量长工具（不只 cleanup_sweep）
  [DBG] check_urls: 23ms, 抛错=true, 有结果=false
  [DBG] check_urls_bulk: 22ms, 抛错=true, 有结果=false
```

**证伪**（去掉 `check_urls` 的 abort 检查）：

```
✘ 取消能打断所有批量长工具
❌ check_urls 在运行中被取消后必须抛错，而不是照常返回完整结果
  [DBG] check_urls: 214ms, 抛错=false, 有结果=true
```

23ms vs 214ms，抛错 true vs false。

## 测试写法上的一个坑

第一版用「一开始就把 signal abort 掉」，结果工具还没进循环就抛了，
**测不到循环里的检查**。改成「跑到一半（第一个进度回调）时取消」才真正测到。

另一个坑：`check_urls` 的 schema 上限是 50 个 URL，我一开始传了 60 个，
被 zod 挡掉，报的是「参数不合法」而不是「已取消」——**断言测的是别的东西**。

## 数据

单测 **855**（+1）· e2e **199/199 · 118s** · tsc ✅ · build ✅
