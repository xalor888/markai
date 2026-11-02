# v0.2.82 — 请求失败时，「重新生成」藏在 hover 里

## 问题

消息底部的操作条（复制 / 重新生成）平时是 **hover 才出现**的：

```tsx
<div className="-ml-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
```

请求失败时，**「重新生成」是用户唯一能做的事**。但：

- 键盘用户没有 hover
- 触屏没有 hover

于是失败时那个按钮**看不见也点不到**，用户只看到一条 toast 说"请求失败"。

## 根因：失败没有被当成一种状态

我原本只想改 CSS（失败时常亮）。但查下去发现真正的问题在上层：

```ts
// aiStore：请求失败时
{ ...m, blocks: [...m.blocks, { kind: 'text', text: `⚠ ${evt.message}` }] }
```

失败只是在 blocks 里**追加了一个 `⚠ …` 文本块**。

于是一条失败消息和一条正常回复**完全无法区分**：`hasText` 为真、`retrySafety` 照常放过、
界面也没有任何依据知道"这一轮失败了"。

## 修法

给 `ChatMessage` 加一个显式字段：

```ts
/** 这一轮请求失败了（网络 / 401 / 5xx / 超时） */
failed?: string;
```

- `aiStore` 在 `chat:error` 时写它——**`failed` 是状态，文本块只是显示**，两者都要
- `message-view` 按 `message.failed` 判断是否常亮操作条

## 验证

e2e 一条，在**真实的 401 场景**里（mock 服务返回 401，走完整条错误路径）：

```
PASS  请求失败时消息操作条是常亮的（重试不依赖 hover）
  {"found":true,"opacity":1,"failed":"1","count":2}
```

`failed:"1"` 说明状态真的落到了消息上，`opacity:1` 说明按钮真的常亮。

**证伪**：去掉 `failed: evt.message` → 立刻转红。

## 过程中踩的三个坑

1. **选择器没转义**：`div.-ml-1` 里的连字符要转义，改成按 className 包含匹配
2. **`.group` 被别的组件占用**（拖拽把手），且那段还没有助手消息 →
   给消息根加 `data-testid="assistant-message"`、操作条加 `data-testid="message-actions"`
3. **读到过渡中间帧**：`transition-opacity` 让第一次读到 `opacity: 0.03` →
   改成先 `waitFor` 等过渡完，再单独读详情

## 数据

单测 **807** · e2e **107 项 · 61s**（+1）· tsc ✅ · build ✅
