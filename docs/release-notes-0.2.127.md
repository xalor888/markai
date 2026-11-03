# v0.2.127 — 「请用 offset 翻页」——可它没有 offset

## 缺陷

工具结果超 12 万字符会被截断，并附一句提示：

```
（结果过长已截断：请用 offset/maxItems 分页获取剩余部分）
```

**但不是每个工具都有 offset。**

| 工具 | 有 offset？ |
|---|---|
| `list_bookmarks` | ✅ |
| `list_all_folders` | ✅ |
| `cleanup_sweep` | ✅ |
| `get_folder_content` | ✅ |
| `export_bookmarks` | ✅ |
| **`search_bookmarks`** | **❌** |

于是 `search_bookmarks` 结果被截断时，模型照着提示去传 `offset` → **撞上 Zod 参数校验错误** → 白跑一轮，还以为是自己偶发故障。

而搜索恰恰是最容易触达 12 万字符的（一个常见词命中几千条）。

## 修法

提示按工具给：

```ts
const paginated = PAGINATED_TOOLS.has(tc.function.name);
// 可翻页：请用 offset 分页获取剩余部分（list_bookmarks 再补一句可调大 limit）
// 不可翻页：该工具不支持分页，请把查询条件收窄（更具体的关键词/更小的文件夹）后再查一次
```

## 验证

```
PASS 工具结果截断提示按工具给可行补救（不能翻页的别说"用 offset"）
```

40 条 × 3000 字符的标题，搜索必然超限。验：`search_bookmarks` 的提示里**不出现 offset**、
且说「不支持分页」+「收窄」；`list_bookmarks` 的提示里**该有** offset。

**证伪**：把 `paginated` 改成恒为 `true` →

```
search_bookmarks 不支持翻页，提示里不该出现 offset：…yyyy…
```

## 数据

单测 **849**（+1）· e2e **152 项 · 90s** · tsc ✅ · build ✅
