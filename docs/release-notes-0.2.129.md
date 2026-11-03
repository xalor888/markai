# v0.2.129 — 侧边栏此前零覆盖，一测就测出 320px 横向滚动

## 从一个覆盖空洞开始

e2e 覆盖了 `page` / `popup` / `options` / `background`，**唯独没有 `sidepanel`**。

而侧边栏是点扩展图标打开的那个界面，也是本扩展的主界面。它要是白屏、崩在挂载、
或者三栏少一栏，整套测试一项都抓不到——用户点开图标就是一片空白。

## 补上覆盖

新增一节，在新标签页打开 `sidepanel.html`，验 5 项：

```
PASS 侧边栏真的挂载了（不是白屏）
PASS 侧边栏有顶栏与书签列表（compact 双栏成立）
PASS 侧边栏没有错误边界被触发
PASS 侧边栏列出了书签（store 已加载）
PASS 侧边栏没有横向溢出（紧凑布局成立）
```

（断言按 **compact 设计**写：树 + 列表双栏、树默认收起、Agent 面板是右侧抽屉——
见 `workspace.tsx` 头部注释。按 full 模式「三栏常驻」断言会把设计当成缺陷。）

## 一测就测出一个真缺陷

第 5 项当场红：

```
侧边栏没有横向溢出（紧凑布局成立） · {"spOverflow":320}
```

溢出来的是 **Agent 抽屉**：`absolute inset-y-0 right-0 z-20`，收起时
`translate-x-full` 把整个 320px 面板平移到容器右外侧。

它虽然 `pointer-events-none`，却仍然撑出 320px 的文档横向滚动——
**用户能把整个应用横向拖进一片空白**。

## 修法

给主体容器加 `overflow-hidden`：

```diff
- <div className="relative flex min-h-0 flex-1">
+ <div className="relative flex min-h-0 flex-1 overflow-hidden">
```

打开态锚在 `right-0` 向内生长，永远在容器内，所以剪不到它；剪掉的只有收起态。

## 验证

```
修复后：{"spOverflow":0}
证伪（去掉 overflow-hidden）：{"spOverflow":320} → 转红
```

## 数据

单测 **850** · e2e **157/157（+5）· 91s** · tsc ✅ · build ✅
