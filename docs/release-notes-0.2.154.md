# v0.2.154 — 开了 7 个标签页，界面说「打开失败」

## 缺陷

书签树里「在标签页组中打开」有两处调用点，都是这个写法：

```ts
try {
  const tabs = await Promise.all(list.map((url) => chrome.tabs.create({ url, active: false })));
  const tabIds = tabs.map((t) => t.id).filter(...);
  if (tabIds.length > 0) {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title, collapsed: true });
  }
  pushToast(`已在标签页组中打开 ${tabIds.length} 个页面`, { variant: 'success' });
} catch {
  pushToast('打开失败', { variant: 'destructive' });
}
```

`Promise.all` 在**第一个失败时立刻 reject**，但其余 `createTab` 已经在飞了、多半会成功。于是：

- 10 个里有 3 个打不开 → catch 分支弹「打开失败」
- **实际开了 7 个**
- 而且分组那一步被整个跳过 —— 这 7 个散落在窗口里，没有组

用户看到的和事实完全相反。

## 实测

| | 提示 | opened | failed | grouped |
|---|---|---|---|---|
| 修复前（`Promise.all`） | **打开失败** | **0** | 10 | **0** |
| 修复后（逐条结算） | 已打开 7 个，3 个失败 | **7** | 3 | **7** |

修复前那 7 个标签页其实**真的开出来了**，只是代码认为"全失败"，所以既没分组也没报数。

## 修法

抽成可单测的 `openUrlsInGroup()`（放进已有的 `lib/open-url.ts`——那个模块本来就是为
"打开失败必须可见"而建的，注释里写着它替换了近二十处 `tabs.create().catch(() => {})`）：

- 逐条 `try/catch`，各自结算成功/失败
- **成功的那部分照样分组**（组不成功也不影响"标签页已打开"这个事实）
- 提示按实际数字分三种情况：全成功 / 部分成功 / 全失败

两处调用点改为一行调用，重复逻辑消失。

## 验证

新增 1 项单测（870 → **871**）：10 个 URL，让第 3/5/8 个失败。

```
[DBG] opened=7 failed=3 grouped=7
      toasts=["已打开 7 个，3 个失败 | https://open-2.test：无法打开该协议"]
```

断言：`opened===7`、`failed===3`、**`grouped===7`**、`chrome.tabs.group` 真的收到 7 个 tabId、
提示里不含「打开失败」。

**证伪**（改回 `Promise.all` 语义）→ 转红：

```
[DBG] opened=0 failed=10 grouped=0 toasts=["打开失败 | 失败"]
✘ 批量打开部分失败时：如实报数，且成功的那部分照样分组
❌ 应开 7 个，实际 0
```

## 顺带

测试用的 chrome mock 里 `chrome.tabs.group` / `chrome.tabGroups.update` 之前**根本不存在**。
补齐了，并让 `tabs.create` 返回**唯一 id**（原来恒返回 `{id:1}`，批量分组根本没法断言）。

## 数据

单测 **871**（+1）· e2e **199/199 · 117s** · tsc ✅ · build ✅
