# v0.2.158 — 去重会把两个不同的视频判成同一页

## 缺陷

`normalizeUrl()` 是「重复书签」判定的分组键，原来长这样：

```ts
const parsed = new URL(u.trim());
parsed.hash = '';
parsed.search = '';        // ← 把**整个**查询串删掉
if (parsed.hostname.startsWith('www.')) ...
```

`search = ''` 把查询串整个丢掉。但**参数在很多站点就是内容标识**：

| 收藏 A | 收藏 B | 归一化后 | 结果 |
|---|---|---|---|
| `youtube.com/watch?v=AAA` | `youtube.com/watch?v=BBB` | 都是 `youtube.com/watch` | **判为重复** |
| `shop.test/item?id=1` | `shop.test/item?id=2` | 都是 `shop.test/item` | **判为重复** |
| `blog.test/post?p=10` | `blog.test/post?p=20` | 都是 `blog.test/post` | **判为重复** |

而 `dedupe_bookmarks` 会按这些组**提议删除**「重复项」——用户点一下确认，
删掉的是**另一个真实页面**。这是本周所有修复里后果最重的一个：不是显示错、不是提示错，
是**真的删掉不该删的书签**。

## 修法

只剥**跟踪参数**（它们不影响内容），其余一律保留：

- 明确名单：`fbclid` / `gclid` / `msclkid` / `mc_cid` / `igshid` / `_ga` / `_gl` / `spm` 等
- `utm_` **前缀**通配，外加裸 `utm`（常见简写，只列具体项会漏）
- 参数**顺序**规范化：`?b=2&a=1` 与 `?a=1&b=2` 判为同一页

保守取舍：`ref`、`q` 这类有歧义的参数**不列入**跟踪名单。删除类操作里，
"少合并一次"只是漏判重复，"多合并一次"就是删错东西——不对称，所以往安全侧偏。

## 实测

```
修复前：判为重复！ youtube.com/watch  ← ?v=AAA 与 ?v=BBB
修复后：应分开    youtube.com/watch?v=AAA | youtube.com/watch?v=BBB
```

8 项行为矩阵全部符合预期（含"跟踪参数 + 真实参数混在一起时，真实参数必须留下"）。

## 验证

新增 2 项单测（874 → **876**）：

- `归一化不能把「查询参数不同」的两页判成重复` —— 三对真实场景 + `buildDuplicateGroups` 不得产生组
- `归一化仍要剥掉跟踪参数` —— 4 种噪声参数 + 混合参数场景

**证伪**（把 `stripTrackingParams` 改回删掉全部参数）→ 转红：

```
✘ 归一化不能把「查询参数不同」的两页判成重复
❌ 不该把这两条判成重复：https://www.youtube.com/watch?v=AAA / ...?v=BBB
```

## 我改了三条既有测试（说明理由）

有三条老测试**断言了错误行为**，它们是这个 bug 一直没被发现的原因：

| 位置 | 原断言 | 改成 |
|---|---|---|
| `归一化：忽略片段/查询参数/www/尾斜杠` | `?x=1` 应被忽略 | `?utm_source=x`（真正的噪声） |
| `find_duplicates 归一化 www/查询参数` | 用 `?ref=markai` 造重复 | `?utm_source=markai` |
| `分组：只返回有重复的组…` | 用 `?q=1` 造重复 | `?utm_source=1` |

三处改的都是**制造重复所用的参数**，测试原本的意图（www / 尾斜杠 / 片段 / 噪声参数归一）
一条没动；同时新增的两条断言把「不同内容参数不得合并」钉住了。
不是"改测试让红变绿"——是把**测试里写错的期望**改成正确期望，并补上更强的约束。

## 数据

单测 **876**（+2）· e2e **199/199 · 121s** · tsc ✅ · build ✅
