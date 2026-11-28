你负责 MarkAI 的 `ideas-agent` 工作线。工作区就是当前目录 `/Users/xalor/orca/workspaces/markai/ideas-agent`，分支 `xalor888/ideas-agent`，已快进到 `2ab6cd6`（root 的宠物/对外接口提交，含共享接缝与统一测试入口）。

## 硬性作业规则（先读，违反任何一条都算失败）

1. **不要调用 `update_goal` / `create_goal` / `update_plan`**。上一轮就是连续 9 次调用 `update_goal` 被系统掐死的。直接干活，用 `apply_patch` 改文件，用 shell 验证。
2. 不要改 `package.json` 的版本号、不要 push、不要合并 `main`、不要提交 `promo/`。
3. 不要改 `tests/agent.test.ts`。新测试写 `tests/ideas.test.ts`，已由 `scripts/run-tests.mjs` 自动发现，无需改 package.json。
4. 只改下面列出的文件；必须动共享文件时改动最小，并在最终报告里逐条列出。
5. 中文注释，注释解释"为什么"不是"做了什么"。每个可见控件有稳定 `data-testid` 与 `aria-label`。
6. 不写占位/降级冒充交付：每个功能都要真的能用。

## 权威范围

先读 `docs/parallel/ideas-agent.md`（范围与完成标准）与 `docs/parallel/README.md`（共享接缝约束），它们是权威。下面只补充现状与易踩的坑。

## 当前代码现状（必须基于它实现，不要凭空造）

- `src/lib/features/ideas.ts`：`Idea` / `IdeaInput` / `IdeaEvidence` / `registerIdeaGenerator()` 已定稿，签名不能改，只能加可选字段。
- `src/lib/ideas/register.ts`：现在是占位，`installIdeas()` 里 `registerIdeaGenerator(null)`。你要换成真实实现。
- `src/components/ideas/idea-button.tsx`：现在只弹 toast。改成打开面板，保留 `data-testid="idea-entry"`。
- `src/components/chat/composer-extras.tsx`：`ComposerImageButton` 现在只弹 toast。改成真实选图。调用方是 `src/components/chat/chat-panel.tsx:834`（`<ComposerImageButton disabled={streaming} />`）——允许你给这个组件加可选 props，但不要大改 chat-panel 结构。
- `src/lib/ai/types.ts` 的 `ChatMessage`：加可选 `images?: { dataUrl: string; name: string; w: number; h: number }[]`（只加可选字段）。
- `src/lib/ai/client.ts` 的 `ApiMessage.content` 现在是 `string | null`，要扩成 `string | Array<...>`（OpenAI 兼容 content parts）。
- `src/stores/aiStore.ts` 的 `send(text, opts?)` 签名保持不变；图片通过可选参数或附件 store 传入，别破坏现有 1112 项测试。
- `src/lib/bookmarks/insights.ts`：`analyzeLibrary()` / `normalizeUrlForDup()` / `pickDuplicateKeeper()` 可复用，不要重写去重规则。
- 书签根命名：不得把「其他书签 / 移动设备」根级书签叫「游离」，见 `RALPH.md`。`unfiled` 的文案要说"根级散落的书签"。
- Chrome 的 `dateLastUsed` 可能缺失；缺失时用 `dateAdded` 估算，并在 `evidence.text` 里明说"按收藏时间估算"，不许把估算写成实测。

## 交付清单

A. `src/lib/ideas/rules.ts`（纯函数）：`stale` / `duplicate` / `empty-folder` / `cluster` / `unfiled` 五类，每条有 `evidence`（≥1 条，`sampleIds` ≤5 且都真实存在）与可编辑 `prompt`；排序 quick 优先、再按 count 降序、同分按 id 稳定；冷却 7 天（storage key `markai.ideas.seen`，带上限与过期清理）。
B. `src/lib/ideas/model.ts`（可选增强）：复用 `lib/ai/client.ts` 的非流式调用，只发聚合统计 + ≤30 条样本标题；输出严格 JSON，解析失败丢弃不编造；再过滤 kind 枚举 / count 上限 / prompt 不得承诺删除以外的写操作；模型不可用只返回规则点子。
C. `src/lib/ideas/cleanup.ts` + `src/components/ideas/cleanup-sheet.tsx`：四类可勾选（重复 / 空文件夹 / 老旧 >12 个月 / 断链，断链只在用户点"检测链接"后跑）；"将影响 N 条"与勾选数一致，"待检测"不计入 N；只生成 `prompt`，绝不直接删除。
D. `src/components/ideas/idea-panel.tsx`：分组（现在可做 / 需要 AI / 已忽略），卡片含标题/依据/影响条数/耗时档/「开始」「忽略」；「开始」用 `document.dispatchEvent(new CustomEvent('markai:agent-prompt', { detail: prompt }))` 并关闭面板；`workspace.tsx` 里只加一个 effect 监听并 `useAIStore.getState().send(prompt)`；「刷新」round+1；空态说"库很干净"+「扫描一次」按钮。
E. `src/lib/ai/attachments.ts` + 改 `composer-extras.tsx`：选图/粘贴/拖拽，canvas 压缩到长边 ≤1600px、≤1.5MB（webp/jpeg），缩略图预览可删；`client.ts` 按 OpenAI 兼容格式组装；模型不支持视觉（HTTP 400 content 类型错）时提示"当前模型不支持图片"并保留文字重发一次；历史回放只带最近 2 张图；`estimateTokens` 图片按 800 token 计；没配 AI 时选图只提示先配置。
F. `tests/ideas.test.ts`：规则五类都能从构造树产出、evidence 非空、sampleIds 真实、排序稳定；冷却 7 天内不重复/过期可再现；模型输出过滤（非法 kind / 超量 count / 非 JSON 都丢弃不抛错）；清理勾选数与 N 一致、"待检测"不计入；附件压缩尺寸上限、data URL 前缀校验、不支持视觉的降级路径（mock fetch）。

## 完成标准（必须全部真跑，把输出贴进最终报告）

```bash
npm run compile
npx tsx tests/ideas.test.ts
npm test          # 现有全部测试（agent/bridge/features/pet-external/ideas）不许回退
npm run build
```

全部通过后 `git add` 你的文件并 commit（中文 commit message，说明改了什么、为什么），然后报告：分支名、改动文件清单、上面四条命令的真实结果、已知未完成项。
