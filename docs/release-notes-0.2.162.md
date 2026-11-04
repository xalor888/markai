# v0.2.162 — 「在新窗口打开」失败时什么都不知道

## 缺陷

「在新窗口打开」单行操作（右键 → 新窗口打开）有一条路径直接吞掉错误：

```ts
if (node?.url) void chrome.windows.create({ url: node.url, focused: true }).catch(() => {});
```

浏览器拦截弹窗 / 窗口数超限 / 扩展权限问题都会导致 `chrome.windows.create` 抛出异常，
但 `.catch(() => {})` 把异常完全吞掉——**用户点了一下什么都没发生**，也不知道为什么。

这和之前修过的「打开书签失败要有提示」是同一类问题，只是这条路径绕开了统一的 open-url 工具函数，直接裸调 chrome API。

## 修法

给出可见的错误反馈：

```ts
void chrome.windows.create({ url: node.url, focused: true }).catch((e: unknown) => {
  pushToast('在新窗口打开失败', {
    description: e instanceof Error ? e.message : String(e),
    variant: 'destructive',
  });
});
```

## 验证

新增 1 项单测（881 → **882**），从源码中扫出所有 `chrome.windows.create(...).catch(()=>{})` 的用法，断言数量为 0：

```
[DBG] 裸 windows.create + .catch(()=>{}) 出现 0 次
全部通过：882 项 ✔
```

**证伪**（改回 `.catch(() => {})`）→ 转红：

```
[DBG] 裸 windows.create + .catch(()=>{}) 出现 1 次
✘ 发现 1 处静默吞错……
```

## 数据

单测 **882**（+1）· e2e **199/199 · 118s** · tsc ✅ · build ✅
