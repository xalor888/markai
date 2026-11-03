# v0.2.119 — 两个对不上的数字，模型只能自己猜

## 缺陷

`find_duplicates` 返回：

```json
{ "total": 200, "shown": 50, "note": "重复组按数量降序；…", "items": [...] }
```

`total` 是全部重复组数，`shown` 是本次实际给出的组数（`limit` 默认 50）。

**两个数不一致，但没有任何解释。**

模型看到 200 和 50 对不上，只能自由发挥：

- 可能据此断言「只有 50 组重复」——**漏掉后面 150 组**
- 也可能反复用同一个 limit 重试

这跟 `forget_memory`（0.2.117）、`formatMemoriesForPrompt`（0.2.118）是**同一类假汇报**：给了一部分，却不说还有一部分。

## 修法

截断时把话说全：

```json
{
  "total": 200, "shown": 50, "omittedGroups": 150,
  "note": "共发现 200 组重复，本次按数量降序只返回前 50 组，另有 150 组未列出（limit 默认 50）。如需看完请调大 limit 再查一次。",
  "items": [...]
}
```

不截断时保持原来的 note，不输出 `omittedGroups`——不制造噪音。

## 验证

造 60 组互不相同的重复，默认 limit 50 必然截断：

```
PASS  find_duplicates 截断时说清"还有几组没列出"
```

验：`shown === 50`、`omittedGroups === total - shown`、note 含「另有 N 组未列出」
与「调大 limit」；`limit: 500` 时不截断、无这些字段。

**证伪**：把截断分支的条件改成 `false` →

```
omittedGroups 应等于 total-shown，实际 undefined
```

## 数据

单测 **842**（+1）· e2e **149 项 · 86s** · tsc ✅ · build ✅
