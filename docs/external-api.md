# 对外接口：让外部 Agent 操作书签

MarkAI 的对外接口让 Claude Code、Codex、Cursor 等外部 Agent 在**你授权后**
读取与整理书签。三种接入方式（MCP / CLI / Skills）走同一条队列、同一个 token、
同一份审计日志——不存在第二条绕过安全模型的路径。

## 安全模型（先读这一节）

| 边界 | 做法 |
| --- | --- |
| 监听地址 | 只监听 `127.0.0.1`，不监听 `0.0.0.0`，局域网/公网无法访问 |
| 鉴权 | 每个请求都要 `Authorization: Bearer <token>`；token 只存在本机 storage |
| 工具白名单 | 桥与扩展各校验一次，白名单外的工具直接拒绝 |
| 写操作 | 默认关闭；要在设置里显式打开「允许写操作」 |
| **删除** | **永远只提议，不执行**。即使你给聊天 Agent 开了「无需确认」，外部调用也强制走确认 |
| 审计 | 每次调用记「谁、何时、什么工具、结果摘要」，上限 200 条，可清空 |

为什么删除要单列：`deleteMode: 'auto'` 是你对**聊天里的 Agent** 的授权，
不等于授权本机上任何一个拿到 token 的进程。这条差异由 `ToolContext.external`
在工具层强制，并有测试守着（`tests/cli-skill.test.mjs` C4）。

## 前置：启动桥

MV3 扩展不能监听 TCP 端口，所以端口由本机桥持有，扩展用长轮询领活：

```
MCP / CLI ──▶ tools/markai-bridge.mjs（持有 127.0.0.1:8787）──队列──▶ 扩展 ──▶ chrome.bookmarks
```

1. MarkAI → 设置 → 对外接口 → 打开开关；
2. 点「生成 token」，复制；
3. 在项目目录运行：

```bash
node tools/markai-bridge.mjs --token <TOKEN> --port 8787
```

桥和扩展必须**同时运行**。桥挂了，调用会超时并提示检查扩展状态。

## 方式一：MCP

打印可直接粘贴的配置：

```bash
node tools/markai-bridge.mjs --print-mcp-config --token <TOKEN>
```

输出形如：

```json
{
  "mcpServers": {
    "markai": {
      "command": "/path/to/node",
      "args": ["/path/to/tools/markai-bridge.mjs", "--token", "<TOKEN>", "--port", "8787"]
    }
  }
}
```

桥在 stdio 上实现 `initialize` / `tools/list` / `tools/call` / `ping`，
未知方法返回 `-32601`。它不实现 `resources` / `prompts`——职责就是操作书签。

## 方式二：CLI

```bash
export MARKAI_TOKEN=<TOKEN>

node tools/markai.mjs stats
node tools/markai.mjs search "react 文档"
node tools/markai.mjs folders
node tools/markai.mjs list --folder <id> --limit 100
node tools/markai.mjs path <id>
node tools/markai.mjs propose-delete <id> <id> --reason "重复链接"
```

退出码：`0` 成功；`1` 调用失败（含桥不可达）；`2` 用法或 token 错误。
`--json` 输出原始 JSON，便于脚本解析。

## 方式三：Skills

Skill 是给外部 Agent 读的操作手册，让它知道「先检查前置、删除只提议、写操作要先被授权」。

```bash
node tools/install-skill.mjs              # 自动探测 ~/.codex/skills 等目录
node tools/install-skill.mjs --to <dir>   # 装到指定目录
node tools/install-skill.mjs --print      # 只打印目标路径
```

源文件在 `skills/markai-bookmarks/SKILL.md`。安装后外部 Agent 通过
`tools/markai.mjs` 操作书签，仍受同一套 token / 白名单 / 删除闸门约束。

## 工具清单

只读（`allowWrites=false` 时也可用）：

| 工具 | 作用 |
| --- | --- |
| `list_bookmarks` | 列出书签/文件夹（可指定 `folderId`、`limit`） |
| `search_bookmarks` | 按标题/URL 搜索 |
| `get_folder_path` | 解析完整路径 |
| `list_all_folders` | 列出所有文件夹与每根书签数 |
| `stats` | 书签库统计 |

写操作（需在设置里打开「允许写操作」）：

| 工具 | 作用 |
| --- | --- |
| `create_folder` | 新建文件夹 |
| `create_bookmark` | 新建书签 |
| `move_bookmark` | 移动书签或文件夹 |
| `rename_bookmark` | 重命名 |
| `update_url` | 修改书签 URL |
| `propose_deletions` | 提交删除提议（**只进待确认队列**） |

## HTTP 接口（脚本/curl）

```bash
curl -s http://127.0.0.1:8787/health                  # 不需要 token
curl -s -H "Authorization: Bearer $MARKAI_TOKEN" \
     http://127.0.0.1:8787/v1/tools
curl -s -X POST -H "Authorization: Bearer $MARKAI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"tool":"search_bookmarks","args":{"query":"react"}}' \
     http://127.0.0.1:8787/v1/call
```

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `401 token 不正确` | token 与设置页不一致（轮换过） | 重新复制 token，重启桥 |
| `连不上桥` | 桥没启动 / 端口不对 | 启动桥，确认 `--port` 与设置页一致 |
| 调用超时 | 扩展没开、对外接口没启用 | 打开 MarkAI，确认开关为「已启用」 |
| 写操作被拒绝 | 没开「允许写操作」 | 设置页打开；这是预期行为 |
| 删除没发生 | 正常：外部调用只提议 | 到 MarkAI 界面确认待删卡片 |
