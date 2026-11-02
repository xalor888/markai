# v0.2.104 — 删掉一个「一出现就必然点了没用」的按钮

## 怎么发现的

把健康检查的契约测试补全——剩下两个修复动作（`config.fill-defaults`、
`undo.trim-overflow`）还没验过「修完问题是否真的消失」。

写 `config.fill-defaults` 那条时，**种子怎么摆都触发不了**。

## 一路查下去的结论

`readSnapshot` 为了「诊断看到的配置和运行时实际用的是同一份」会走 `resolveConfig`，
而它**已经把预设里能补的都补上了**（`baseUrl`、`defaultModel`）。

于是 `config.incomplete` 只可能在**预设也补不了**时触发——也就是
`custom`（预设全空）和 `opencode-go`（有 baseUrl、没有模型）这两种。

而那恰恰是 `fillConfigDefaults` **什么都填不了**的情况：

| 服务商 | 预设 | 诊断会触发吗 | 修复能干活吗 |
|---|---|---|---|
| openai / deepseek / … | 全有 | 不会（已被 resolveConfig 补上） | — |
| opencode-go | 有 baseUrl，无模型 | **会** | 不能（模型无处可来） |
| custom | 全空 | **会** | 不能 |

**一个要么不出现、一出现就必然点了没用的按钮。**

## 做了什么

删掉：

- `config.fill-defaults` 这个 FixAction
- `fillConfigDefaults` 实现与注册
- `config.incomplete` 上的修复按钮

保留：明确的 `manualHint`（缺 Key 就去拿 Key，缺别的就去设置页补）。
用户本来就得自己做这些事，摆个假按钮只会让他以为点一下就解决了。

## 验证

契约测试现在覆盖**全部**可修复诊断（7 个动作里的 6 个，第 7 个已删）。

**证伪**：把按钮加回去 → 「只缺 Key 时不该给 fix」立刻红。

## 数据

单测 **828** · e2e **143 项 · 84s** · tsc ✅ · build ✅
