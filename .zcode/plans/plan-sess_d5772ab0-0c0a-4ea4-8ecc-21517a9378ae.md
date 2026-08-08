## MarkAI — 智能书签 Agent（对话优先，v2 架构）

用户核心诉求变更：**AI 不是自动分类工具，而是可自由对话、拥有书签最高管理权的 Agent**。自动分类降级为快捷指令，聊天是主交互。

### 技术栈（不变，已验证）
WXT 0.21.3 + React 19 (TS 严格) + Tailwind v4（@tailwindcss/vite）+ shadcn/ui（手动安装）+ Zustand + zod；所有 AI 请求在 background Service Worker 内 fetch，`host_permissions: <all_urls>` 兼容 OpenAI/DeepSeek/Moonshot/Ollama 及任意代理。

### Agent 核心架构
- **聊天入口**：sidepanel / page 通过 `chrome.runtime.connect` 长连接 Port 与 background 通信；background 运行 **工具调用循环**（max 10 轮）：流式输出 → 解析 `tool_calls` → 执行工具 → 回填结果 → 继续，直至最终回答；SSE 流式输出（provider 不支持流时自动降级非流式重试）
- **Agent 工具箱（background 内执行）**：
  - 直接执行：`list_bookmarks` / `search_bookmarks` / `get_recent_bookmarks` / `get_folder_path` / `create_folder` / `create_bookmark` / `move_bookmark` / `rename_bookmark` / `update_bookmark_url` / `check_urls`（HEAD 请求实测死链）/ `stats`
  - **仅提议不可执行**：`propose_deletions(ids, reasons)` → 生成聊天内交互卡片（逐条勾选 + 执行/放弃）+ 全局头部「待删 N 项」汇总入口，用户确认后 background 才调 `removeTree`。**Agent 无任何直接删除工具，删除永远需人确认**
- **自动分类 = 快捷指令**：UI 顶部快捷 chip（「整理此文件夹」「智能扫描清理」「列出未整理书签」）→ 向 Agent 发送预设指令，Agent 自主调用工具完成
- **系统 Prompt**（中文）：明确角色为书签管家、删除必须走 propose_deletions、回复简洁、歧义时先问；上下文截断（最近 20 条 + 摘要）
- **contextMenus**：浏览器原生右键书签 → 「让 MarkAI 整理 / 分析此书签」→ 打开侧边栏并注入种子指令
- **聊天历史**：aiStore 持久化到 chrome.storage.local（上限 60 条）

### 入口（5 个）
- `background.ts`：Port 流式代理、工具执行、contextMenus、删除执行
- `sidepanel/`：紧凑三栏（树 + 列表 + Agent 聊天面板）
- `page/`：完整三栏 IDE（同 Workspace 组件，mode="full"）
- `popup/`：快速查看（待删数、最近 Agent 动态、入口按钮）
- `options/`：Provider 预设 / API Key / Base URL / 模型下拉 + 连接测试

### 视觉规范（不变）
浅 `#f8fafc` / 深 `#0f0911`；Slate 文本 + Indigo `#4f46e5` 点缀；**零紫零品红**；容器圆角 8px / 控件 4px；禁阴影禁 blur，1px 边框分层；4px 网格；系统字体 12–14px，字重 400/500；hover 仅改背景透明度。

### 实施步骤
1. `npx wxt@latest init . --template react --pm npm`（Node v25.2.1 ✅）
2. 装依赖：tailwindcss @tailwindcss/vite zustand zod clsx tailwind-merge lucide-react
3. 配置：wxt.config.ts（permissions: bookmarks/storage/tabs/contextMenus/sidePanel + host_permissions）、components.json、Tailwind v4 @theme token、tsconfig 别名
4. lib 层：AI client（SSE 解析/工具调用累加/超时/降级）、工具执行器、prompts、providers、chrome 封装、zod schema
5. stores：bookmarkStore（树+选择+事件监听刷新）/ aiStore（聊天消息+流式状态+待删清单）/ configStore（persist chrome.storage.local）
6. background.ts：Port 聊天代理 + 工具循环 + contextMenus + 删除执行
7. 共享组件：书签树、书签列表（favicon/多选/右键）、Agent 聊天面板（流式渲染、工具状态 chip、删除卡片）、全局删除汇总 Dialog、Toast、主题
8. 5 个入口页面
9. 视觉精修
10. `npm run build` + `tsc --noEmit` 验证（本环境无 Chrome，最终以 `npm run dev` 加载验证）
11. README

### 交付物
完整工程（约 45 个源文件，全中文注释），`npm run dev` 即可在 Chrome/Edge 运行。