# v0.2.149 — 同一个名单抄了两份，谁也不知道哪份是真的

## 缺陷

`READ_TOOLS`（可并行的只读工具）在**两个文件里各定义了一份**：

- `src/lib/ai/agent.ts:41`
- `src/lib/ai/turn-plan.ts:25`

两份内容目前一模一样（各 15 个工具），但这是**重复维护**：以后加一个只读工具，
很可能只改一处。后果不对称：

- 只改 `agent.ts` → `turn-plan` 认为它是写类 → **本该并行的读任务被串行排队**（慢，但不坏）
- 只改 `turn-plan.ts` → **写类工具被当成 read 并发跑**（真的坏：并发写同一父目录会打乱顺序）

第二种正是 0.2.140 那个「并发撤销点竞争」的翻版，只是从另一个入口进来。

这是顺着 0.2.148 那条线追下来的：那轮修的是 `PAGINATED_TOOLS` 名单与 schema 不同步；
这次问的是「还有哪些名单是手抄的」——`READ_TOOLS` 抄了两份。

## 修法

本轮先**加守卫**把事实钉住，不改结构：新增一条单测，从两个文件的源码里各自解析出
`READ_TOOLS` 集合，要求两边**元素完全相同**（不只是数量相同，双向逐一比对）。

```ts
const a = sets[0]!;  // agent.ts
const b = sets[1]!;  // turn-plan.ts
assert.equal(a.size, b.size, `两个文件的工具数不同（agent.ts ${a.size} / turn-plan.ts ${b.size}）`);
for (const tool of a) assert.ok(b.has(tool), `${tool} 在 agent.ts 里，但 turn-plan.ts 没有`);
for (const tool of b) assert.ok(a.has(tool), `${tool} 在 turn-plan.ts 里，但 agent.ts 没有`);
```

（合并成单一导出是更彻底的做法，但要动 `turn-plan.ts` 的模块依赖方向，留作后续。）

## 验证

单测 864 → **865**。

**证伪**（从 `turn-plan.ts` 删掉 `get_folder_content`）：

```
[DBG] src/lib/ai/agent.ts: 15 个工具
[DBG] src/lib/ai/turn-plan.ts: 14 个工具
✘ READ_TOOLS 在两处的定义必须完全一致
❌ 两个文件的工具数不同（agent.ts 15 / turn-plan.ts 14）
```

恢复后 865 全绿。

## 数据

单测 **865**（+1）· e2e **199/199 · 118s** · tsc ✅ · build ✅
