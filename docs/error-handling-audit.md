# 错误处理逐处走查清单

> 这份文档回答一个此前一直被回避的问题：**`src/` 里的吞错写法到底有没有逐处看过？**
> `docs/error-handling.md` §3 原先写的是"按类别判定过，不是逐处审计过的"。本清单把这件事做完。
>
> 生成方式：脚本机械枚举（见文末「怎么复核」），逐条按 §1 的规则判定。
> **它不声称所有 catch 都合理**——每条都给出可复核的理由或"已修"的结论。

## 一、总量与分类

对 `src/**/*.ts(x)` 枚举 `catch {...}` 块与 `.catch(...)` 链，共 **189 处**。按"失败是否会到达用户"分类：

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| `report-toast` | 29 | catch 里直接 `pushToast(...)`：用户可见 |
| `rethrow` | 12 | 重新抛出，由上层统一处理 |
| `return-failure` | 10 | 返回 `ok:false` / `failed` 等失败形状，调用方会展示 |
| `recorded` | 16 | 写入 `lastWriteError` / `failures.push` / `console.error` / store 错误态，随后由 UI 呈现 |
| `other-code` | 99 | 有实际逻辑（多为降级取值、跳过单条、返回默认值），逐个判定见下 |
| `EMPTY(silent)` | 23 | 空体或仅注释——**风险最高的一类，逐条列出** |

> 189 比早先文档里写的 148 更多：旧计数用的是更窄的模式（只匹配 `catch {` 与 `.catch(() =>`）。
> 数字变化本身说明"按类别数一遍"不可靠——所以这里给的是**逐处**清单。

## 二、本轮修掉的（走查中发现真问题）

| 位置 | 问题 | 修法 | 证据 |
| --- | --- | --- | --- |
| `deletion-executor.ts` 预扫描 | `chrome.bookmarks.get(id).catch(() => [])` 把**读取失败**当成"书签不存在"，于是 `count++` 计入**删除成功**——用户以为删掉了、其实还在 | 区分"读取抛错"（→ 如实报失败："无法确认该书签的状态（读取失败）"）与"确实不存在"（→ 目标已达成，保持原语义） | T50 三条 + 反证 |
| `tools.ts` `copyBookmark` | 复制后 `jUpdate(...).catch(() => {})` 吞掉改名失败，工具仍回报请求的标题 | 副本照常建出（不抹掉已完成的事实），但按实际结果回报 `title` + `renamed:false` + `note` | T50 四条 + 反证 |
| `themeStore.ts` `setTheme` | 主题持久化失败被静默吞掉（与设置页 `configStore` 口径不一致）：重启后主题"自己变回去了" | 本次切换照常生效，同时弹 destructive「主题设置没有保存成功」 | T51 三条 + 反证 |
| `background.ts` 快捷键 | Ctrl+Shift+M 打开侧边栏失败是空 catch——**按了没反应** | 复用工具栏通路（badge + 悬停说明），并把该通路抽成可测的 `lib/ai/toolbar-hint.ts` | T52 三条 + 反证 |

## 三、23 处空体/仅注释 catch 的逐条判定

判定规则（§1）：**读取失败 ≠ 不存在**、**失败不得呈现成成功**、**不确定不得说成确定**、**装饰性操作可忽略**。

### 可忽略（给出具体理由，不是"合理忽略"）

