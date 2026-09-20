# Chrome Web Store 上架材料与审核清单（MarkAI）

本文档为 MarkAI 在 Chrome Web Store（开发者后台）提交审核时的官方文案与申诉声明模板。文档由 `tests/agent.test.ts` 进行机器校验守卫，确保权限与披露内容随时与代码保持一致。

---

## 一、基本信息（Store Metadata）

### 1. 扩展名称（Extension Name）
`MarkAI —— 智能书签管家（自由对话的 AI Agent）`

### 2. 短描述（Summary / Short Description）
> **注意**：Chrome Web Store 要求短描述必须在 132 个字符以内。

`你的智能书签管家：自由对话的 AI Agent，帮你整理分类、清理死链重复、安全撤销每一步操作。`

### 3. 单一用途说明（Single Purpose Description）
> **审核政策要求**：扩展必须具有清晰明确的单一用途。

`帮助用户通过自然语言对话与可视化面板整理、检索、清理和维护浏览器收藏夹书签。`

### 4. 分类（Category）
`Productivity`（生产力工具）

---

## 二、详细描述（Detailed Description）

MarkAI 是一款基于 Chrome Extension Manifest V3 构建的现代化智能书签管家。它将强大的 AI Agent 深度融入浏览器收藏夹管理中，让你只需自然对话，即可高效打理杂乱的书签库。

### 🌟 核心功能特性

1. **自由自然对话（AI Agent）**
   - 支持多轮对话，懂你的整理意图：「把所有关于 React 的文章归到一个文件夹」「把没分类的书签按主题整理好」。
   - 支持计划确认模式（执行前先看计划）：Agent 在动手前先给出整轮操作清单与规模，经你批准后才执行。

2. **可信撤销保证（Undo Everything）**
   - Agent 的每一步写操作（移动、新建、修改、合并、删除）均完整记录还原点。
   - 删除操作会自动保存子树快照，手滑删错一键完整重建。
   - 具有明确的安全边界：不静默吞错、不越权执行。

3. **批量清理与死链排查**
   - 快速发现重复 URL 与相似书签。
   - 支持批量向书签发送网络探测，排查失效死链与 404 页面。
   - 严格的删除闸门：删除提议清单可视化，绝不未经确认静默删除。

4. **隐私优先与开源透明**
   - 纯客户端运行：无自建中心化后端，不收集、不出售任何用户数据。
   - 支持自定义端点：可连接 OpenAI、DeepSeek、Moonshot，或本地运行的 Ollama（`localhost:11434`）。
   - 代码完全开源透明，无任何第三方广告或统计追踪代码。

---

## 三、权限声明与审核理由（Permission Justifications）

以下文案供 Chrome Web Store 开发者后台「权限申诉（Permission Justification）」逐项填报：

| 权限名称 | 审核理由声明（申诉文案） |
| :--- | :--- |
| `bookmarks` | 用于核心书签管理功能：读取收藏夹结构以展示书签树与列表，执行用户或 AI 指令进行书签的创建、重命名、分类移动、合并及删除。 |
| `storage` | 用于在本地 `chrome.storage.local` 保存用户配置（如模型服务商 Base URL、加密存储的 API Key）、多会话聊天历史、待删清单及操作可撤销日志。 |
| `tabs` | 用于在用户操作时打开书签链接，以及在点击扩展图标或快捷键时读取当前窗口状态以唤起侧边栏。 |
| `tabGroups` | 用于支持「在新标签页组中打开全部」功能，帮助用户将某个文件夹中的所有书签整洁地归纳到一个 Chrome 标签组中。 |
| `contextMenus` | 用于在扩展图标右键菜单中提供快捷入口（打开管理面板 / 在完整页打开 / 一键整理全部书签），让用户从原生上下文直接启动 AI 整理。说明：Chrome 不支持扩展向书签管理器（chrome://bookmarks）注入右键菜单，本扩展未采用任何绕过手段；书签维度的整理与分析入口位于扩展自身的书签树右键菜单中。 |
| `sidePanel` | 用于支持 Chrome 原生侧边栏形态（Side Panel），让用户在浏览任意网页时无需遮挡页面即可便捷呼出管理面板与 AI 对话。 |
| `<all_urls>` (host_permissions) | 仅用于两项特定用途：① 向用户在设置中自定义填写的任意 AI 服务商 Base URL（包括云端 API 或本地部署的 Ollama）发送对话请求；② 执行死链检测时向书签指向的目标站点发起无凭据的 HTTP HEAD 探测请求。扩展不包含任何 Content Script，绝不注入、读取或修改任何网页的 DOM 内容。 |

---

## 四、隐私合规声明（Privacy Practices）

1. **用户数据处理**：
   - 扩展仅处理书签元数据（标题、URL、层级关系）与用户与 Agent 的对话记录。
   - 所有数据均保存在用户的浏览器本地存储中，用户可在设置页一键清空全部本地数据。
2. **数据传输**：
   - 仅在用户主动发起 AI 对话时，才将执行任务所需的上下文（如书签列表、用户指令）通过 HTTPS 发送至用户自行配置并信任的 AI API 端点。
3. **绝无第三方跟踪**：
   - 绝不包含任何第三方 Google Analytics、Umami、Sentry 等外部埋点脚本。

---

## 五、视觉资产规格与生成（Visual Assets）

Chrome Web Store 要求的两份推广视觉素材可由项目内置的纯 Node 脚本 `scripts/generate-promo-tiles.mjs` 程序化生成（零外部依赖，严格符合官方尺寸）：

1. **小型推广横幅（Small Promo Tile）**：
   - 路径：`public/store/promo-small-440x280.png`
   - 官方规格：严格 440 × 280 像素，8-bit RGBA PNG
   - 用途：Chrome 应用商店搜索列表和分类卡片展示

2. **主横幅（Marquee Promo Tile）**：
   - 路径：`public/store/promo-marquee-1400x560.png`
   - 官方规格：严格 1400 × 560 像素，8-bit RGBA PNG
   - 用途：Chrome 应用商店首页轮播与置顶推荐展示

由 `tests/agent.test.ts` 进行尺寸与 PNG 魔数机器校验，确保视觉素材就绪且尺寸不漂移。
