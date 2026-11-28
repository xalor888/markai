# 工作线 B：点子管家 + 老旧书签识别 + 简单清理 + 聊天发图

## 目标

把「点子」从一条静态建议升级成 **personal agent**：它会观察书签库、按你的习惯提出具体可做的事，点一下就能让 Agent 接着做（仍然走暂存/确认/撤销）。同时补上"老旧书签"识别与更简单的清理入口，以及聊天里发送图片。

## 必须实现

### 1. 点子引擎（规则层，必须先有）

`src/lib/ideas/rules.ts`（纯函数，无 IO）：

- 输入 `IdeaInput`（见 `src/lib/features/ideas.ts`），输出 `Idea[]`。
- 至少覆盖：
  - `stale`：超过 N 个月未使用/未更新的书签（Chrome 的 `dateLastUsed` 可能缺失，缺失时用 `dateAdded` 并在 evidence 里说明"按收藏时间估算"——不许把估算说成实测）。
  - `duplicate`：复用 `lib/bookmarks/insights.ts` 的规范化与保留规则。
  - `empty-folder`：空文件夹。
  - `cluster`：单域名在多个文件夹里散落（至少 3 个文件夹）。
  - `unfiled`：根层直接散落的书签（**不要说"游离"**，见 RALPH.md）。
- 每条 `Idea` 必须有 `evidence`（至少 1 条，带 sampleIds 最多 5 个）与 `prompt`（用户可改的指令）。
- 排序：`quick` 在前，其次按 `count` 降序；同分按 id 稳定排序。
- 冷却：同一 `id` 在 7 天内不重复出现（存 storage，key `markai.ideas.seen`，带上限与清理）。

### 2. 模型增强（可选）

`src/lib/ideas/model.ts`：

- 用现有 `lib/ai/client.ts` 的非流式调用（若无，走 `runAgentTurn` 之外的简单 completion；不要新写一套 HTTP）。
- 输入只给**聚合统计 + 最多 30 条样本标题**，不发完整 URL 列表；输出必须是严格 JSON，解析失败就丢弃这一轮，不编造。
- 生成结果必须再过滤：`kind` 必须在枚举内、`count` 不能超过真实书签数、`prompt` 不能包含删除以外的写操作承诺。
- 模型不可用时只返回规则点子，不报错弹窗。

### 3. 点子面板

`src/components/ideas/`：

- `idea-panel.tsx`：抽屉/弹层，分组（现在可做 / 需要 AI / 已忽略），每条卡片：标题、依据、影响条数、耗时档、"开始"、"忽略"。
- "开始"= 把 `prompt` 发进 Agent 并关闭面板（`document.dispatchEvent(new CustomEvent('markai:agent-prompt', { detail: prompt }))`，在 `workspace.tsx` 里监听并调用 `useAIStore.getState().send(prompt)`；这是唯一允许改 workspace 的地方，只加一个 effect）。
- "忽略"写入冷却表；"刷新"重新生成（round+1）。
- 空态：没有点子时说"库很干净"+ 一个"扫描一次"的按钮，不要空白。
- 顶栏 `src/components/ideas/idea-button.tsx` 改成真正打开面板（保留 `data-testid="idea-entry"`）。

### 4. 简单清理

`src/components/ideas/cleanup-sheet.tsx` + `src/lib/ideas/cleanup.ts`：

- 一个面板，四类可勾选：重复、空文件夹、老旧（超过 12 个月）、断链（只在用户点了"检测链接"后才跑，复用现有 `check_urls_bulk` 逻辑或 `lib/health`）。
- 勾选后只有一个主按钮「生成清理方案」，**不直接删除**：生成一个 `prompt` 交给 Agent 走既有暂存/确认链路。
- 显示"将影响 N 条"，与实际勾选数一致；不确定的项标"待检测"，不计入 N。

### 5. 聊天发图

`src/components/chat/composer-extras.tsx` 换成真实实现 + `src/lib/ai/attachments.ts`：

- 选图（`<input type="file" accept="image/*">` 或粘贴/拖拽），客户端压缩到长边不超过 1600px、大小不超过 1.5MB（canvas，webp/jpeg），生成缩略图预览，可删除。
- 消息模型：`ChatMessage` 加可选 `images?: { dataUrl: string; name: string; w: number; h: number }[]`（只加可选字段）。
- 请求侧：`ApiMessage.content` 支持 `string | Array<{type:'text'|'image_url', ...}>`；在 `lib/ai/client.ts` 里按 OpenAI 兼容格式组装；**模型不支持视觉时**（HTTP 400 且报 content 类型错）给出明确提示"当前模型不支持图片"，并保留文字部分重发一次。
- 历史回放：只回传最近 2 张图，避免上下文爆炸；`estimateTokens` 里给图片按固定 800 token 计。
- 没有配置 AI 时选图不报错，只提示先配置。

## 测试（`tests/ideas.test.ts`）

- 规则：每类点子都能从构造的树上产出；evidence 非空；sampleIds 都真实存在；排序稳定。
- 冷却：同 id 7 天内不重复；过期后可再次出现。
- 模型输出过滤：非法 kind / 超量 count / 非 JSON 都被丢弃，不抛错。
- 清理：勾选数与"将影响 N 条"一致；"待检测"不计入。
- 附件：压缩尺寸上限、data URL 前缀校验、不支持视觉时的降级路径（mock fetch）。

## 不做

- 不做视频/文件附件。
- 不自动执行删除；所有删除仍走 `propose_deletions` 或暂存链路。
- 不改 `tests/agent.test.ts`。
