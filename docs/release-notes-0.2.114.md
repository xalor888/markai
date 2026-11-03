# v0.2.114 — 「纯函数」四个字，也不能只写在注释里

## 承诺

有几个模块的文件头写着同一类承诺：

| 文件 | 承诺 |
|---|---|
| `health/diagnostics.ts` | 不碰 chrome、不发网络请求、**不写任何东西** |
| `undo/journal.ts` | 刻意不碰 `chrome.*`，必须能在 node 测试里被直接证伪 |
| `chat-width.ts` | 纯函数，不碰 React/chrome |
| `bookmarks/delayed-open.ts` | 不碰 React、不碰 chrome，为了能直接单测 |

## 之前的状态

目前都是真的——这四个文件一个 `chrome.` 都没有。

但**单测里装着 chrome 替身、也 mock 了 fetch**。所以谁往里加一句
`chrome.storage.local.get(...)` 或 `fetch(...)`，**测试照样全绿**。

而 `diagnose` 那条承诺崩掉的后果很具体：**「诊断是只读的」这条边界破了，
用户点一下健康检查就可能被动到数据**——正是 0.2.113 守的那条边界的另一面。

## 做了什么

一条源码契约，两个方向都查：

**1. 承诺必须还在文件里**

先把承诺原文的正则拿去匹配文件头。匹配不到就报错——
否则承诺被悄悄删掉后，契约守的就是空气。

**2. 代码里不能出现副作用入口**

```
chrome.(storage|bookmarks|tabs|runtime|action|windows|contextMenus|notifications)
fetch(  /  XMLHttpRequest  /  await chrome
```

（同样先剥注释——注释里提到 chrome 是在解释**为什么**不碰。）

## 验证

**证伪**：往 `diagnostics.ts` 加一个读存储的 `peekStorage()` →

```
src/lib/health/diagnostics.ts 承诺是纯函数，却出现了 "chrome.storage"
```

## 数据

单测 **837**（+1）· e2e **149 项 · 86s** · tsc ✅ · build ✅
