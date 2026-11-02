# v0.2.70 — 浏览器能收藏的页面，这里不让收藏

## 问题

弹出窗的「收藏当前页」只放行 `http(s)`：

```ts
export function isSavableUrl(url) {
  return !!url && /^https?:\/\//i.test(url);
}
```

但 **Chrome 自己允许收藏 `file://`**——地址栏那颗星对本地 HTML 文件是能点的。

于是打开本地文档、离线资料、导出的网页时：

- 地址栏：可以收藏
- 插件弹窗：按钮是灰的，提示「仅支持 http/https」

用本地文档的人会觉得这是坏的。

## 修法

放行 `file://`（含 `file:///C:/...` 与大写写法），仍然拒绝浏览器自身页面：
`chrome://`、`chrome-extension://`、`about:`、`devtools://`、`view-source:`、`javascript:`、`data:`。

弹窗提示也改成：「支持网页与本地文件；浏览器自身页面不行」。

## 放宽判据之后必须验证下游

判据只是一道闸门——真正写书签的是 `chrome.bookmarks.create`。
如果它不接受 `file://`，那按钮就会从「灰的」变成「点了报错」，比原来更糟。

所以在真浏览器里验了一条：

```
Chrome 真的接受 file:// 书签（放宽判据后下游接得住）
  {"ok":true,"created":true,"searchable":true}
```

创建成功、能被搜到、清理干净。

## 测试

**T126 三条**：

- 网页与本地文件都可以收藏（含 `file:///`、`file:///C:/`、大写 `FILE://`）
- 浏览器自身页面不能收藏（9 种，含 `data:` / `javascript:` / `view-source:`）
- **不是"什么都放行"**——`ftp://` 与不带协议的字符串仍然不行

第三条是防止我把判据改成 `return true` 也能过。

**证伪**：改回只放行 http(s) →

```
应当可以收藏：file:///Users/me/doc.html
```

## 顺带：lib 下未被测试触达的导出盘了一遍

180 个导出函数，20 个没被测试引用。逐个看过风险：多数是工具函数
（`cn`、`copyText`）；两个有点意思的（`finalizeToolCalls`、`unrestorableOps`）
读过实现都是对的，本轮没动。

## 数据

单测 **784**（+3）· e2e **89 项 · 56s**（+1）· tsc ✅ · build ✅
