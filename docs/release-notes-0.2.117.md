# v0.2.117 — 你说「全忘掉」，它只删了一条，还说「已忘掉」

## 缺陷

`forget_memory` 按 `query` 删除时：

```ts
const matched = searchMemories(query, all);
targetId = matched[0]?.id;      // 只取第一条
```

`searchMemories` 返回**全部**匹配，但工具只删第一条，
而回执里**不提还有几条匹配**。

于是这个场景：

1. 你有 3 条记忆：「GitHub 放技术文件夹」「GitHub 标题别翻译」「GitHub 用英文标题」
2. 你说「把所有关于 GitHub 的记忆都忘掉」
3. Agent 调 `forget_memory({query: "GitHub"})` → **只删了 1 条**
4. 回执 `success: true`，Agent 汇报「已忘掉」
5. **另外 2 条还在生效**——你下次收藏 GitHub 书签，照样被照旧摆布

你以为清干净了。

## 修法

多匹配时把「还有几条」如实回给模型：

```json
{
  "success": true,
  "deleted": "GitHub 的书签放「技术」文件夹",
  "remainingCount": 2,
  "remainingIds": ["m2", "m3"],
  "remaining": ["GitHub 的标题不要翻译", "GitHub 的书签用英文标题"],
  "note": "query「GitHub」匹配到 3 条记忆，本次只删除了第 1 条，还有 2 条仍然有效。
           请逐条调用 forget_memory（用上面给出的 remainingIds）把它们也删掉，
           或先向用户说明还有几条、问清楚是否全删。"
}
```

给用户看的 `message` 也补一句「（另有 2 条相似记忆仍有效）」。
只剩一条匹配时不输出这些字段——不制造噪音。

## 验证

```
PASS  forget_memory 多匹配时说清"还有几条"，不让模型误报已忘光
```

**证伪**：把 remaining 上报的条件改成 `false` →

```
必须报告还有 2 条匹配，实际 undefined
```

> 既有的 forget_memory 用例只放了**一条**记忆，多匹配的情况从未被测到——
> 这正是它能一直「假汇报」的原因。

## 数据

单测 **840**（+1）· e2e **149 项 · 86s** · tsc ✅ · build ✅
