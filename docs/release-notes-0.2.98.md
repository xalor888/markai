# v0.2.98 — 界面承诺了 Ctrl+D，但代码里从来没有

## 这是一个产品缺陷，不是测试缺口

空文件夹的空态提示从 0.2.x 起就写着：

> 或按 Ctrl+D 把当前页面收藏进来

而**代码里从来没有这个处理器**——全库搜不到任何 `key === 'd'` 的分支。

用户照着提示按下去，**什么都没发生**。

## 修好了

在 workspace 的全局快捷键处补上处理器（和「?」开快捷键速查并排）：

```ts
if (e.key !== 'd' && e.key !== 'D') return;
if (!e.ctrlKey && !e.metaKey) return;
// 输入框里不劫持（Ctrl+D 在输入框是编辑器自己的行为）
useUIStore.getState().openDialog({ kind: 'create-bookmark', parentId: … });
```

预填不用自己写：`create-bookmark` 对话框打开时会自己读活动标签页
（`prefillFromTab`，0.2.75 就有）。

## 验了什么

```
PASS  按 Ctrl+D 弹出新建书签对话框（提示里承诺的行为）  {"dlgOpen":true}
PASS  输入框里的 Ctrl+D 不劫持（打字不受影响）          {"ok":true,"stillOpen":true}
```

## 预填为什么不在 e2e 里断言

CDP 建的标签页不一定落在扩展页所在窗口，`chrome.tabs.query({active:true, currentWindow:true})`
拿到的可能是空 URL（实测 `url:""`）——断言会因**环境**而不是产品失败。

预填逻辑本身是纯函数 `prefillFromTab`，**单测已覆盖 8 处**（http / file:// / 空标题 / 不可收藏 URL）。

## 验证

**证伪**：去掉 Ctrl+D 处理器 → 该条立刻转红。

## 数据

单测 **822** · e2e **142 项 · 81s**（+2）· tsc ✅ · build ✅
