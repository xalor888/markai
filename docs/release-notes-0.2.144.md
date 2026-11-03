# v0.2.144 — 取消时不说「已经做了多少」

## 缺陷

取消后错误信息只报「已取消」——用户看到界面刷新，但**不知道刚才动没动、动了多少**。

实测：批量移动 3000 条移到一半时取消，界面上树节点已经变了（2/3000 或更多），但错误提示只有「已取消」。用户以为一条都没动 → **要么乱点撤销导致数据错乱，要么不敢撤销错过机会**。

## 修法

`makeAbortCheck()` 改为接受一个可选的 `progress` 字符串：

```ts
throwIfAborted(progress ? `已取消（${progress}）` : '已取消');
```

并在每个工具的循环里传进度：

| 工具 | 进度描述 |
|---|---|
| `move_bookmarks` | `已移动 ${doneCount}/${ordered.length} 项` |
| `sort_folder` | `已重排 ${i}/${sorted.length} 项` |
| `create_bookmarks` | `已创建 ${createdCount}/${items.length} 条` |
| `merge_folders` | `已移动 ${moved}/${children.length} 项` |
| `delete_all_bookmarks` | `已删除 ${ok}/${targets.length} 项` |
| `propose_deletions` | `已处理 ${proposedDone}/${items.length} 条` |

## 验证

```
PASS 取消时报出已经做了多少（不能只说「已取消」）
  [DBG] 取消错误：Error: 已取消（已移动 4/10 项）
```

**证伪**：去掉进度参数 → 转红：

```
❌ 取消时必须报出已经移了多少... 实际：Error: 已取消
```

## 数据

单测 **857**（+1）· e2e **199/199 · 117s** · tsc ✅ · build ✅
