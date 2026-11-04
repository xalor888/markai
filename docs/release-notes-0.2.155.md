# v0.2.155 — 树里多了一行空白，点不中也找不到

## 缺陷

四个接受标题的 schema 都是 `z.string().min(1).max(200)`：

| schema | 用途 |
|---|---|
| `createFolderSchema` | 新建文件夹 |
| `createBookmarkSchema` | 新建书签 |
| `createBookmarks` 的 items | 批量新建 |
| `renameSchema` | 重命名 |

`"   "`（三个空格）长度是 3，**通过校验**。

而界面渲染用的是：

```tsx
{highlightTitle(node.title || '(未命名)', filter)}
```

`"   "` 是**真值**，所以 `||` 后面的 `(未命名)` 走不到 —— 这一行渲染成几个空格。
用户看到的是**一行空白**：既不像书签、也不像"(未命名)"，找不到也点不中。

## zod 的顺序陷阱

修的时候踩到一个坑，值得记下来：

```js
z.string().trim().min(1)   // "   " → REJECT ✓
z.string().min(1).trim()   // "   " → ""     ✗ 通过校验并返回空串
```

第二种更危险：校验放行了，然后 trim 成空串存进去。空串是假值，界面显示成 `(未命名)`，
**看起来一切正常**，但数据已经脏了。

必须 `.trim()` 在前。

## 修法

四处统一改成 `z.string().trim().min(1).max(...)`，并把这个顺序理由写进注释。

顺带效果：`"  正常标题  "` 现在会被修成 `正常标题` 再存，不再把首尾空格写进书签。

## 实测

```
修复前：[DBG] create_bookmark: rejected=false
修复后：[DBG] create_bookmark: rejected=true 参数不合法：Too small: expected string to have >=1 characters
```

## 验证

新增 1 项单测（871 → **872**）：对 `create_bookmark` / `create_folder` / `create_bookmarks`
分别传纯空格标题，断言**三个都必须拒绝**；再传 `"  正常标题  "`，断言存进去的是
`正常标题`（无首尾空格）。

**证伪**（去掉 `.trim()`）→ 转红：

```
[DBG] create_bookmark: rejected=false
✘ 纯空格标题必须被拒绝（否则树里会出现点不中的空白行）
```

## 数据

单测 **872**（+1）· e2e **199/199 · 114s** · tsc ✅ · build ✅
