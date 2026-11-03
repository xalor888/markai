# v0.2.115 — toast 说 1000 万，实际生效 200 万

## 缺陷

「拉取模型列表」时，如果服务商返回了当前模型的 `context_window`，设置页会自动填进去：

```ts
if (typeof res.contextWindow === 'number' && res.contextWindow >= 8000) {
  void update({ contextWindow: res.contextWindow });
}
```

**只校验了下限，没有上限。**

而 `effectiveContextWindow` 里有护栏：

```ts
return clamp(explicit ?? known, 2000, 2_000_000, known);
```

于是服务商报个 `context_window: 10_000_000`：

1. toast 说「获取到 N 个模型，deepseek-chat 上下文 **10000000**」
2. 设置页自动填入，**存进配置的是 1000 万**
3. 真正生效的是 **200 万**（被静默钳回）

**用户被两个数字耍。** 而且那个 1000 万会一直留在配置里。

## 修法

把边界提成导出常量，**所有写入点共用同一组**：

```ts
export const MIN_CONTEXT_WINDOW = 2_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;
```

自动填入改为：

```ts
if (typeof res.contextWindow === 'number' && res.contextWindow >= MIN_CONTEXT_WINDOW) {
  void update({ contextWindow: Math.min(Math.round(res.contextWindow), MAX_CONTEXT_WINDOW) });
}
```

`effectiveContextWindow` 与 `agent.ts` 的护栏也改成引用这两个常量——原来三处各写一遍字面量，正是会漂移的根源。

## 验证

```
PASS  上下文窗口边界只有一组，且自动填入也按它收窄
```

验三层：常量本身的行为（超上限钳回、低于下限钳回、区间内原样生效）、
写入路径真的用了上限、**不再有硬编码字面量当边界**。

**证伪**：把 `Math.min(Math.round(res.contextWindow), MAX_CONTEXT_WINDOW)` 改回原样透传 →

```
自动填入必须真的把 contextWindow 钳到上限
```

## 数据

单测 **838**（+1）· e2e **149 项 · 86s** · tsc ✅ · build ✅
