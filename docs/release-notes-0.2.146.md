# v0.2.146 — 取消掉的改动，被当成「什么都没做」

## 缺陷

`retrySafety()` 只把 `status === 'done'` 的写类工具算作「这一轮改过了」：

```ts
if (b.record.status !== 'done') continue;
if (MUTATING_TOOLS.has(b.record.name)) mutations++;
```

取消发生在工具执行**中途**时，前面的部分已经改到书签上了：

> 批量移动 100 条，移到第 40 条时用户点取消 —— 那 40 条是**真的移走了**，撤销点里也有。

但 `canceled` 不计入 mutations → 界面认为"这轮什么都没做、可以安全重来" →
用户重发同一句就会**再移一遍**。

## 顺带：取消在界面上长得像报错

`ToolStatus` 只有 `running | done | error`，取消只能塞进 `error`——
于是用户自己主动点的「停止」，显示成一个**红色警示三角 + 红字**，用的是"出错了"的视觉语言。

## 修法

1. `ToolStatus` 增加 `canceled`，agent 按 `signal.aborted` 区分：
   - `canceled`：用户主动停止（已完成的工作量可撤销）
   - `error`：工具内部抛错
2. `ToolChip` 用中性样式渲染 `canceled`（`CircleStop` + `已停止`），且**不自动展开**
3. `retrySafety` 把 `canceled` 的写类工具**计入 mutations**

第 3 条的取舍：宁可多提示一次"已经改过、要退回请点撤销"，
也不能让用户重复执行造成数据错乱。

## 验证

新增 2 项单测（858 → **860**）：

```
PASS 写类工具被取消也算改动（否则重试会重复执行已落地的那部分）
PASS 只读工具被取消不算改动（它本来就改不了东西）
```

**证伪**（把 `canceled` 从计入条件里去掉）→ 转红：

```
✘ 写类工具被取消也算改动
❌ 取消的写类工具没有被算作改动
```

## 数据

单测 **860**（+2）· e2e **199/199 · 114s** · tsc ✅ · build ✅
