# v0.2.131 — 侧边栏窄宽度下的对话框与菜单（+13 项守卫）

## 这一轮没有产品缺陷

前两轮在侧边栏窄宽度下连挖出两个真缺陷（320px 横向滚动、Agent 抽屉左边被切）。
这一轮把**剩下的窄宽度状态**全部测完，**没有发现新缺陷**——如实记录。

新增 13 项守卫，全部通过：

```
对话框宽度钳制（360 / 300 / 260px）
  360 → w:328  left:16  right:344   scrollOver:0
  300 → w:268  left:16  right:284   scrollOver:0
  260 → w:228  left:16  right:244   scrollOver:0

整理记录对话框内容（最密的一个，声明 w-[520px]）
  300px → escapedCount:0
  260px → escapedCount:0  canScroll:true（高度受限，内部可滚）

「更多」菜单（待删清单/整理记录/健康检查的唯一入口）
  360 / 300 / 260px → itemCount:22  escapedCount:0  scrollOver:0
```

`max-w-[calc(100vw-32px)]` 确实压过了各自的固定宽度；`overflow-y-auto` 也确实兜住了高度。
**这两个机制是对的，此前只是没人验过。**

## 过程中修的两处测试自身问题

1. **固定 sleep 撞时序**：450ms 抓到 `itemCount: 0`，而 360px 和 260px 都正常——
   看着像布局问题，其实是渲染没完。改成 `waitFor` 等菜单项出现。
2. **关不掉菜单**：`document.body.click()` 关不掉它（`more-menu.tsx` 听的是
   document 上的 `mousedown`）。关不掉时，下一轮点击变成**切换关闭**——
   于是只有中间档位（300px）偶发 0 项。改成派发 `mousedown`。

两处都会制造**假红**。第二处尤其阴：只在中间档位出现，很容易被误判成布局缺陷。

## 数据

单测 **850** · e2e **183/183（+13）· 106s** · tsc ✅ · build ✅
