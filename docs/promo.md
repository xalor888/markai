# 宣传片制作（promo-line/）

`promo-line/markai-promo-15s.mp4` 是本仓库的官方宣传片（15 秒 · 1920×1080 · 30fps · H.264 + AAC）。
本目录是它的**可复现源** —— 改 `comp.html` 里的节拍就能改片子，不需要重新"剪"。

## 概念：一条线

片子不做「界面演示」（旧版 `promo-15s/` 那种每个节拍换一张界面截图的做法，已弃用），
而是让**一条 Indigo 线**贯穿全部 15 秒，它在每个节拍换一种形态：

| 时间 | 节拍 | 线的形态 | 画面发生什么 |
| --- | --- | --- | --- |
| 0.00–1.30 | BREATH | 横躺、缓慢呼吸 | 黑场，只有 lattice 远点与呼吸的线 |
| 1.30–2.70 | CARET | 竖起滑入输入框、随文字移动 | 逐字打出「帮我清理失效书签」 |
| 2.70–3.62 | SEND → DROP | 淡出 → 从上方落下 | 输入条压扁上飞；线落成扫描线 |
| 3.70–6.05 | SCAN | 横扫书签列 | 有效链点亮彩色 favicon；失效链标红 + 「失效」徽标 |
| 6.35–7.02 | COIL | 从扫描尾端卷成螺旋（r 150→10，两圈） | 圈住失效书签组 |
| 7.02–7.06 | — | 收成一个点 | 圈收成点 |
| 7.06–8.85 | CARD | 点 → 线的尾端具象成光标 | 删除确认卡从点长出；光标滑到「删除」并按下；卡片收束 |
| 8.88–9.22 | CHECK | 折线一笔（绿色） | 卡片收笔成对勾 |
| 9.42–9.78 | BURST | —（三下 sub+wood） | 三条死链依次裂开塌缩；幸存行**因果地**逐个补位 |
| 9.95–11.62 | REST | 在压缩后的列表下轻摆 | 近静止（画面 67% 静默，声音也留白） |
| 11.65–12.85 | FLY | 从歇息位起飞、穿过落下的字母 | wordmark 字母逐个落下 |
| 12.35–15.0 | END | 缩成 tagline 句号点 | 「你的书签，交给我。」+ 仓库地址 |

**为什么这样设计**：删掉一个动作（"帮我清理失效书签" → 扫描 → 标红 → 确认 → 删除 → 归位）
本身没有好讲之处，讲的是**那一条线从头到尾没断过**。每帧的图形都是上一帧的变形，
所以 15 秒是**一镜到底**，不是 12 张幻灯片。

## 复现

依赖（Python 侧）：

```bash
# onetake 依赖装在隔离 venv 里；playwright 的浏览器用项目内路径（系统缓存被沙箱锁）
VENV=/Users/xalor/.workbuddy/binaries/python/envs/default/bin/python3
export PLAYWRIGHT_BROWSERS_PATH="$PWD/../.workbuddy/pw-browsers"
```

`motion.js` 来自 onetake skill（**PolyForm Noncommercial**，不随本仓库分发）：

```bash
cp /Users/xalor/.workbuddy/skills/onetake/lib/motion.js .
```

生成色板（`look.js` 是产物，已 gitignore；中文字体从系统 ttc 抽出）：

```bash
$VENV /Users/xalor/.workbuddy/skills/onetake/scripts/look.py apply look.json comp.html \
  --cjk /tmp/markai-cjk.ttf
# 其中 /tmp/markai-cjk.ttf 由 fontTools 抽出：
#   TTFont('/System/Library/Fonts/Hiragino Sans GB.ttc', fontNumber=1).save('/tmp/markai-cjk.ttf')
```

出片与验收：

```bash
$VENV /Users/xalor/.workbuddy/skills/onetake/scripts/probe.py   comp.html   # carry / curves / framing
$VENV /Users/xalor/.workbuddy/skills/onetake/scripts/stills.py comp.html --times 0.7,1.9,... --out stills.png
$VENV sfx_score.py                                                   # sfx.wav（palette 材质）
$VENV /Users/xalor/.workbuddy/skills/onetake/scripts/render.py comp.html --out markai-promo-15s.mp4 --sfx sfx.wav
$VENV /Users/xalor/.workbuddy/skills/onetake/scripts/verify_promo.py markai-promo-15s.mp4 --comp comp.html
```

浏览器里调试：`file://.../comp.html?play` 实时循环、`?t=7.5&hud` 钉住一帧并显示时间码。

## 验收结果（`verify_promo.py`）

| 腿 | 结果 |
| --- | --- |
| cadence | CV 0.35（≥0.25），镜头长度 0.6–2.2s |
| rest | 静默占比 0.678、最长静段 5.33s |
| continuity | carry score **1.00**（2 个边界全部 carried、零 bare） |
| curves | 峰值 1023 px/帧处快门 180° 正常（无 banding） |
| audio | 峰值 −8.1 dBFS、零削波 |
| **VERDICT** | **PASS** |

## 踩过的三个坑（都是"看起来对、其实错"）

1. **CSS transform 围绕「布局位置 + transform-origin」共轭生效**。给元素挂相机矩阵时，
   布局在 `(0,0)` 才没有共轭项。把 `mstr` 直接挂到布局在 `(940,420)` 的卡片上，实际渲染是
   `T(940,420)·M·T(−940,·420)`，卡片偏了 150px，而 `getComputedStyle().transform` 读到的
   矩阵却是完全正确的 —— **"矩阵对、渲染不对"是这类 bug 的典型症状**。修法：一个 `(0,0)` 的
   `#near` 包装层挂相机，子元素世界位写进各自 transform 串（canvas 也要显式 `transform-origin:0 0`，
   默认是 50% 50%）。
2. **`OM.maskRise` 返回 `{k, y, visible}`，没有 `op`**。此前误用 `r.op`（`undefined`）去乘 opacity，
   浏览器**静默忽略非法样式值**，行永远保持默认不透明 —— 死链从不塌缩、退场也不生效。
   用 playwright 读 `el.style.opacity`（EMPTY）比看画面更快定位。
3. **canvas 笔触不产生可追踪的 DOM 元素**，所以 probe 的 continuity 判据（元素集合 Jaccard）
   看不见"线"这个 carry。END 段让**行随飞线同向上移退场**（而不是原地淡出），既解决了
   "行压住 wordmark"的画面问题，又让边界被判 carried —— 一举两得。
