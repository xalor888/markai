# v0.2.153 — 新会话里被静默截断

## 缺陷

超过 60 条消息时，界面会提示「对话较长，仅保留最近 60 条消息」。
但那个提示**一辈子只出现一次**：

```ts
/** 超长会话截断提示已提醒过（避免每次发送重复提示） */
let truncateWarned = false;   // ← 模块级 boolean
```

只有 `clearMessages()`（清空当前会话）会复位它。`createConversation()`（**新建会话**）不复位。

于是：

1. 会话 A 聊满 60 条 → 提示一次 → `truncateWarned = true`
2. 用户新建会话 B
3. 会话 B 也聊满 60 条 → **一声不响地丢掉更早的消息**

用户在新会话里被静默截断，完全不知道早期对话已经没了。

## 实测（真驱动 `send()` 走完两次长对话）

```
[DBG] 会话A 提示 1 次，会话B 提示 0 次
```

## 修法

把模块级 boolean 换成**按会话 id 记录**的集合：

```ts
const truncateWarned = new Set<string>();
...
const convId = get().activeId;
if (before > MAX_MESSAGES - 2 && convId && !truncateWarned.has(convId)) {
  truncateWarned.add(convId);
  pushToast(`对话较长，仅保留最近 ${MAX_MESSAGES} 条消息`, { variant: 'default' });
}
```

`clearMessages()` 改成只删当前会话的标记（清空后再聊满还能再提醒一次）。
文案里的 `60` 也换成 `MAX_MESSAGES`，不再和常量脱钩。

## 验证

新增 1 项单测（869 → **870**），真的调两次 `send()`（不是只测纯函数）：

1. 会话 A 塞 59 条 → `send()` → 提示
2. 复位 streaming → `createConversation()` → 断言真的切到了新会话
3. 会话 B 塞 59 条 → `send()` → **必须再提示**

修复后：

```
[DBG] 会话A 提示 1 次，会话B 提示 1 次
```

**证伪**（退回全局一次性标记）→ 转红：

```
[DBG] 会话A 提示 1 次，会话B 提示 0 次
✘ 新建会话后再次长对话，仍要提示「只保留最近 N 条」
```

## 过程中的一个坑

测试第一次没通过，但不是产品的问题：`send()` 结束后 `streaming` 仍是 `true`，
而 `createConversation()` 开头 `if (get().streaming) return;` —— **它静默提前返回了**，
会话根本没切过去，`activeId` 还是 A（A 已在集合里，自然不提示）。

补了一行 `assert.notEqual(activeId, 'conv-A', '前置：必须真的切到了新会话')`，
让这种"前置没成立"的情况直接报出来，而不是伪装成产品缺陷。

## 数据

单测 **870**（+1）· e2e **199/199 · 121s** · tsc ✅ · build ✅
