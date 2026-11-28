# 工作线 A：向量检索（提升搜索效率）

## 目标

书签库上千条时，关键词搜索只认字面：搜「前端框架」找不到标题是「React」的书签。要做到：

1. **混合检索**：语义相似度 + 关键词精确匹配，两路结果融合排序。精确匹配（标题完全相等/前缀）永远排在语义命中之前，避免"搜 URL 却给出相似但不对的条目"。
2. **本地优先、可离线**：默认不把书签内容发到第三方。索引与查询默认在本机完成；用户显式开启"用模型生成向量"时才调用其已配置的 OpenAI 兼容 `/embeddings` 端点。
3. **增量索引**：监听 `chrome.bookmarks` 增删改，只重算变化的条目；首次建索引要有进度、可取消、不阻塞 UI（分片 + 让出主线程）。
4. **可解释**：每条结果显示命中原因（标题包含 / 语义相近），用户能判断为什么它被排在这里。

## 必须实现

### 1. 本地向量（默认路径，无网络）

`src/lib/search/semantic/local-embed.ts`：

- 确定性特征哈希向量：中英混排分词（英文按词、中文按 2-gram + 单字）、小写归一、去停用词、URL 域名/路径词单独加权。
- 维度固定（如 384），L2 归一化，余弦相似度。
- 纯函数、无依赖、可单测；同样输入永远同样输出（不能有随机种子/时间参与）。
- 质量下限要有测试：同义改写（"代码托管" vs "GitHub"）不要求命中，但**字面相关**的必须排在无关项前；至少 20 条真实书签样本的排序断言。

### 2. 索引层

`src/lib/search/semantic/index.ts`：

- 索引结构：`{ id, url, title, path, parentId, dateAdded, vector, tokens }`。
- 存储：`chrome.storage.local` 分片（每片 ≤ 200 条，避免单 key 过大）+ 一个 manifest（版本、片数、模型标识、更新时间）。
- 版本不匹配（换模型/换维度/分词规则变更）时整库重建，不要混用两种向量。
- 增量：`onCreated` / `onRemoved` / `onChanged` / `onMoved` 只更新受影响条目；移动要更新 path。
- 容量护栏：超过预算（如 8 MiB）时按"最近使用 + 最近收藏"保留，其余降级为仅关键词，并在状态里如实说明降级了多少条。

### 3. 检索与融合

`src/lib/search/semantic/search.ts`：

- 输出 `SemanticHit[]`（形状见 `src/lib/features/semantic.ts`，可加可选字段）。
- 融合公式要可解释、可测：`final = keywordScore * w1 + semanticScore * w2`，精确匹配硬置顶；`w` 写成导出常量。
- 查询扩展：把用户输入拆成 token 后做一次轻量同义扩展（同义词表写在文件里，几十条即可：代码/编程、设计/UI、文档/教程…），扩展词只加分不替代原查询。
- 文件夹限定、`limit` 上限与现有 `keywordHits` 一致。

### 4. 模型向量（可选增强）

`src/lib/search/semantic/remote-embed.ts`：

- 仅在设置里开启且已配置 API Key 时启用；调用 `${baseUrl}/embeddings`（OpenAI 兼容），批量 ≤ 64 条/次，失败退避，401/403 立即停用并提示。
- 远端向量与本地向量不能混用：切换实现时整库重建。
- 任何情况下不阻塞搜索：远端不可用就本地。

### 5. 接入

- `src/lib/search/semantic/register.ts`：`installSemanticSearch()` 里构建索引（异步，不 await 阻塞入口）并 `registerSemanticSearcher(...)`。
- `src/components/command/command-palette.tsx`：⌘K 里书签结果走 `searchBookmarks`（异步），命中原因显示在副标题；索引未就绪时退回现有同步关键词，不闪空。
- `src/components/workspace/workspace.tsx` 顶栏搜索：保持现有即时过滤，但输入停顿 250ms 后叠加语义结果（去重），语义条目带一个小标记。**不要**把列表整体换成异步，否则 1000 条时每次按键都会抖。
- Agent 工具 `search_bookmarks`：加可选参数 `semantic?: boolean`，为 true 时用同一套检索（`lib/ai/tools.ts` 里只改这一个工具的参数与执行分支）。

### 6. 设置

- 新建 `src/components/options/search-settings.tsx`，分区 id 用 `search`。
- 内容：索引状态（条数/占用/最后更新）、重建按钮、是否允许远端向量、降级说明。
- 在 `src/components/options/settings-layout.tsx` 的 `SETTINGS_SECTIONS` 里加一行 `search`（这是唯一允许改的共享文件，只加一行），并在 `config-form.tsx` 挂载分区。

## 测试（`tests/semantic.test.ts`）

- 分词与向量：确定性、归一化、中英混排、空输入。
- 索引：增量更新、移动后 path 正确、版本变更触发重建、容量护栏降级计数正确。
- 融合：精确匹配置顶、语义高分不压过精确匹配、同分稳定排序（不能依赖 `Math.random`）。
- 降级：远端 401 停用、超时退回本地、索引未就绪时关键词仍可用。

## 不做

- 不引入需要下载大模型权重（>20MB）或 WASM 运行时的新依赖；如果要加依赖，先在报告里说明体积与理由，由 root 决定。
- 不改书签数据本身。
