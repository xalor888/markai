# v0.2.92 — 拖拽，第一次真的拖了

## 缺口

「拖拽移动书签」这条用例，**根本没有拖**。

它调的是：

```js
await chrome.bookmarks.move(src.id, { parentId: target.id });
```

代码注释写着：

> 真实拖放要构造 DataTransfer，headless 下不稳；这里验证扩展能收到书签变更并重绘

也就是说：它验证的是「扩展能收到书签变更」，**拖拽本身一次都没测过**。

如果 `dragstart` / `dragover` / `drop` 任何一个 handler 接错，这条用例照样绿。

## 真的拖了

注释里的判断是错的。页面里 `new DataTransfer()` + `dispatchEvent(new DragEvent(...))` **完全可行**——
处理器读写的就是 `e.dataTransfer`，合成事件照样能过。

```
PASS  真拖：把书签拖进树里的文件夹，它真的换了父目录
       {"ok":true,"inTarget":true,"parentNow":"12","targetId":"12","srcId":"13"}
```

完整序列：`dragstart`（源行）→ `dragenter` → `dragover` → `drop`（树的文件夹行），
然后断言书签的 `parentId` **真的变成了目标文件夹**。

## 验证

**证伪**：让树的 `handleDrop` 直接返回 → 立刻转红。

## 顺带修了用例的自给自足

第一版依赖前面段落留下的「Alpha 文档」——那段跑到后面列表里早就没它了（`no-src-row`）。
改成自己建源书签，用完连靶文件夹一起清掉。

## 数据

单测 **822** · e2e **122 项 · 74s** · tsc ✅ · build ✅
