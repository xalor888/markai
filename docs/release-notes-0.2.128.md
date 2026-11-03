# v0.2.128 — 你点了「停止」，它把活干完了

## 缺陷

`abort` 信号只传给了 LLM 请求：

```ts
chatCompletion(..., signal)     // ✅ 有信号
executeTool(name, args, onProgress)   // ❌ 没有
```

于是用户在长任务中途点「停止」：

| | 发生什么 |
|---|---|
| 界面 | 立刻显示「已取消」 |
| 这一次工具 | **跑到底** |
| 书签 | 照搬 |
| 删除提议 | 照提交 |
| 额度 | 照烧 |

`cleanup_sweep` 扫几千条链接要好几分钟。这几分钟里用户已经看到「已取消」，
但操作一项没停。

## 修法

`executeTool` 不接 abort 信号，所以走它**唯一的中途入口**——`onProgress`：

```ts
if (signal.aborted) return { error: '已取消，这一步没有执行' };   // ① 开跑前
await executeTool(..., (text) => {
  safePost(onEvent, { type: 'chat:tool_progress', ... });
  if (signal.aborted) throw new Error('已取消，任务中断');        // ② 进度回调
});
```

批量工具（`auto_categorize` / `cleanup_sweep` / `check_urls_bulk`）每处理一批都会调 `onProgress`，
在这里抛出就能让它们**中途真停**。而它们本来就有 catch 兜底，会如实报告「已创建 3 个文件夹，已移动 77 条书签」——不是假装成功。

## 验证

```
PASS 取消能停住工具：点「停止」后不再继续跑、也不再烧额度
```

同一条用例，只差 agent 侧那一行闸，实测两种形态：

| | progress | 事件序列 |
|---|---|---|
| **有闸** | 3 | `tool_start → tool_progress → **tool_error** → cancelled` |
| **无闸** | 20 | `tool_start → tool_progress → **tool_done** → cancelled` |

判据：取消后必须报 `tool_error` 而非 `tool_done`，且**不再发第二次 LLM 请求**。

**证伪**：删掉进度回调里那行 →

```
取消后工具应报 tool_error（被打断），实际事件：…tool_done…
```

失败信息正是症状本身。

## 过程中栽的跟头

第一版测试**直接调 `executeTool`**，测的是预存行为而不是我的修复——证伪两次都绿。
改成走 agent 真实路径才抓住。教训依旧：**证伪绿先怀疑测试没测到修复**。

## 数据

单测 **850**（+1）· e2e **152 项 · 90s** · tsc ✅ · build ✅
