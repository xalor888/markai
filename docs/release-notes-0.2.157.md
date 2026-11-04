# v0.2.157 — 自动分类会给「设置页」建一个叫 settings 的文件夹

## 缺陷

`auto_categorize` 按注册域把书签分组，然后为每组建一个同名文件夹。它调的是同一个
`registrableDomain()`，但**少了一道前置过滤**——而同一个 helper 的另一个调用方
`auto-organize.ts` 是有的：

```ts
// auto-organize.ts（正确）
if (!/^https?:\/\//i.test(node.url)) return { action: 'skipped', detail: '非网页书签' };
const domain = registrableDomain(node.url);

// auto_categorize（缺了上面那行）
const domain = registrableDomain(b.url ?? '');
```

`registrableDomain` 内部用的是 `new URL(...).hostname`，而这个 hostname 对非网页书签是**有值**的：

| 书签 | hostname | 被当成「站点」 |
|---|---|---|
| `chrome://settings/` | `settings` | `settings` |
| `chrome://extensions/` | `extensions` | `extensions` |
| `chrome-extension://<id>/x` | 那一长串扩展 id | `<id>` |

于是用户收藏了几个 chrome:// 页面，跑一次自动分类就会得到：

```
[DBG] 分出的域名组: ["t45.test","settings","extensions"]
```

—— 建出叫 `settings` / `extensions` 的文件夹，把设置页书签搬进去。

## 修法

在 `auto_categorize` 里补上同样的 `^https?://` 过滤，并注释说明为什么这两处必须一致。

## 验证

新增 1 项单测（873 → **874**）：文件夹里放 2 个正常站点 + `chrome://settings/` +
`chrome://extensions/`，跑真实 `auto_categorize`，断言：

- 分组里**不含** `settings` / `extensions`
- 正常站点仍被分出来（`t45.test`；`a.` 和 `b.` 归并到注册域是 eTLD+1 的正确行为）

**证伪**（删掉那层过滤）→ 转红：

```
[DBG] 分出的域名组: ["t45.test","settings","extensions"]
✘ 自动分类不该把 chrome:// 之类的书签当作站点归组建文件夹
```

## 数据

单测 **874**（+1）· e2e **199/199 · 118s** · tsc ✅ · build ✅
