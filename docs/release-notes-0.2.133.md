# v0.2.133 — 一条从没执行过主体动作、却一直报绿的测试

## 缺陷

健康检查的「一键修复不改动任何书签」这条用例，代码长这样：

```js
const btn = [...document.querySelectorAll('button')].find(b => /修复全部/.test(b.textContent || ''));
if (!btn) return { ok: true, clicked: false, before };   // ← 按钮找不到就直接返回
btn.click();
...
check('一键修复不改动任何书签', repaired.after === repaired.before, ...);
```

**而紧挨着它的注释早就写明了这个危险**：

> 先造一个**确实可修**的问题，否则「修复全部」按钮不会出现——
> 而 `!btn → clicked:false` 会让这条用例**静默空转**

注释意识到了，断言却没防：按钮找不到时 `before` 和 `after` 是同一个数，
`after === before` 恒真，**用例照样绿**。

一个从没执行过主体动作却一直报绿的测试，比没有测试更危险。

（顺带：`0.2.68` 去掉「缺 API Key」那个点了也没用的按钮后，这条用例就一直在靠
"自己造一个可修问题"撑着——而那个"造"的步骤一旦失效，没有任何东西会报警。）

## 修法

补一条前置断言，把「按钮真的被找到并点到」钉住：

```js
check('「修复全部」按钮确实存在并被点到（否则这条用例是空转）', repaired.clicked === true, ...);
check('一键修复不改动任何书签', repaired.clicked === true && repaired.after === repaired.before, ...);
```

## 顺带修一个转义 bug

同一轮审计模板字面量转义（上一轮的那类 bug）时发现：

```js
hasFixAll: /修复全部（\d+）/.test(text),   // 在模板字面量里
```

`\d` 的反斜杠被丢掉，正则实际是 `/修复全部（d+）/`——**恒不匹配**。
这个字段算了却没有任何断言用它，所以一直是死的。已改成 `\\d`。

## 验证

**证伪**：把 `btn` 改成恒 `undefined`（模拟按钮找不到）→

```
FAIL 「修复全部」按钮确实存在并被点到（否则这条用例是空转） · {"clicked":false}
FAIL 一键修复不改动任何书签 · {"clicked":false}
```

两条同时转红——正是修复前会被静默放行的那条路径。

## 数据

单测 **850** · e2e **187/187（+1）· 108s** · tsc ✅ · build ✅
