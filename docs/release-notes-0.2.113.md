# v0.2.113 — 把「绝不碰你的书签」从注释变成契约

## 承诺

`src/lib/health/types.ts` 的安全边界，原文：

> **自动修复只允许改动 MarkAI 自己的元数据**（配置 / 撤销点 / 整理记录 / 运行时标记），
> **永远不会移动、删除、重命名用户的任何书签或文件夹**。
> 书签层面的异常一律只报告——用户已经被"自动批量搬书签"坑过一次，不能再来第二次。

## 之前的状态

这句话目前是**真的**——`fixes.ts` 里一个 `chrome.bookmarks` 都没引用。

但它**只写在注释里**。`chrome` 是全局对象，谁加一行
`chrome.bookmarks.removeTree(...)` 进去，编译通过、测试全绿、没有任何东西报警。

而这条承诺崩掉的代价是用户的收藏夹。

## 做了什么

一条源码契约，把两件事钉住：

**1. 修复代码里不能出现书签入口**

```ts
/chrome\s*\.\s*bookmarks/
/bookmarks\s*\.\s*(create|move|remove|removeTree|update|reorder)/
```

（先剥掉注释再查——注释里提到 bookmarks 是在解释**为什么**不碰，不该算违规。）

**2. 写入必须走单一收口**

`fixes.ts` 里 `storage.local.set` 只能有**一处**（`writeDict`），
且 `writeDict` 只接受这三个键：`CONFIG_KEY` / `UNDO_KEY` / `LOG_KEY`。

收口结构本身就是好事：新增修复动作时只有一个地方需要审计。

## 验证

**证伪**：往 `fixes.ts` 加一个 `chrome.bookmarks.removeTree('999')` 的「修复」 →

```
自动修复里出现了书签写入口（/chrome\s*\.\s*bookmarks/）："chrome.bookmarks"。
安全承诺要求只改 MarkAI 自己的元数据。
```

## 数据

单测 **836**（+1）· e2e **149 项 · 86s** · tsc ✅ · build ✅
