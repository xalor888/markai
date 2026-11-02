# v0.2.86 — 用户最关心的一步，以前从没在浏览器里验过

## 缺口

「AI 动了我的书签，我能不能一下撤回？」——**这是整个产品最重要的一条用户路径。**

e2e 里验过：

- ✅ AI 工具循环跑通（模型 → tool_call → 执行 → 回填 → 最终文字）
- ✅ 工具真的建了书签
- ✅ 本地规则整理后能从整理记录里撤销

**但没验过**：从对话里点「撤销」，AI 建的书签真的会被撤掉。

## 补上了

```
PASS  Agent 的改动落成了撤销点（事务正常收尾）      {"pointLanded":true}
PASS  撤销历史里出现了可撤销的一步                  {"count":1,"first":"最新\n新建 1 项\n还原 1 项 · 刚刚"}
PASS  从对话里点撤销，AI 建的书签真的被撤掉了        {"reverted":true}
```

第三条是闭环：点下去 → 书签真的没了。

## 过程中我差点报了一个假缺陷

第一版跑出来是红的：`markai.undo` 键**不存在**，撤销按钮禁用。

我一路查到了 service worker 内部——加日志打 `beginUndoTransaction` /
`endUndoTransaction` / `writeUndoPoints`，日志显示：

```
[ZG] endUndoTransaction called, expected= … activeRunId= … ops= 1
[ZG] about to writeUndoPoints, kept= 1
[ZG] writeUndoPoints ok= true
[ZG] agent turn fully done
```

**撤销点写成功了。**

问题在我的测试：最终文字渲染出来的时候，后台还在收尾事务
（`chat:done` → `endUndoTransaction` → `writeUndoPoints`）。我查得太早。

修法是等落盘：

```js
const pointLanded = await waitFor(async () => /* markai.undo.points.length >= 1 */, 10000);
```

> **「查不到」先问「是不是查得太早」。**
> 这一轮我花了很长时间往产品里找 bug，而 bug 在测试的时序里。

## 验证

三条新检查。**证伪**：把落盘等待去掉 → 三条同时转红。

## 数据

单测 **822** · e2e **110 项 · 62s**（+3）· tsc ✅ · build ✅
