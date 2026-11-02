# v0.2.69 — 「标记为不可撤销」点完，问题还在

## 问题

健康检查会报：

> 3 条记录已经无法撤销
> 它们对应的撤销点已被上限挤掉。标记之后，面板上不会再显示一个点了没用的「撤销」。
> [标记为不可撤销]

点下去，修复成功，记录上也确实被打上了 `unreversibleAt` 标记。

**但问题还在。**

因为上报这条问题的判据是：

```ts
const orphan = usable.filter(e => e.runId && !undoIds.has(e.runId) && !e.undoneAt);
```

它排除了 `undoneAt`（撤销过的），**却没排除 `unreversibleAt`**——而那正是这个修复写下的标记。

于是：修复 → 标记写好 → 判据不认 → 问题原样还在、健康分不动。
用户看到的是「点了没反应」。

## 修法

```ts
const orphan = usable.filter(
  e => e.runId && !undoIds.has(e.runId) && !e.undoneAt && !e.unreversibleAt,
);
```

## 验证

**T125 两条**，第一条是我想要的那种形态——**让修复自己验证自己**：

1. 种一条孤儿记录 → 诊断**必须**报 `log.orphan`
2. `runFix('log.mark-orphan')` → 必须成功
3. 磁盘上**必须**带上 `unreversibleAt`
4. 用磁盘上的真实内容**重新诊断** → `log.orphan` **必须消失**

第 4 步是关键。前 3 步都只证明"修复跑了、标记写了"，
只有第 4 步证明"用户看到的问题真的没了"。

**证伪**：改回旧判据 →

```
修完之后还在报孤儿记录——"修了但没修好"：["log.orphan"]
```

## 顺带核对了其余修复动作

`config.normalize-baseurl` / `config.drop-bad-headers` / `undo.drop-corrupt` /
`undo.trim-overflow` / `log.trim-limit`——它们改的都是判据本身读的字段，
修完会真的消失。只有 `log.mark-orphan` 这一处写了判据不认的字段。

## 写进台账的规矩

> **任何"修复"动作都要能让自己上报的那条问题消失。**
> 判据和修复必须读同一个信号，否则就会出现"点了没反应"。
> 测试应该断言"修复后重新诊断结果变干净"，而不是"修复函数返回 ok"。

## 数据

单测 **781**（+2）· e2e **88 项 · 57s** · tsc ✅ · build ✅
