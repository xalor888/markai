# v0.2.136 — 上一轮的修法留下了一点跨节污染

## 问题

0.2.135 修主题首帧抖动时，我用 `Page.addScriptToEvaluateOnNewDocument`
在新文档里种入 `markai.theme = 'light'`，并加了一个一次性标记。

但收尾只清理了**第一个**脚本（`__firstFrame` 那个），漏了我新加的第二个；
localStorage 里留下的两个 key 也没清。

而**扩展 origin 是所有扩展页面共享的**。

实测（去掉清理后）：主题节结束时的 localStorage 是

```json
{"theme":"system","seeded":"1"}
```

于是后面每一节打开 `page.html`，`preapplyTheme()` 都会读到这个残留的 `'system'`——
首帧全跟着系统偏好走。目前没有用例断言浅色样式，所以没暴露；但这是实打实的跨节污染。

## 修法

1. 存下第二个脚本的 `identifier`，收尾时一并 `removeScriptToEvaluateOnNewDocument`
2. 清掉 `markai.theme` 与 `markai.theme.seeded`
3. **加一条守卫断言**，让污染不可能静默回归

## 验证

```
PASS 主题节不留 localStorage 污染（扩展 origin 是所有页面共享的） · {"theme":null,"seeded":null}
```

**证伪**：去掉清理 →

```
FAIL 主题节不留 localStorage 污染 · {"theme":"system","seeded":"1"}
```

前后对比明确：有清理 `null/null`，无清理 `system/1`。

## 数据

单测 **851** · e2e **187/187（+1）· 108s** · tsc ✅ · build ✅
