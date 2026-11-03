# v0.2.148 — 模型以为在翻页，其实在原地打转

## 缺陷

`agent.ts` 的截断提示按 `PAGINATED_TOOLS` 分流：

```ts
const paginated = PAGINATED_TOOLS.has(tc.function.name);
const hint = truncated
  ? paginated
    ? `（结果过长已截断：请用 offset 分页获取剩余部分）`   // ← 在集合里
    : `（结果过长已截断：该工具不支持分页，请把查询条件收窄…）`
  : '';
```

而 `get_folder_content` 被放进了这个集合，它的 schema 里却**只有** `folderId / folderPath / limit / depth`——**没有 `offset`**。

更糟的是 **zod 对未知键是静默剥离，不是报错**：

```js
z.object({ limit: z.number().optional() }).parse({ limit: 5, offset: 100 })
// → {"limit":5}    offset 被无声丢掉
```

所以整条链是：

1. `get_folder_content` 结果超长被截断
2. 提示模型「请用 offset 分页」
3. 模型传 `offset: 100`
4. zod 静默丢弃
5. **返回和第一次一模一样的第一页**

模型以为自己翻页了，实际在原地打转——比直接报错更糟（报错它至少会改策略）。

讽刺的是，这段代码的注释早就写明要防这个：

> 原来一律写「请用 offset/maxItems 分页获取剩余部分」——但不是每个工具都有 offset。

**`get_folder_content` 就是被漏掉的那一个。**

## 实测（5 个工具逐个传 offset 对比返回）

```
list_bookmarks:     offset 生效=true
list_all_folders:   offset 生效=true
cleanup_sweep:      offset 生效=true
get_folder_content: offset 生效=false   ← 缺陷
export_bookmarks:   offset 生效=true
```

## 修法

把 `get_folder_content` 从 `PAGINATED_TOOLS` 移除，并把「名单必须与 schema 严格一致、
zod 会静默剥离」写进注释。

**为什么不给它加 offset**：它返回的是**递归树**（有 `depth`），「offset 5」在树上语义含混
（跳过前 5 个节点？只对第一层？）。而「收窄查询」对它本来就可执行——用 `folderPath`
定位子文件夹、或调小 `depth`/`limit`。

## 验证

新增 1 项单测（863 → **864**）：从 `agent.ts` 源码里解析出 `PAGINATED_TOOLS`（保持单一
事实来源），逐个传 `offset` 并比对返回是否改变。

**证伪**（把 `get_folder_content` 加回集合）→ 转红：

```
✘ PAGINATED_TOOLS 里每个工具都必须真的支持 offset
❌ 这些工具在 PAGINATED_TOOLS 里，但传 offset 拿到的还是同一份结果：get_folder_content
```

以后新增工具时若把不支持分页的写进名单，这条会红。

## 数据

单测 **864**（+1）· e2e **199/199 · 115s** · tsc ✅ · build ✅
