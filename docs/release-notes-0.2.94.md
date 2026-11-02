# v0.2.94 — 那条说不清道不明的偶发，定位了

## 症状

```
FAIL  系统深色但用户选了浅色时，首帧就是浅的（不被系统偏好带偏）
       {"firstFrameClass":"dark"}
```

近期约 20 次里出现 4 次。台账里一直写着「已缓解、未定位」。

## 根因

测试自己的时序问题，**不是产品缺陷**：

```js
// 原来
await cdp.send('Runtime.evaluate', {
  expression: `localStorage.setItem('markai.theme', 'light'); …`,
}, sid);
await cdp.send('Page.reload', {}, sid);
```

刚 `Target.createTarget` 出来的页面**可能还没就绪**，这次 `Runtime.evaluate`
会静默失败——而代码没看 `exceptionDetails`。

于是 localStorage 里留着**上一轮**的 `'dark'`，首帧就成了深色。

因为它只在「页面恰好没就绪」时发生，所以表现为偶发。

## 怎么修的

两件事：

1. **等页面就绪**再写（`document.readyState === 'complete'`，CDP 抛错不当成已就绪）
2. **写完回读确认**——新增一条用例：

```
PASS  测试前置：localStorage 里确实写进了 light  {"seeded":"light"}
```

第 2 条是关键：**这个 race 从此不再安静**。种子没写进去会直接红，
而不是绕个弯在主题断言上表现成「产品有问题」。

## 验证

证伪：把种子写到错的键（`markai.theme.WRONG`）→ 新守卫和主题断言**同时转红**，
而且主题那条的失败形态与偶发**完全一致**（`firstFrameClass:"dark"`）。

这说明守卫确实守着同一个失效路径。

## 过程中差点又误判一次

抓偶发的过程中我 `kill -9` 过 e2e 进程，留下一个陈旧 Chrome 占着 CDP 端口 9333，
新跑起来的 e2e 连到了**错的浏览器实例**，一次性报了 6 条失败。

清掉陈旧进程后立刻恢复 129/129 · 73s。

> 教训：**跑测试之前先确认没有上一轮的残留进程**，否则会把环境问题当成产品问题。

## 数据

单测 **822** · e2e **129 项 · 75s**（+1）· tsc ✅ · build ✅
