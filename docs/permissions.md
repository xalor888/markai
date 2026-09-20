# 权限说明（MarkAI）

MarkAI 只申请它真正用到的权限。这份文档逐条说明**用途**与**去掉以后会怎样**，
并且下面那行机器可读的清单由测试与 `wxt.config.ts` **强制核对**——改一边不改另一边，
`npx tsx tests/agent.test.ts` 会失败。

manifest-permissions: bookmarks, storage, tabs, tabGroups, contextMenus, sidePanel

## 权限

| 权限 | 用途（代码位置） | 去掉会怎样 |
| --- | --- | --- |
| `bookmarks` | 全部书签读写：树/列表展示、增删改移、查重、排序、清理（`src/lib/ai/tools.ts`、`src/stores/bookmarkStore.ts`） | 扩展没有存在意义 |
| `storage` | 保存配置（含 API Key）、聊天记录、撤销记录、主题（`markai.*` 键，见 [privacy.md](./privacy.md)） | 配置与对话无法保存 |
| `tabs` | 打开书签（`chrome.tabs.create`）、读取当前窗口以打开侧边栏（`chrome.tabs.query`） | 「打开书签」「打开全部」「打开侧边栏」失效 |
| `tabGroups` | 右键文件夹 →「在新标签页组中打开全部」（`src/components/sidebar/bookmark-tree.tsx`） | 只影响这一个菜单项 |
| `contextMenus` | 扩展图标（action）右键集成：打开管理面板 / 在完整页打开 / 让 MarkAI 整理全部书签（`src/lib/ai/context-menus.ts`、注册失败会告警）。**注**：原生书签管理器（`chrome://bookmarks`）的右键菜单在 Chrome 上无法实现——`contextMenus` 没有 `bookmark` 上下文（Firefox `menus` API 才有），`chrome://` 页面也不接受扩展注入；书签维度的「整理 / 分析」在扩展内的书签树右键里 | 扩展图标右键入口消失，聊天与书签树右键仍可用 |
| `sidePanel` | 侧边栏形态（`side_panel.default_path`，`chrome.sidePanel.open`） | 只剩完整页形态 |

**没有申请**：`history`、`downloads`、`management`、`cookies`、`webRequest`、`scripting`、
`unlimitedStorage`，也没有任何 content script——扩展不注入、不读取网页内容。

## host_permissions：`<all_urls>`

manifest 里还有一项**最宽**的权限：

```ts
host_permissions: ['<all_urls>']   // wxt.config.ts
```

它支撑两件事，缺一不可：

1. **任意 OpenAI 兼容端点**：Base URL 由用户填写（OpenAI / DeepSeek / Moonshot /
   本地 Ollama `http://localhost:11434/v1` / 自建代理），扩展无法预先知道域名；
2. **死链检测**：需要直接向书签指向的任意站点发 HEAD 请求（见 privacy.md §2.2）。

### 它意味着什么

拿到 `host_permissions` 意味着扩展**有技术能力**在后台读写这些站点（绕过 CORS）。
本扩展只把它用于上面两件事：`src/lib/ai/client.ts` 只请求你配置的 Base URL，
`checkOneUrl()` 只对书签 URL 发 HEAD/GET 且**不带凭据**。
但"我们只用它做这个"是**行为承诺**，不是权限系统的强制——请据此判断是否安装。

### 想更小的话

- **只用固定服务商**：可以把 `<all_urls>` 换成该服务商域名（例如
  `https://api.deepseek.com/*`）+ `http://localhost:11434/*`，代价是不能再填任意 Base URL；
  死链检测会失效（跨站请求被拦）。这需要改造 `wxt.config.ts` 并重新构建；
- **更彻底的方案**（尚未实现）：改成 `optional_host_permissions` + 运行时按需申请，
  让用户自己决定授权哪些域名。这是本项权限的**正确长期形态**，目前仍是 TODO。
- 如果只想断开"扩展联系我的书签站点"：不使用检测类工具即可（README 未把它们作为必需功能）。
