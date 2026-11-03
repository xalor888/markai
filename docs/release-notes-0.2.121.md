# v0.2.121 — 光秃秃一个 `truncated: true`

## 缺陷

`search_bookmarks` 截断时返回：

```json
{ "query": "x", "total": 500, "shown": 200, "truncated": true, "items": [...] }
```

`truncated: true` 是个**光秃秃的布尔值**——模型知道「没给全」，但**不知道该干什么**。

而搜索**没有 offset 翻页**，唯一的补救是把关键词收窄。这句话一直没人说。

同一族的另外两个工具早就做对了：

| 工具 | 怎么说的 |
|---|---|
| `list_bookmarks` | `nextOffset` + `hasMore` |
| `find_duplicates` | note（0.2.119 补的） |
| `search_bookmarks` | **只有一个 true** |

## 修法

```json
{
  "total": 500, "shown": 200, "truncated": true, "omitted": 300,
  "note": "共匹配 500 条，本次只返回前 200 条，另有 300 条未返回。
           搜索不支持翻页，请把关键词收窄（加站点名、加年份、用更具体的词）再查一次，
           或用 list_bookmarks 到具体文件夹里逐层看。",
  "items": [...]
}
```

说清**还有几条**、**为什么不能翻页**、**两条补救路径**。不截断时不输出这些字段。

## 验证

```
PASS  search_bookmarks 截断时给出补救动作（不只是 truncated:true）
```

造 12 条匹配、`limit: 5` 强制截断。验 `omitted === total - shown`、
note 含「另有 N 条未返回」「关键词收窄」「list_bookmarks」；limit 够大时无这些字段。

**证伪**：把截断分支条件改成 `false` →

```
omitted 应等于 total-shown，实际 undefined
```

## 数据

单测 **843**（+1）· e2e **152 项 · 90s** · tsc ✅ · build ✅
