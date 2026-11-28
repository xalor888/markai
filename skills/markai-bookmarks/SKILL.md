---
name: markai-bookmarks
description: Read and organize the user's Chrome bookmarks through the local MarkAI bridge. Use when the user asks to search, list, count, move, rename, retag, or clean up bookmarks, or to propose deletions for review. Requires the MarkAI extension running with 对外接口 enabled and a token.
---

# MarkAI Bookmarks

书签在用户的 Chrome 里，只有 MarkAI 扩展拿得到 `chrome.bookmarks`。所以这里没有
"直接读浏览器数据文件"的捷径：一切操作都经过本机桥 `tools/markai.mjs`，由扩展执行。

## 前置检查（每次会话开头做一次）

```bash
node tools/markai.mjs stats
```

- 成功：拿到 `{ total, folders, ... }`，继续。
- `缺少 token`：让用户在 MarkAI → 设置 → 对外接口 里生成 token，然后
  `export MARKAI_TOKEN=<token>`。
- `连不上桥`：让用户运行
  `node tools/markai-bridge.mjs --token <TOKEN>`，并确认扩展已打开、对外接口已启用。

不要猜测书签内容。没有 `stats` 成功就不要往下做。

## 常用操作

```bash
node tools/markai.mjs search "react 文档"        # 搜索（标题 + URL）
node tools/markai.mjs list --folder <id> --limit 100
node tools/markai.mjs folders                   # 全部文件夹 + 每根书签数
node tools/markai.mjs path <id>                 # 解析完整路径
node tools/markai.mjs stats
node tools/markai.mjs call <tool> '<json>'      # 任意工具
```

写操作需要用户在设置里打开「允许写操作」，否则会被拒绝（这是预期行为，不要重试）：

```bash
node tools/markai.mjs call create_folder '{"title":"待读"}'
node tools/markai.mjs call move_bookmark '{"id":"<id>","parentId":"<folderId>"}'
node tools/markai.mjs call rename_bookmark '{"id":"<id>","title":"新标题"}'
```

## 删除：只提议，不执行

**永远不要试图直接删除。** 没有这个工具，也不该有。正确做法是提交提议，由用户在
MarkAI 界面里确认：

```bash
node tools/markai.mjs propose-delete <id> <id> --reason "重复链接"
```

即使 MarkAI 的「无需确认」模式开着，外部调用也强制走确认——这是设计，不是故障。
提交后告诉用户"已在 MarkAI 里生成 N 条待确认删除"，不要声称"已删除"。

## 汇报规则

- 引用书签时用 `标题 — 路径`，不要只给 id。
- 统计口径要说清楚：书签栏 ≠ 全库；「其他书签」「移动设备」是独立的根。
- 任何写操作后，用 `path` 或 `list` 复核结果再汇报，不要只凭返回值断言成功。
- 失败就把原始错误贴给用户，不要改写成"可能失败了"这种模糊说法。

## 不该做的事

- 不要批量 `call` 同一工具来"试试看"——每次调用都会进审计日志，也会占用扩展。
- 不要为了绕过写权限去改 storage 或直接调 Chrome API：外部 Agent 没有这个权限，
  尝试只会浪费时间。
- 不要在用户没要求时清理书签。提议是建议，执行权在用户。
