# v0.2.130 — 侧栏拖窄后，Agent 输入框的左边被切掉了

## 从一个没测的状态开始

上一轮（0.2.129）给侧边栏补了 e2e，但只测了**抽屉收起**的状态。

而真实场景是：你把侧栏拖窄，然后打开 Agent 面板——流式期间 compact 模式会**自动**打开它
（`workspace.tsx`：`if (streaming && mode === 'compact' && !chatOpen) setChatOpen(true)`）。

## 一测就红

在 360 / 300 / 260px 三个窄档位打开抽屉：

| 侧栏宽度 | 抽屉实际宽度 | 可见 | 左边被切 |
|---|---|---|---|
| 360px | **320px** | 320 | 0 |
| 300px | **320px** | 300 | **20px** |
| 260px | **320px** | 260 | **60px** |

**输入框左侧和左对齐控件直接看不见又点不到。**

## 根因：一个从来没生效的钳制

ChatPanel 上写着：

```tsx
style={{ width: chatWidth, maxWidth: `min(100%, ${CHAT_WIDTH_MAX_COMPACT}px)` }}
```

想把自己钳在侧栏宽度内。但抽屉和内层容器**都没有定宽**——靠内容收缩适应。
而 CSS 里百分比对**收缩适应的包含块**解析为 `auto`，所以这个 `100%` 从来没生效过。

不是新 bug，是**一直没被发现的死代码**：宽视口下侧栏总比 320 宽，看起来一切都对。

## 修法

给两层容器定宽：

```diff
- 'absolute inset-y-0 right-0 z-20 transition-transform duration-150'
+ 'absolute inset-y-0 right-0 z-20 w-full transition-transform duration-150'
- <div className="relative h-full">
+ <div className="relative h-full w-full">
```

`100%` 有了解析基准。收起态不变——`translate-x-full` 移动的是自身全宽。

## 验证

| 侧栏 | 修复后 |
|---|---|
| 360px | `drawerW:320, right:320`（完整可见） |
| 300px | `drawerW:300, right:300` |
| 260px | `drawerW:260, right:260` |

**证伪**：去掉 `w-full` →

```
FAIL 侧边栏 300px 下抽屉宽度不超过侧栏本身 · {"drawerW":320,"drawerRight":300}
FAIL 侧边栏 260px 下抽屉宽度不超过侧栏本身 · {"drawerW":320,"drawerRight":260}
```

## 顺带

给 `ChatPanel` 根节点加了 `data-testid="chat-panel"`。第一版选择器抓错了元素
（抓到拖拽手柄，宽度 0），断言**空过**——加了「抽屉真的打开了」这条前置才堵住。

## 数据

单测 **850** · e2e **170/170（+13）· 97s** · tsc ✅ · build ✅
