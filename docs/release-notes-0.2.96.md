# v0.2.96 — Ctrl+C 复制网址，快捷键说明承诺了但没验过

## 缺口

快捷键说明里写着「Ctrl+C 复制选中项的网址」。

e2e 里**一次都没验过**。用户照说明按下去，剪贴板里没东西、也没有任何提示——
那说明就成了谎言。

## 验了什么

两层判据，缺一不可：

```
PASS  按 Esc 之后多选已清空                    {"selCleared":0}
PASS  能读出高亮行的网址                       {"EXPECT_URL":"https://alpha.example.com/a"}
PASS  按 Ctrl+C 后界面上给出「已复制」反馈      {"toastShown":true}
PASS  剪贴板里真的是高亮行的网址               {"copied":true,"copiedAll":["https://alpha.example.com/a"]}
```

**只验 toast 不够**——复制失败了也可能弹 toast。所以必须同时确认剪贴板内容。

## headless 下读不到剪贴板

`navigator.clipboard.readText()` 直接报：

```
NotAllowedError: Failed to execute 'readText' on 'Clipboard': Read permission denied.
```

改成**间谍式劫持 `writeText`**：记录应用实际传进去的内容。
验的正是「应用用剪贴板 API 复制了这条网址」这件事本身。

## 过程中搞清了一条产品规则

第一版我点的行、按 Home、再 Ctrl+C，复制到的却是**另一条书签**。

原因不是 bug：Ctrl+C 的规则是

```ts
selectedIds.length > 0 ? 选中项 : 高亮行
```

前面的键盘段落留下了**多选状态**，所以复制到的是选中项。

而且「点行」是打开书签，**不会把高亮移到那一行**——高亮只由键盘导航设定。

所以用例改成：先 `Esc` 清多选 → `Home` 固定高亮 → 从**高亮行**的 `title` 属性读预期网址 → Ctrl+C。

## 验证

**证伪**：让 Ctrl+C 分支失效 → 两条同时转红（`copiedAll: []`）。

## 数据

单测 **822** · e2e **137 项 · 79s**（+4）· tsc ✅ · build ✅
