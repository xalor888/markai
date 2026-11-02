# v0.2.85 — 把 19 个没人碰过的导出补上测试

## 背景

台账里「单测覆盖 `lib/` 下未被任何用例触达的导出」挂了很久。

全量扫了一遍：**188 个导出函数，19 个没被任何用例引用**。

逐个看过风险，取高价值的 8 个补上。

## 补了什么

| 导出 | 为什么值得测 |
|---|---|
| `deleteMemoryItem` | 删失败必须返回 `false` 而**不是假装成功**，且不能改动数据 |
| `clearAllMemories` | 清空后必须是 `[]`，不能是 `undefined`（下游 `.filter` 会炸） |
| `unrestorableOps` | **只认「没有快照的删除」**——判宽了会拒绝掉本来能撤的操作 |
| `describeUndoPoint` | 给用户看的是人话，不能把 JSON 结构直接丢出来 |
| `isKnownOpKind` | 白名单之外的 Kind 一律不认（含大写 `MOVE`） |
| `finalizeToolCalls` | 空参数必须补成 `'{}'`——模型侧 `JSON.parse('')` 会直接抛 |
| `cn` | falsy 值要被丢掉，不能变成字符串 `"false"` |
| `copyText` | 空文本/纯空白直接拒绝，**不弹「已复制」** |

## 三条我写错的断言（都是我的问题，不是代码的）

1. `deleteMemoryItem` 失败后我断言数据还是 2 条——可前面刚成功删掉一条，**本来就只剩 1 条**
2. `isKnownOpKind` 我按印象写了 `copy` / `rename`——真实白名单是
   `move / moveBatch / update / create / delete`
3. `cn('text-red', false && 'hidden', 'text-blue')` 我期望 `'text-red text-blue'`——
   实际上 twMerge 会把同组的 `text-red` 覆盖掉，正确结果就是 `'text-blue'`

第 3 条尤其值得记：**我先按"我觉得它该怎么工作"写了期望值，而不是先看它怎么工作。**
好在断言立刻红了，逼我去读实现。

## 验证

T134 八条。

证伪两条：

- 致盲 `unrestorableOps`（不判断快照）→ 现有测试转红
- 致盲 `deleteMemoryItem`（不判断是否真删掉）→ 新测试转红

## 数据

单测 **822**（+8）· e2e **107 项 · 62s** · tsc ✅ · build ✅
