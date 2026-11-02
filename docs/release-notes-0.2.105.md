# v0.2.105 — 命令面板那三个「点了没反应」的隐患，堵上了

## 缺口

命令面板里有三个动作是靠 DOM 自定义事件转交给 workspace 的：

```ts
document.dispatchEvent(new CustomEvent('markai:open-organize-log'));
document.dispatchEvent(new CustomEvent('markai:open-deletions'));
document.dispatchEvent(new CustomEvent('markai:open-shortcuts'));
```

**事件名拼错就是静默失败**：面板项点了、看起来有反应，但什么都没有打开。

这类缺口在快捷键上已经真实发生过一次（Ctrl+D：界面承诺了，代码里没有处理器）。

## 做了什么

一条契约守卫，把「派发的」和「监听的」两组事件名对起来：

- 面板派发的每个 `markai:*` 事件，workspace 必须有人监听
- **反向也查**：workspace 监听的 `markai:*` 事件，必须有人在派发
  （留着没人派发的监听也是腐烂信号）

## 验证

**证伪**：把 `markai:open-shortcuts` 改成 `markai:open-shortcut`（少一个 s）：

```
AssertionError: 命令面板派发了但没人监听的事件：["markai:open-shortcut"]
```

## 数据

单测 **829**（+1）· e2e **143 项 · 84s** · tsc ✅ · build ✅
