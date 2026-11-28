# 并行工作线（v0.3 主线）

四条线并行开发，共享 `main` 上已经落好的接缝（commit `feat: 并行工作线共享接缝`）。

| 工作线 | 范围 | 负责人 |
| --- | --- | --- |
| `semantic-search` | 向量检索、索引、命令面板、Agent 搜索工具 | worktree |
| `ideas-agent` | 点子管家、老旧书签识别、简单清理、聊天发图 | worktree |
| `glass-ui` | 液态玻璃、动效、主题/背景自定义、检查更新 | worktree |
| `pet-external`（主工作区） | 宠物工作室/自定义、MCP/CLI/Skills 对外接口 | root |

## 共享接缝（不要改签名）

- `src/lib/features/flags.ts` — 功能开关与"未就绪"文案。
- `src/lib/features/semantic.ts` — `searchBookmarks()` 永远有结果；实现用 `registerSemanticSearcher()` 注入。
- `src/lib/features/ideas.ts` — `Idea` 形状与 `registerIdeaGenerator()`；没有生成器时返回空数组。
- `src/lib/features/external.ts` — 对外接口配置/审计/工具清单的类型。
- `src/lib/features/loader.ts` — 入口装配，失败只降级单个功能。
- `src/stores/appearanceStore.ts` — 外观（强调色/背景/动效/密度），写入 `<html>` 的 `--mk-*` 与 `data-*`。
- `src/assets/appearance.css` — 外观层样式，与 `main.css` 分开。

签名可以加**可选字段**，不能删字段、不能改已有字段类型。需要改签名时先在 worktree 里说明理由，合并时由 root 统一处理。

## 每个 worktree 的完成标准

```bash
npm run compile                      # 必须 0 错误
npx tsx tests/<你的区域>.test.ts      # 新增测试，全过
npm test                             # 现有 1112 项不许回退
npm run build                        # 必须成功
```

- 新测试写在**独立文件**（`tests/semantic.test.ts` 等），不要改 `tests/agent.test.ts`——那是共享大文件，四方同时改必冲突。root 合并时统一接进 `npm test`。
- 不要改 `package.json` 的版本号、不要发版、不要 push、不要合并到 `main`。
- 只改自己范围内的文件；需要动共享文件时，改动尽量小，并在最终报告里逐条列出。
- 不要提交 `promo/`。
- 中文注释，风格与现有代码一致：注释解释"为什么"，不复述"做了什么"。
- 每个可见控件必须可点、有 `aria-label`、有稳定的 `data-testid`。

## 合并方式

各 worktree 完成后在分支上 commit，向 root 报告：分支名、改动文件清单、验证命令与结果、已知未完成项。root 负责按依赖顺序合并（`semantic-search` → `ideas-agent` → `glass-ui`），每次合并后重跑全量验证。
