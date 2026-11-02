# v0.2.66 — 第五处盲写：一个开关能清掉整份配置

## 位置

顶栏「更多」菜单里那个**自动整理开关**，自己写了一套读写：

```ts
const d = await chrome.storage.local.get('markai.config').catch(() => ({}));
const cfg = (d['markai.config'] ?? {}) as Record<string, unknown>;
const next = !(cfg.autoOrganizeNew ?? true);
await chrome.storage.local.set({
  'markai.config': { ...cfg, autoOrganizeNew: next },   // ← 整对象覆盖
});
```

读失败时 `cfg` 退化成 `{}`，接着写 `{ ...{}, autoOrganizeNew: true }`。

**整份配置被一个布尔字段覆盖**：API Key、Base URL、模型、删除模式，全没了。

## 为什么 0.2.61 没修到它

0.2.61 修的是 `configStore.update()`——但这里**绕开了 store**，自己又实现了一遍
"读 → 改 → 写"。store 里的保护（`loadOk` 检查）完全没被用上。

**同一个数据有两套写入路径，只修一套等于没修。**

## 修法

直接用 store：

```ts
const config = useConfigStore((s) => s.config);
const r = await useConfigStore.getState().update({ autoOrganizeNew: next });
if (!r.ok) pushToast('开关没有保存成功', { description: r.error });
```

- 复用 0.2.61 的 `loadOk` 保护（读不到就不写）
- 失败会提示，不再是 `.catch(() => {})` 静默吞掉
- 开关状态从 store 读，不再自己维护一份可能过期的副本

## 验证

e2e：种一份带 API Key 的配置 → 打坏 `markai.config` 的读取 → 打开更多菜单点开关 →
**API Key / 端点 / 模型必须还在**。

**证伪**：改回原来的盲写写法 → 立刻转红，实测确实被抹掉。

## 这一轮我写错了一条断言

第一版读回配置用的是**同一个被打坏的页面**，`get` 直接 reject → 读到 `null` →
断言把"读不到"误报成"被覆盖"。

也就是说：**我的断言自己成了假阳性来源**。改成用没注入坏 `get` 的页面读回来才对。

同类教训第 N 次：断言里的"读"也会失败，必须用可信的数据源来验证。

## 五处盲写

| 版本 | 位置 | 被覆盖的东西 |
|---|---|---|
| 0.2.60 | `markai.ai` | 全部聊天记录 |
| 0.2.61 | `configStore.update` | 全部配置 |
| 0.2.62 | `markai.undo` | 全部撤销点 |
| 0.2.63 | 长期记忆 | 全部长期记忆 |
| 0.2.66 | more-menu 开关 | 全部配置（绕开 store 的第二条路径） |

## 数据

单测 **771** · e2e **87 项 · 56s**（+1）· tsc ✅ · build ✅
