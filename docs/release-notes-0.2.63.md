# v0.2.63 — 第四处盲写：长期记忆，以及一次诚实的"这里没问题"

## 第四处：长期记忆

```ts
let memoryCache: MemoryItem[] = [];

async function getMemories() {
  try { ...读进 memoryCache... } catch { /* 降级用 memoryCache */ }
  return [...memoryCache];
}

async function saveMemories(memories) {
  memoryCache = [...memories];
  await chrome.storage.local.set({ [KEY]: memoryCache });   // 整对象覆盖
}
```

`addMemoryItem` 的流程是：`getMemories()` → 拼上新的一条 → `saveMemories(全部)`。

读失败时 `getMemories()` 返回 `[]`，于是"全部"就只剩新那条——
**你之前所有的长期记忆被清空**。

修法和前面一致：`lastReadOk` 记录是否真的读到过；没读到就拒绝写入并抛出明确原因。

## 第四处之外，还有一处"本来就没问题"

我把所有 `storage.local.set` 站点过了一遍。`markai.organize.log` 看着一模一样，
但仔细看——**写操作在 `try` 内部**：

```ts
try {
  const data = await chrome.storage.local.get(KEY);
  ...
  await chrome.storage.local.set({ [KEY]: merged });
} catch { ... }   // ← 读失败直接跳到这里，不会写
```

读失败就跳过写入，所以它是**安全的**。

我没有为了多修一个 bug 去改它，而是加了一条**回归锁**——把这个性质钉住：

```
✘ 读失败时放弃追加，磁盘上已有记录不变
   已有整理记录被覆盖了：["o3"]
```

上面这条是我故意把它改成盲写（把 set 挪出 try）之后的结果。
证明这条锁真的会响。

## 四处盲写汇总

| 版本 | 存储 | 被覆盖的东西 | 状态 |
|---|---|---|---|
| 0.2.60 | `markai.ai` | 全部聊天记录 | 已修 |
| 0.2.61 | `markai.config` | API Key / 端点 / 模型 / 删除模式 | 已修 |
| 0.2.62 | `markai.undo` | 全部撤销点（含被删书签快照） | 已修 |
| 0.2.63 | 长期记忆 | 全部长期记忆 | 已修 |
| 0.2.63 | `markai.organize.log` | —— | 本来安全，已加锁 |

顺手确认过的还有：`stream-draft` 的收尾写入（读在 try 内，安全）、
`organize-optout`（set 在 try 内，安全）。

## 数据

单测 **771**（+3）· e2e **78 项 · 51s** · tsc ✅ · build ✅
