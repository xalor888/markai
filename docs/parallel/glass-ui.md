# 工作线 C：液态玻璃 + 动效 + 主题/背景 + 检查更新

## 目标

把界面从"磨砂卡片"推进到有厚度、会回应指针的液态玻璃；补齐动效层级；让用户能自定义强调色/背景/动效强度；并接上真正的"检查更新"。

## 参考（只学做法，不复制代码/素材）

`github.com/shuding/Liquid-Glass`、`github.com/rdev/Liquid-Glass-React`、`github.com/naughtyduk/LiquidGL`、`github.com/kwlck/Liquid-Glass-Web`、`github.com/tomacco/Amazing-Glass`、`kube.io/blog/liquid-glass-css-svg`、`codepen.io/Mikhail-Bespalov/pen/MYwrMNy`。

**关键约束（已实测，不要推翻）**：`backdrop-filter: url(#svgFilter)` 在 `chrome-extension://` 页面会被 Chromium 静默丢弃（`CSS.supports` 为 true、实际不采样）。详见 `docs/liquid-glass-research.md` 第 0 节。所以折射只能用"假的但可信"的手段：多层模糊、边缘色散、镜面高光、指针跟随反光、噪点。**不要**把 SVG 折射当作主路径。

## 必须实现

### 1. 玻璃层 v2（`src/assets/main.css` + `src/lib/ui/liquid-glass-global.ts`）

- 新增 `.mk-glass-2`：三层结构
  1. 底色层：`--mk-glass` 控制透明度（外观 store 已写入）。
  2. 边缘层：`::before` 用 `conic-gradient` + `mask` 做"上亮下暗 + 左右冷/暖"的厚边，宽度 1.5–2px；小字号区域（列表、菜单）不要超过 2px，否则文字边缘发脏。
  3. 高光层：指针位置驱动的径向高光（沿用 `--liquid-mx/my`，改成 CSS 变量 `--mk-mx/my`，保留旧变量兼容）。
- 支持 `@supports not (backdrop-filter: blur(1px))` 实心回退。
- 暗色单独一套 token，边缘高光压到 30% 左右。
- **性能**：指针高光只用 CSS 变量，不跑 rAF；`will-change` 只加在正在动的元素上；浮层数量超过 3 个同时打开时不叠加 backdrop（用 `data-glass-budget` 降级）。

### 2. 动效

- 统一时长/缓动 token：`--mk-dur-1: 120ms` / `--mk-dur-2: 180ms` / `--mk-ease: cubic-bezier(.2,.8,.2,1)`。
- 入场：面板从 0.98 缩放 + 4px 上移 + 透明度；退出反向（React 侧用 `data-state=open|closed` 加 CSS，不要引入动画库）。
- 状态反馈：按钮按下 0.97 缩放；列表行 hover 左侧 2px accent 指示条滑入；抽屉用 spring 感（`cubic-bezier(.32,.72,0,1)`）。
- 尊重 `data-motion="calm|off"`（`appearance.css` 已有全局规则），新动画必须能被它关掉。
- 所有动画只动 `transform` / `opacity` / `filter`，不动布局属性。

### 3. 外观自定义（`src/components/options/appearance-settings.tsx`）

现在是只读占位，改成完整控件：

- 主题（复用 `ThemeCards`，已从 `config-form.tsx` 导出）。
- 强调色：6 个色板（`ACCENT_PRESETS`），点击即时生效。
- 背景：纯色/极光/网格/自定义图片；图片支持 URL 与本地文件（读成 data URL，先压缩到长边不超过 1920px、大小不超过 800KB）。
- 压暗滑杆（`backgroundDim`）、玻璃强度滑杆（`glass`）、动效三档（`MOTION_OPTIONS`）、密度。
- "恢复默认"按钮。
- 预览区：用真实组件片段（一个迷你侧栏 + 一个卡片 + 一个按钮），不是截图。
- 写入只走 `useAppearanceStore.update()`；不要直接写 storage。

### 4. 检查更新

`src/lib/update/*` + `src/components/update/update-check-button.tsx`：

- 数据源：GitHub Releases API（`https://api.github.com/repos/xalor888/markai/releases/latest`），无 token，`Accept: application/vnd.github+json`；结果缓存 30 分钟（storage key `markai.update.cache`）。
- 语义化版本比较（自己写 20 行，不要加依赖）：`0.2.174` vs `0.2.175`；预发布（`-beta`）视为低于同版本正式版。
- 状态机：idle → checking → up-to-date / available / error；错误要分类（网络、限流 403、解析失败），并给"重试"。
- 有新版本时：顶栏按钮带小圆点；点击打开一个小面板，显示版本号、发布日期、release notes 摘要（截断 600 字）、"打开发布页"。
- 不自动下载/安装（扩展做不到），文案不能说"已更新"。

### 5. 接入点（只改这些共享文件）

- `src/assets/main.css`：玻璃 v2 + 动效 token。
- `src/lib/ui/liquid-glass-global.ts`：指针变量改双写。
- `src/components/options/appearance-settings.tsx`：完整实现。
- `src/components/update/update-check-button.tsx`：完整实现。
- `src/components/ui/dialog.tsx`、`src/components/toast/toast.tsx`、`src/components/workspace/more-menu.tsx`、`src/components/command/command-palette.tsx`：把 `markai-glass-liquid` 换成新类（保留旧类名做别名，避免其它分支引用失效）。

## 测试（`tests/glass.test.ts`）

- 版本比较：大于/小于/相等/预发布/非法输入。
- 更新状态机：mock fetch，覆盖 200 新版本、200 同版本、403 限流、网络错误、缓存命中。
- 外观：`normalizeAppearance` 与 `applyAppearance` 写出的 data 属性正确（用最小 DOM stub）。
- CSS 守卫：`main.css` 里不出现 `backdrop-filter: url(`（已知在扩展页失效）；新动画都在 `data-motion` 可控范围内。

## 不做

- 不引入动画库/玻璃库依赖。
- 不改宠物、点子、搜索的数据逻辑。