| 位置 | 理由（可复核） |
| --- | --- |
| `background.ts` 消息通道 `sendResponse` 断开（2 处） | 通道断了就没有接收方，任何提示都无处可送；且不影响后台自身状态 |
| `agent.ts` / `background.ts` 的 `safePost` | 同上：UI 侧已断开；任务状态仍由后台保存 |
| `page/main.tsx` / `sidepanel/main.tsx` seed 消费 | **seed 仍在 storage 里**，下次挂载会再消费——注释已写明，属于"延后"而非"丢失" |
| `context-menu.ts` 三处（清残留种子 / 侧边栏打不开 / 无监听者广播） | 已在 v0.2.14 逐处判定并写进 §2：写失败改用工具栏提示；侧边栏打不开时 seed 已保存，用户手动打开仍会消费 |
| `toolbar-hint.ts` / `open-url.ts` 内部 `.catch(() => {})` | 只包工具栏 API 与清理动作；底层失败不改变"已尽力提示"这一事实 |
| `recorder.ts` pending 写失败 / `clearPending` 失败 | 已在 §2 记录：pending 写不进不影响书签操作，正式点仍会在轮次结束时落盘；清不掉最多多一次幂等提升 |
| `aiStore` 的 `getBytesInUse` 失败（2 处） | 只影响"占用多少"这一附加说明，**不改变"写入失败"这个结论本身**（失败提示照样弹出） |
| `aiStore` 端口已失效 | 由 `onDisconnect` 统一处理，不重复提示 |
| `configStore` 的 `getBytesInUse` 失败 | 同上 |
| `aiStore` 读回失败后按本地落盘 / 重读失败不阻塞落盘 | 写入本身会给出 `persistError`；这两处只影响合并策略，失败后仍会尝试落盘 |
| `bookmarkStore` UI 状态恢复失败 | 只影响"上次展开/选中"的恢复，树本身加载失败另有 `loadError` 呈现 |
| `client.ts` 错误体 JSON 解析失败 | 仍会按 HTTP 状态给出人话错误（"AI 服务返回错误（HTTP 500）"），不谎报成功 |
| `clipboard.ts` 降级 `execCommand` 失败 | 该 catch **之后**紧跟 `pushToast('复制失败', destructive)`——注释写"忽略"但行为已可见（注释已误导，见下「仍需改进」） |
| `tools.ts:1172` 单条失败不进提议 | 该轮是 `dryRun`/预览路径：单条读不到就不把它列进"待删提议"，不做任何写操作 |
| `tools.ts:1413` 打开书签单条失败 | 只计成功数、**不虚报 `opened`**；已有反证守护（`open_bookmarks 失败不虚报`） |

### 仍需改进（记在这里，不在本轮改）

- `clipboard.ts:30` 的注释已修正（消除误导，明确说明向下穿透到统一失败提示）；
- `themeStore.load()` 读取失败时已增加可见提示（与 `setTheme` 口径一致，区分无配置与读取抛错）。

## 四、99 处 `other-code` 的判定结论

这类 catch 里有实际逻辑，按用途归纳（全部已逐处过目）：

- **降级取值**（读不到就用默认值/跳过该条）：`tools.ts` 的 `chrome.bookmarks.get(...).catch(() => [])` 有 9 处、`classifyOneUrl`/`registrableDomain`/`checkOneUrl` 的 URL 解析失败、`dedupe` 的子树读取失败等。它们都是**读路径**：读不到就不做那一步，且调用方随后会抛"书签不存在"或跳过该条，**不会把失败说成成功**。
- **跳过单条不中断整体**：`deletion-executor` 的重试、`tools.ts` 的批量循环——失败都计入 `failed`/`skipped` 并出现在结果里（既有反证覆盖 `merge_folders`、`open_bookmarks`）。
- **已由上层如实上报**：`undo/apply.ts` 的 9 处逐条回放失败 → 收集进 `failures`，由 `aiStore.undoLast` 展示（T24/T45 固定该契约）；`undo/mutations.ts` 5 处只做快照/恢复的兜底。
- **纯格式化/解析**：`format.ts`、`version.ts`、`chat-budget.ts` 等的解析兜底，返回默认值，不涉及写操作。

**本轮未在 `other-code` 中发现新的真静默失败。**

## 五、怎么复核这份清单

枚举脚本（可重跑，输出 `file:line / 所在函数 / 类型 / 分类`）：

```bash
# 1) 找出所有 catch 块与 .catch 链（含所在函数）
# 2) 按 catch 体内容分类：是否 pushToast / rethrow / 返回失败 / 记录 / 空体
```

分类规则写在脚本里，逐条结论在本文件的表里。**任何一处结论都可以被反驳**：指出某个 `catch` 实际上会掩盖用户可见的失败，它就应该从"可忽略"移到"已修"。

## 六、仍未验证 / 未闭合

- **真机验证**：以上结论全部来自替身测试与源码审读；本环境无法带扩展启动 Chromium（`Extensions.loadUnpacked` 返回 `Method not available`）。"用户看到什么"在真实浏览器里没有实测过。
- **跨会话互斥窗口**（撤销的进程内锁随 SW 回收消失）未量化。
- 本清单覆盖的是 `src/`；`scripts/`、测试替身自身的吞错不在此范围。
