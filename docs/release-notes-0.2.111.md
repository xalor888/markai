# v0.2.111 — 冷却窗口活不过一次 SW 回收

## 缺陷

「AI 分类连续失败」有个冷却机制：连败 3 次就暂停模型调用 10 分钟，
期间只用本地规则归类。它要解决的痛点写得很清楚：

> 用户把 API Key 配错时，**每一次收藏**都会先等 12 秒超时再退回本地规则。
> 收藏本该是即时动作，白等 12 秒的体感是「这扩展坏了」。

但计数和冷却窗口是 **SW 内存态，重启即重置**——注释自己写着。

而 MV3 的 Service Worker **空闲约 30 秒就被回收**，冷却窗口却是 **10 分钟**。

于是实际发生的是：

```
配错 Key → 连失败 3 次 → 进冷却 ✓
        → 用户停手一会儿，SW 被回收
        → 再收藏一条，SW 重启、计数归零
        → 又白等 3 次 12 秒超时才重新进冷却
        → 无限循环
```

**用户看到的就是「收藏网页要卡十几秒」——而冷却本该修掉的正是这个。**

讽刺的是，同一个文件里 60 行之外就有正确写法：

```ts
/** 首次自动整理是否已提示过（跨 SW 重启有效：存在 storage 里） */
const ORGANIZE_HINTED_KEY = 'markai.organize.hinted';
```

## 修法

冷却态落到 `markai.auto-organize.ai-streak`，**每次收藏前从 storage 读**：

```ts
const streakBefore = await loadAiStreak();
const inCooldown = Date.now() < streakBefore.cooldownUntil;
const res = await autoOrganizeBookmark(id, inCooldown ? { skipAi: true } : {});
await saveAiStreak(nextAiStreakState({ state: streakBefore, ... }));
```

读失败时当作没有冷却——宁可多试一次模型，也不要永久冻结自动整理。

## 验证

证伪：把 `loadAiStreak()` 换回硬编码的零值（等于不读盘）→

```
必须既有读也有写：只写不读等于没存，只读不写等于永远不进冷却
```

同时钉住：不能再有模块级 `let aiStreak`（那正是重启即重置的根因）、
读必须发生在判断冷却期之前、冷却期内失败不得延长窗口。

## 数据

单测 **835**（+1）· e2e **143 项 · 85s** · tsc ✅ · build ✅
