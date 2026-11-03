# v0.2.135 — 门禁自己会抖：约 4/20 次无故红一次

## 问题

连续两轮（0.2.113、0.2.131）在基线门禁上看到同一条偶发红：

```
FAIL 系统深色但用户选了浅色时，首帧就是浅的 · {"firstFrameClass":"dark"}
```

复跑就好。约 20 次里 4 次。

**门禁自己不稳定，比没有门禁更糟**——「四道门全绿才提交」这条纪律的前提是门禁可信。

## 根因：一个纯粹的测试时序竞争

原写法是 reload **前**种入用户选择：

```js
localStorage.setItem('markai.theme', 'light');
await cdp.send('Page.reload', ...);
```

但 `themeStore.load()` 在异步读完 storage 后会 `mirrorTheme(t)` 把当前主题**写回**
localStorage。storage 里没有用户选择时 `t = 'system'`——于是先种的 `'light'`
被盖成 `'system'`，而 `shouldStartDark('system', true)` 返回 `true`，**首帧就成了深色**。

与产品逻辑无关：`shouldStartDark('light', true)` 本来就返回 `false`。

## 确定性复现

reload 前把 localStorage 盖回 `'system'`（等价于那次迟到的 mirror）：

```
FAIL 系统深色但用户选了浅色时，首帧就是浅的 · {"firstFrameClass":"dark"}
```

与线上偶见签名**完全一致**。

## 修法

用 `Page.addScriptToEvaluateOnNewDocument` 在**新文档启动时**写入 `'light'`。
它跑在页面脚本之前，`preapplyTheme()` 一定读得到，完全不受先前时序影响。
带一次性标记，反向用例（用户选深色）那次 reload 不会被它盖回去。

## 决定性验证

同一个注入，两种版本：

| 版本 | 注入 `localStorage['markai.theme']='system'` | 首帧 |
|---|---|---|
| 修复前（reload 前种入） | 注入了 | **FAIL** `"dark"` |
| 修复后（新文档内种入） | 注入了 | **PASS** `""` |

打不穿新版。连跑两次均 186/186 干净通过。

## 数据

单测 **851** · e2e **186/186 · 107s**（连续两次干净） · tsc ✅ · build ✅
