/**
 * 反证脚本（evidence，不是装饰）：逐条「回滚实现 → 跑测试 → 确认变红 → 恢复」。
 *
 * 为什么需要它：测试通过本身不是证据——跟着实现一起写错的测试也会通过。
 * 只有「把实现改回 bug 版本，测试必须失败」才能证明这条测试真的守护了它声称的东西。
 * 判定标准：回滚后必须变红，且第一个失败的用例名在 expectFail 列表里；
 * 任何一条「回滚后仍然全绿」= 该测试是假绿，脚本以非零码退出。
 *
 * 用法（在仓库根目录）：`node scripts/falsify.mjs`
 *
 * ⚠️ 运行期间会**真实改写工作区源码**（改完在 finally 里恢复）。
 *    不要与 tsc / 测试 / 构建并行运行，也不要在未提交改动上运行——
 *    否则你看到的编译错误可能只是本脚本的中间态（本项目踩过这个坑）。
 *
 * 维护：新增目标时把「回滚锚点 + 预期变红的用例名」追加到 cases。
 * 锚点随重构失效会显示 SKIP 并以非零码退出——这是刻意的，避免静默失效。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录 = 本脚本所在目录的上一级（脚本放 scripts/） */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const cases = [
  {
    name: '右键 seed 写失败仍继续打开侧边栏（用户只看到空聊天）',
    file: 'src/lib/ai/context-menu.ts',
    from: '      await deps.setErrorHint(ERROR_TITLE);\n      return;',
    to: '      // reverted',
    expectFail: [
      'seed 写入失败时不得打开侧边栏',
      'seed 写入失败时不得广播',
      'seed 写入失败必须给出可见反馈',
    ],
  },
  {
    name: '右键 seed 写失败也照常广播（假装指令已送出）',
    file: 'src/lib/ai/context-menu.ts',
    from: '      await deps.setErrorHint(ERROR_TITLE);\n      return;',
    to: '      await deps.broadcastSeed().catch(() => {});\n      return;',
    expectFail: [
      'seed 写入失败时不得打开侧边栏',
      'seed 写入失败时不得广播',
      'seed 写入失败必须给出可见反馈',
    ],
  },
  {
    name: '完整页打开失败被静默忽略',
    file: 'src/lib/ai/context-menu.ts',
    from: '      await deps.setErrorHint(\'MarkAI：完整页打开失败，请重试\');',
    to: '      // reverted',
    expectFail: ['完整页打开失败不再静默'],
  },
  {
    name: '收尾不等在途 pending 写入（迟到写入把快照复活）',
    file: 'src/lib/undo/recorder.ts',
    from: '  // 已正经收尾：先等在途写入落定，再清快照——避免"清理之后才落地的写入"把它复活\n  await drainPendingWrites();\n  await clearPending();',
    to: '  await clearPending();',
    expectFail: ['收尾会等待在途的 pending 写入'],
  },
  {
    name: '清空不等在途写入（清完又被写回来）',
    file: 'src/lib/undo/recorder.ts',
    from: '  // 先等在途写入落定再删：否则一条在路上的 pending 写入会在清空之后把它复活\n  await drainPendingWrites();',
    to: '  // reverted',
    expectFail: ['清空也会等在途写入落定'],
  },
  {
    name: 'pending 写入不串行化（慢的旧写入覆盖新快照）',
    file: 'src/lib/undo/recorder.ts',
    from: '  const next = pendingIo.then(task, task);',
    to: '  const next = task();',
    expectFail: ['写入串行化：较慢的旧写入不得覆盖较新的快照'],
  },
  {
    name: '消费失败仍报成功（原点留在存储里，再点就重复回放）',
    file: 'src/lib/undo/apply.ts',
    from: '  if (!consumed.removed) {\n    appliedThisSession.add(target.id);',
    to: '  if (false) {\n    appliedThisSession.add(target.id);',
    expectFail: ['消费写入失败时不得报成功'],
  },
  {
    name: '移除同一会话的重复回放保护（删除类逆操作会重复重建子树）',
    file: 'src/lib/undo/apply.ts',
    from: '  if (appliedThisSession.has(target.id)) {',
    to: '  if (false) {',
    expectFail: ['同一会话重复应用同一条撤销'],
  },
  {
    name: 'takeUndoPoint 谎报已消费（removed 恒 true）',
    file: 'src/lib/undo/recorder.ts',
    from: '  return { point, removed: written.ok };',
    to: '  return { point, removed: true };',
    expectFail: ['消费写入失败时不得报成功'],
  },
  {
    name: '清空撤销记录不 pending（旧快照下次启动会复活成撤销点）',
    file: 'src/lib/undo/recorder.ts',
    from: '  // 如实说明边界：这里**不能**取消正在运行中的轮次——那一轮结束时仍会写下新的撤销点，\n  // 这是刻意的语义（用户清的是"已有记录"，不是"正在进行的操作"）。\n  await clearPending();',
    to: '  // reverted',
    expectFail: ['「清空本地数据」会同时清掉进行中的 pending 快照'],
  },
  {
    name: '收尾时正式写入失败仍清掉 pending（唯一快照被删，改动再也撤不了）',
    file: 'src/lib/undo/recorder.ts',
    from: '  const written = await writeUndoPoints(trim.kept, notice, state.terminalRunIds);\n  if (!written.ok) {',
    to: '  const written = await writeUndoPoints(trim.kept, notice, state.terminalRunIds);\n  if (false) {',
    expectFail: ['收尾时正式写入失败：pending 必须保留', '收尾时正式写入失败不得声称'],
  },
  {
    name: '恢复时先删 pending 再写正式点（写失败即永久丢失）',
    file: 'src/lib/undo/recorder.ts',
    from: '  // 写失败时**保留 pending**，下次启动重试——绝不能在正式点落盘前就把它删掉\n  if (!written.ok) return null;\n  await clearPending();\n  return point;',
    to: '  await clearPending();\n  if (!written.ok) return null;\n  return point;',
    expectFail: ['恢复时正式写入失败：pending 必须保留'],
  },
  {
    name: '重复恢复不去重（同一事务生成第二个可回放点）',
    file: 'src/lib/undo/recorder.ts',
    from: '  const already = state.points.find((p) => p.runId === pending!.runId);\n  if (already) {\n    await clearPending();\n    return null;\n  }',
    to: '  // reverted',
    expectFail: ['同一事务重复恢复不会生成第二个可回放点'],
  },
  {
    name: 'update 不再返回如实结果（调用方无从判断成败）',
    file: 'src/stores/configStore.ts',
    from: '      return { ok: false, error: reason };',
    to: '      return { ok: true };',
    expectFail: ['update 返回如实结果'],
  },
  {
    name: '重试按钮不消费返回值（成败显示同一句话）',
    file: 'src/components/options/config-form.tsx',
    from: '                .then((r) =>\n                  r.ok\n                    ? pushToast(\'设置已保存\', { variant: \'success\' })\n                    : pushToast(\'仍未保存成功\', { variant: \'destructive\', description: r.error }),\n                );',
    to: '                .then(() => pushToast(\'设置已保存\', { variant: \'success\' }));',
    expectFail: ['设置页渲染了保存失败警示'],
  },
  {
    name: '设置保存失败回到空 catch（UI 已显示新值却没说没保存）',
    file: 'src/stores/configStore.ts',
    from: '      set({ saveError: { message, at } });',
    to: '      // reverted',
    expectFail: ['设置保存失败不再被空 catch 吞掉'],
  },
  {
    name: '删除模式保存失败不点名安全风险',
    file: 'src/stores/configStore.ts',
    from: '      const risky = patch.deleteMode !== undefined;',
    to: '      const risky = false;',
    expectFail: ['删除模式保存失败会点名安全风险'],
  },
  {
    name: '保存成功后不清除失败状态（提示长期挂着）',
    file: 'src/stores/configStore.ts',
    from: '      if (get().saveError) set({ saveError: null });',
    to: '      // reverted',
    expectFail: ['保存成功后清除失败状态'],
  },
  {
    name: '设置页不再显示保存失败警示',
    file: 'src/components/options/config-form.tsx',
    from: '          <span className="min-w-0 flex-1">{saveError.message}</span>',
    to: '          <span className="min-w-0 flex-1" />',
    expectFail: ['设置页渲染了保存失败警示'],
  },
  {
    name: '错误处理清单谎称已全部清理',
    file: 'docs/error-handling.md',
    from: '## 3. 仍未处理的（四个高风险类别已逐项判定，但全量枚举仍未逐处审计）',
    to: '## 3. 已全部清理',
    expectFail: ['docs/error-handling.md 存在并如实标注未清理的部分'],
  },
  {
    name: '成功路径不再用真实占用核对（估算偏低就当没看见）',
    file: 'src/stores/aiStore.ts',
    from: '          if (actual > chatBudgetBytes) {',
    to: '          if (false) {',
    expectFail: ['成功写入但真实占用仍超预算时'],
  },
  {
    name: '对话写盘失败回到空 catch（没保存成功却装作正常）',
    file: 'src/stores/aiStore.ts',
    from: '        set({ persistError: { message, at } });',
    to: '        // reverted',
    expectFail: ['写盘失败不再被吞掉'],
  },
  {
    name: '失败时间戳每次都刷新（流式期间会反复弹提示）',
    file: 'src/stores/aiStore.ts',
    from: '        const at = prev && prev.message === message ? prev.at : Date.now();',
    to: '        const at = Date.now();',
    expectFail: ['失败状态的时间戳稳定', '失败时会真的提示用户，且同一次故障只提示一次'],
  },
  {
    name: '对话历史不做预算裁剪（超配额就整段写不进去）',
    file: 'src/stores/aiStore.ts',
    from: '              const trim = trimConversationsToBudget(capped, chatBudgetBytes);',
    to: '              const trim = { kept: capped, droppedMessages: 0, droppedConversations: 0 };',
    expectFail: ['超预算时先裁剪再落盘'],
  },
  {
    name: '裁剪了却不告诉用户（静默降级）',
    file: 'src/stores/aiStore.ts',
    from: '                set({ persistNotice: `对话记录已超出本地存储预算，为了保存最近的对话，已丢弃${what}。` });',
    to: '                void what;',
    expectFail: ['丢弃了更早的对话就如实告知'],
  },
  {
    name: '失败提示不带真实占用（含糊其辞）',
    file: 'src/stores/aiStore.ts',
    from: '          used = `（当前该键占用约 ${(bytes / 1024 / 1024).toFixed(1)} MiB）`;',
    to: "          used = '';",
    expectFail: ['失败提示带上了真实占用'],
  },
  {
    name: '增量落盘被移除（回到"只在轮次结束才写"）',
    file: 'src/lib/undo/recorder.ts',
    from: '  active?.ops.push(op);\n  void persistPending();',
    to: '  active?.ops.push(op);',
    expectFail: ['过了节流窗口后快照会追上', '事务进行中就有增量快照', '被中断的轮次会被提升为可撤销点'],
  },
  {
    name: '尾随补写被移除（停下来之后快照就停在旧值）',
    file: 'src/lib/undo/recorder.ts',
    from: '    // 本次跳过写入：安排尾随补写，保证"停下来"之后快照也能追上\n    scheduleTrailingFlush();\n    return;',
    to: '    return;',
    expectFail: ['过了节流窗口后快照会追上'],
  },
  {
    name: '正常收尾后不清 pending（下次启动会重复提升）',
    file: 'src/lib/undo/recorder.ts',
    from: '  // 已正经收尾：先等在途写入落定，再清快照——避免"清理之后才落地的写入"把它复活\n  await drainPendingWrites();\n  await clearPending();',
    to: '  // reverted',
    expectFail: ['正常收尾后清除 pending'],
  },
  {
    name: '启动时不恢复被中断的轮次',
    file: 'src/lib/undo/recorder.ts',
    from: '  if (!pending || !Array.isArray(pending.ops) || pending.ops.length === 0) {\n    await clearPending();\n    return null;\n  }',
    to: '  if (true) {\n    await clearPending();\n    return null;\n  }',
    expectFail: ['被中断的轮次会被提升为可撤销点'],
  },
  {
    name: 'SW 启动不再调用恢复（接线断了）',
    file: 'src/entrypoints/background.ts',
    from: '  void recoverInterruptedTransaction();',
    to: '  // reverted',
    expectFail: ['Service Worker 启动时确实调用了恢复'],
  },
  {
    name: 'cleanup_sweep 预览也执行删除（dryRun 失效）',
    file: 'src/lib/ai/tools.ts',
    from: '  if (dryRun) {\n    return {\n      result: JSON.stringify({\n        dryRun: true,\n        total: collected.length,',
    to: '  if (false) {\n    return {\n      result: JSON.stringify({\n        dryRun: true,\n        total: collected.length,',
    expectFail: ['cleanup_sweep 预览：dryRun 标记、不改动书签、不产生提议'],
  },
  {
    name: 'auto_categorize 预览也真的建文件夹并移动',
    file: 'src/lib/ai/tools.ts',
    from: '  if (dryRun) {\n    return {\n      result: JSON.stringify({\n        dryRun: true,\n        total: bookmarks.length,',
    to: '  if (false) {\n    return {\n      result: JSON.stringify({\n        dryRun: true,\n        total: bookmarks.length,',
    expectFail: ['auto_categorize 预览：dryRun 标记、不创建文件夹也不移动书签'],
  },
  {
    name: '去重忽略 limit（一次提交上千条提议）',
    file: 'src/lib/ai/tools.ts',
    from: '  const groups = buildDuplicateGroups(roots as unknown as DupeNode[]).slice(0, limit);',
    to: '  const groups = buildDuplicateGroups(roots as unknown as DupeNode[]);',
    expectFail: ['limit 生效'],
  },
  {
    name: '去重保留规则不再优先自定义标题',
    file: 'src/lib/ai/dedupe.ts',
    from: '    const custom = Number(hasCustomTitle(b)) - Number(hasCustomTitle(a));',
    to: '    const custom = 0;',
    expectFail: ['保留规则：自定义标题优先'],
  },
  {
    name: '去重保留规则丢掉 id 稳定排序（结果随输入顺序变）',
    file: 'src/lib/ai/dedupe.ts',
    from: '    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;',
    to: '    return 0;',
    expectFail: ['保留规则：其余条件相同则按 id 稳定排序'],
  },
  {
    name: 'dryRun 仍然写库（预览会真的删东西）',
    file: 'src/lib/ai/tools.ts',
    from: '  if (dryRun || toRemove.length === 0) {',
    to: '  if (toRemove.length === 0) {',
    expectFail: ['dryRun 只出计划'],
  },
  {
    name: 'confirm 模式把保留项也提交删除',
    file: 'src/lib/ai/tools.ts',
    from: '    for (const p of plans) {\n      for (const r of p.remove) {\n        deletions.push({\n          id: uid(),\n          bookmarkId: r.id,\n          title: r.title || r.url || \'(未命名)\',\n          url: r.url,\n          reason: `重复书签（保留「${p.keep.title || p.keep.url}」：${p.reason}）`,',
    to: '    for (const p of plans) {\n      for (const r of [p.keep, ...p.remove]) {\n        deletions.push({\n          id: uid(),\n          bookmarkId: r.id,\n          title: r.title || r.url || \'(未命名)\',\n          url: r.url,\n          reason: `重复书签（保留「${p.keep.title || p.keep.url}」：${p.reason}）`,',
    expectFail: ['默认（需确认）模式：提交的提议恰好是非保留项', 'limit 生效'],
  },
  {
    name: '较早撤销记录重新变为可执行（把历史列表误导成"状态跳转")',
    file: 'src/lib/undo/journal.ts',
    from: '    const latestOnly = index === 0;\n    const undoable = latestOnly && ready.undoable;',
    to: '    const latestOnly = true;\n    const undoable = ready.undoable;',
    expectFail: ['撤销历史：只有最新一步可执行'],
  },
  {
    name: '历史面板点击不回传行 id（退回"撤销最新那个"）',
    file: 'src/components/chat/chat-panel.tsx',
    from: '                      void undoLast(row.id);',
    to: '                      void undoLast();',
    expectFail: ['聊天面板确实从 store 的撤销点渲染历史'],
  },
  {
    name: 'store 忽略显式指定的撤销点 id',
    file: 'src/stores/aiStore.ts',
    from: '    const shown = id ?? get().undoPoints[0]?.id;',
    to: '    const shown = get().undoPoints[0]?.id;',
    expectFail: ['跳选撤销：显式传入的撤销点 id 被原样下发'],
  },
  {
    name: '手工删除不再记日志（回到裸 removeTree，即不可撤销）',
    file: 'src/lib/ai/deletion-executor.ts',
    from: '        await jRemove(id, { tree: true });\n      } catch {\n        // 瞬时失败（限流/竞态）重试一次',
    to: '        await chrome.bookmarks.removeTree(id);\n      } catch {\n        // 瞬时失败（限流/竞态）重试一次',
    expectFail: ['手工确认删除会自己产生一个撤销点'],
  },
  {
    name: '手工删除无条件自开事务（会把 Agent 轮次的日志切成两段）',
    file: 'src/lib/ai/deletion-executor.ts',
    from: '  const ownsTransaction = !isRecording();',
    to: '  const ownsTransaction = true;',
    expectFail: ['Agent 轮次进行中的手工删除并入该轮'],
  },
  {
    name: 'clearUndoPoints 不再真的清空（隐私承诺落空）',
    file: 'src/lib/undo/recorder.ts',
    from: '  lastWriteError = null;\n  // 先等在途写入落定再删：否则一条在路上的 pending 写入会在清空之后把它复活\n  await drainPendingWrites();\n  await chrome.storage.local.remove(UNDO_STORAGE_KEY);',
    to: '  lastWriteError = null;',
    expectFail: ['clearUndoPoints 真的清空撤销记录'],
  },
  {
    name: '设置页不再调用 clearUndoPoints（接线断了）',
    file: 'src/components/options/config-form.tsx',
    from: '      await clearUndoPoints();',
    to: '      // reverted',
    expectFail: ['设置页的清空动作确实调用了 clearUndoPoints'],
  },
  {
    name: '权限文档与 manifest 漂移（文档少列一项）',
    file: 'docs/permissions.md',
    from: 'manifest-permissions: bookmarks, storage, tabs, tabGroups, contextMenus, sidePanel',
    to: 'manifest-permissions: bookmarks, storage, tabGroups, contextMenus, sidePanel',
    expectFail: ['docs/permissions.md 的权限清单与 wxt.config.ts 完全一致'],
  },
  {
    name: 'manifest 偷偷多加一项权限（文档没写）',
    file: 'wxt.config.ts',
    from: "    permissions: ['bookmarks', 'storage', 'tabs', 'tabGroups', 'contextMenus', 'sidePanel'],",
    to: "    permissions: ['bookmarks', 'storage', 'tabs', 'tabGroups', 'contextMenus', 'sidePanel', 'history'],",
    expectFail: ['docs/permissions.md 的权限清单与 wxt.config.ts 完全一致'],
  },
  {
    name: '隐私说明不再披露死链检测会联系书签站点',
    file: 'docs/privacy.md',
    from: '会**直接向书签指向的 URL 发 HEAD 请求**',
    to: '会联系书签站点',
    expectFail: ['隐私说明覆盖了三件必须说的事'],
  },
  {
    name: '隐私说明隐瞒在途快照与终态列表',
    file: 'docs/privacy.md',
    from: '| `markai.undo.pending` | 崩溃/断电恢复用的在途事务快照：正常收尾、恢复完成或用户清空时自动删除 |',
    to: '',
    expectFail: ['隐私说明覆盖了三件必须说的事'],
  },
  {
    name: 'release workflow 又发未验证的 Firefox 产物',
    file: '.github/workflows/release.yml',
    from: '      - name: 打包 Chrome zip',
    to: '      - name: 打包 Firefox zip\n        run: npm run zip:firefox\n\n      - name: 打包 Chrome zip',
    expectFail: ['release workflow 不再发布未验证的 Firefox 产物'],
  },
  {
    name: 'store-listing 漏掉 bookmarks 权限审核理由',
    file: 'docs/store-listing.md',
    from: '| `bookmarks` |',
    to: '| `bookmarks_missing` |',
    expectFail: ['store-listing.md 严格遵守 Chrome Web Store 规范与权限对齐'],
  },
  {
    name: 'release-notes-0.2.23 遗漏 planMode 关键说明',
    file: 'docs/release-notes-0.2.23.md',
    from: '1. **关键修复**：修复 `resolveConfig` 遗漏 `planMode` 字段',
    to: '1. **关键修复**：修复 `resolveConfig` 遗漏字段',
    expectFail: ['docs/release-notes-0.2.23.md 完整记载 v0.2.23 核心交付点'],
  },
  {
    name: 'Chrome Web Store 推广横幅尺寸篡改',
    file: 'scripts/generate-promo-tiles.mjs',
    from: "{ name: 'promo-small-440x280.png', w: 440, h: 280 }",
    to: "{ name: 'promo-small-440x280.png', w: 400, h: 200 }",
    expectFail: ['Chrome Web Store 推广横幅规格严格符合官方尺寸'],
  },
  {
    name: 'resolveDropIndex 放弃负数与非整数防护（直接使用 raw rowIndex）',
    file: 'src/lib/bookmark-dnd.ts',
    from: '  const safe = Number.isFinite(rowIndex) ? Math.max(0, Math.floor(rowIndex)) : 0;',
    to: '  const safe = rowIndex;',
    expectFail: ['resolveDropIndex 边界防护：负数、非整数与非法数值安全钳位至 >= 0'],
  },
  {
    name: 'getHost 放弃剥离 www 前缀',
    file: 'src/lib/format.ts',
    from: "    return new URL(url).hostname.replace(/^www\\./, '');",
    to: '    return new URL(url).hostname;',
    expectFail: ['getHost：正确提取标准与多级域名，剥离 www，处理无效输入'],
  },
  {
    name: 'isSpecialUrl 放弃特殊协议识别（直接放行）',
    file: 'src/lib/format.ts',
    from: "  return /^(chrome|chrome-extension|about|edge|moz-extension|file|data|javascript|view-source):/i.test(url.trim());",
    to: '  return false;',
    expectFail: ['isSpecialUrl 准确识别特殊与本地协议'],
  },
  {
    name: 'isRoot 放弃对虚拟根节点 id 0 的保护',
    file: 'src/lib/ai/tools.ts',
    from: "export function isRoot(id: string): boolean {\n  return id === '0' || ROOT_IDS.has(id);\n}",
    to: "export function isRoot(id: string): boolean {\n  return ROOT_IDS.has(id);\n}",
    expectFail: ['isRoot：明确判定虚拟根节点 id 0 与子根文件夹为根节点'],
  },
  {
    name: 'assertNoCycle 放弃循环嵌套拦截（直接放行）',
    file: 'src/lib/ai/tools.ts',
    from: "    if (cur === bookmarkId) throw new Error('目标文件夹是自身或自身的子文件夹，会造成循环嵌套');",
    to: '    // cycle check bypassed',
    expectFail: ['assertNoCycle 拦截自身与子孙嵌套'],
  },
  {
    name: 'trimConversationsToBudget 放弃超预算裁剪',
    file: 'src/lib/ai/chat-budget.ts',
    from: '  if (approximateBytes(conversations) <= safeBudget) {',
    to: '  if (true) {',
    expectFail: ['裁剪边界：空列表、0 预算与负数预算安全处理不崩溃', '裁剪：超预算时从最旧会话丢最旧消息，且保留最新那条'],
  },
  {
    name: 'bookmarkStore collapseOthers 遗漏目标文件夹自身',
    file: 'src/stores/bookmarkStore.ts',
    from: '      if (cur && !cur.url) keep.add(cur.id);',
    to: '      // keep target self omitted',
    expectFail: ['collapseOthers 保留自身与祖先'],
  },
  {
    name: 'applyPlan 未确认也强行执行（破坏安全默认值）',
    file: 'src/lib/ai/turn-plan.ts',
    from: '  if (opts?.confirmed !== true) {',
    to: '  if (false) {',
    expectFail: ['applyPlan 未确认零执行确认后如实计数'],
  },
  {
    name: 'deletion-executor 收尾指定错误 runId 导致事务无法关闭',
    file: 'src/lib/ai/deletion-executor.ts',
    from: "    if (ownsTransaction) await endUndoTransaction('deletions:manual');",
    to: "    if (ownsTransaction) await endUndoTransaction('wrong-run-id');",
    expectFail: ['手工确认删除会自己产生一个撤销点（不再是永久删除）', '手工删除事务身份为 deletions:manual'],
  },
  {
    name: 'isRetriableError 放弃 429 限流重试',
    file: 'src/lib/ai/client.ts',
    from: '  if (status === 429) return true; // 限流：退避后重试',
    to: '  if (status === 429) return false;',
    expectFail: ['isRetriableError 状态码矩阵判定'],
  },
  {
    name: 'buildInstruction 丢失失效节点友好提示',
    file: 'src/lib/ai/context-menu.ts',
    from: "  if (!node) return { text: '', notice: '右键的书签已被删除或不可用，请重新选择。' };",
    to: "  if (!node) return { text: '' };",
    expectFail: ['buildInstruction 针对单书签、文件夹与失效节点的指令装配'],
  },
  {
    name: 'Toast 队列不再限制硬上限（移除 slice 裁剪）',
    file: 'src/lib/toast.ts',
    from: 'toasts: [...s.toasts.slice(-3), { ...t, id, createdAt: Date.now() }]',
    to: 'toasts: [...s.toasts, { ...t, id, createdAt: Date.now() }]',
    expectFail: ['Toast 队列硬上限：连续推送大量通知仅保留最新 4 条，防 DOM 爆炸'],
  },
  {
    name: 'resolveConfig 遗漏 planMode 映射（后台轮次无法激活计划模式）',
    file: 'src/lib/providers.ts',
    from: '    planMode: saved?.planMode ?? false,',
    to: '    // planMode omitted',
    expectFail: ['resolveConfig：正确透传 planMode: true，缺省回落为 false'],
  },
  {
    name: '预算裁剪失效（超预算不再丢最旧）',
    file: 'src/lib/undo/journal.ts',
    from: '    if (total + size <= budgetBytes) {',
    to: '    if (true) {',
    expectFail: ['预算内按新→旧保留，超出预算丢最旧的', '超预算时丢最旧的'],
  },
  {
    name: '单点过大时不再单独跳过（会牵连其他点）',
    file: 'src/lib/undo/journal.ts',
    from: '      droppedTooLarge.push(p);\n      continue;',
    to: '      droppedNoRoom.push(p);\n      continue;',
    expectFail: ['单点超预算时只跳过它'],
  },
  {
    name: '丢弃说明不再生成（静默丢弃）',
    file: 'src/lib/undo/journal.ts',
    from: "  return parts.length > 0 ? parts.join('；') : undefined;",
    to: '  return undefined;',
    expectFail: ['describeUndoTrim 把人话说明写全'],
  },
  {
    name: '写失败又被静默吞掉',
    file: 'src/lib/undo/recorder.ts',
    from: '    lastWriteError = { message: `撤销记录写入失败（${msg}），本次操作将无法撤销`, at: Date.now() };',
    to: '    lastWriteError = null;',
    expectFail: ['写入失败不再被吞掉'],
  },
  {
    name: 'notice 不再呈现给用户',
    file: 'src/stores/aiStore.ts',
    from: '        undoNotice: res.notice ?? null,',
    to: '        undoNotice: null,',
    expectFail: ['notice 会呈现给用户'],
  },
  {
    name: '同一条 notice 反复打扰（不去重）',
    file: 'src/stores/aiStore.ts',
    from: '      if (res.notice && res.noticeAt && res.noticeAt !== prevAt) {',
    to: '      if (res.notice) {',
    expectFail: ['同一条 notice 不重复打扰'],
  },
  {
    name: '删除不再记子树快照（回到"删除不可逆"）',
    file: 'src/lib/undo/mutations.ts',
    from: '    ...(captured?.snapshot ? { snapshot: captured.snapshot } : {}),',
    to: '',
    expectFail: [
      '删除记录了子树快照与位置锚点',
      '并发删除后撤销',
      '撤销删除文件夹',
      '自动清理一轮后撤销',
      '清空书签库后撤销',
    ],
  },
  {
    name: '删除还原后不做 old→new id 映射（顺序检查点对不上）',
    file: 'src/lib/undo/apply.ts',
    from: '        cp.order.map((id) => idMap.get(id) ?? id),',
    to: '        cp.order,',
    expectFail: ['并发删除后撤销', '撤销删除文件夹', '自动清理一轮后撤销', '清空书签库后撤销'],
  },
  {
    name: 'applyUndo 不执行父目录顺序检查点',
    file: 'src/lib/undo/apply.ts',
    from: '  for (const cp of target.orderCheckpoints ?? []) {',
    to: '  for (const cp of [] as { parentId: string; order: string[] }[]) {',
    expectFail: ['并发删除后撤销', '自动清理一轮后撤销'],
  },
  {
    name: 'cleanup_sweep 删除前不拍顺序检查点（并发删除顺序错乱）',
    file: 'src/lib/ai/tools.ts',
    from: "    // 删除前先给每个会失去子项的父目录拍一次\"动手前完整子序\"：\n    // 下面是 10 路并发删除，逐条下标/锚点都无法可靠还原顺序，撤销要靠这些检查点。\n    for (const p of new Set(targets.map((t) => t.parentId).filter((x): x is string => !!x))) {\n      await ensureOrderCheckpoint(p);\n    }",
    to: '    // reverted',
    expectFail: ['自动清理一轮后撤销'],
  },
  {
    name: '无快照的历史删除点不再被拒绝（会做"半撤销"）',
    file: 'src/lib/undo/journal.ts',
    from: '  return ops.filter((op) => op.kind === \'delete\' && !op.snapshot);',
    to: '  return [];',
    expectFail: ['undoReadiness：带快照的删除可撤', 'store 里的含删除撤销点被判定为不可撤销'],
  },
  {
    name: 'auto_categorize 退回逐条埋点（并发下标不构成一致历史）',
    file: 'src/lib/ai/tools.ts',
    from: '          await chrome.bookmarks.move(id, { parentId: folderId });',
    to: '          await jMove(id, { parentId: folderId });',
    expectFail: ['大库下的撤销点覆盖了全部写入，且并发批次只记一条', '5000+ 节点下撤销后整棵树（含顺序）与操作前逐节点一致'],
  },
  {
    name: 'moveBatch 撤销时不做顺序还原（只把节点搬回去）',
    file: 'src/lib/undo/apply.ts',
    from: '      await restoreParentOrder(op.fromParentId, op.order);',
    to: '      // reverted',
    expectFail: ['5000+ 节点下撤销后整棵树（含顺序）与操作前逐节点一致'],
  },
  {
    name: '批次按操作条数计权重（800 条显示成 1 项）',
    file: 'src/lib/undo/journal.ts',
    from: '  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + opWeight(op));',
    to: '  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);',
    expectFail: ['批次按条数计权重'],
  },
  {
    name: 'applyUndo 把"指定 id 找不到"退化成撤销最新点',
    file: 'src/lib/undo/apply.ts',
    from: '  if (id && !target) {',
    to: '  if (false) {',
    expectFail: ['applyUndo 对不存在的 id 如实拒绝'],
  },
  {
    name: '撤销只发「最新那个」而不带展示点的 id',
    file: 'src/stores/aiStore.ts',
    from: "        type: 'undo:apply',\n        id: shown,",
    to: "        type: 'undo:apply',",
    expectFail: ['撤销显式针对 store 当前展示的撤销点'],
  },
  {
    name: '跨窗口不监听 markai.undo（按钮会留陈旧入口）',
    file: 'src/stores/aiStore.ts',
    from: '    if (changes[UNDO_STORAGE_KEY]) {',
    to: '    if (false) {',
    expectFail: ['别的窗口改动撤销点会触发本窗口 refreshUndo'],
  },
  {
    // ⚠️ 回滚值必须是**与版本无关**的假值：早期写死 '0.2.2'，一旦 package.json 升到 0.2.3
    //    它就变成"与清单不一致"，于是先红的是另一条断言（同样是有效证据，但预期名会失配）。
    name: 'appVersion 变成写死的常量',
    file: 'src/lib/version.ts',
    from: '    return chrome.runtime.getManifest().version;',
    to: "    return '0.0.0-hardcoded';",
    expectFail: [
      'appVersion 取的就是清单版本（与 package.json 一致）',
      'appVersion 跟随清单变化（不是写死的常量）',
    ],
  },
  {
    name: 'UI 又硬编码版本号（0.2.0→0.2.1 真实发生过的漂移）',
    file: 'src/components/options/config-form.tsx',
    from: '        MarkAI v{appVersion()} · 支持',
    to: '        MarkAI v0.2.2 · 支持',
    expectFail: ['src 下没有硬编码的三段式版本号（防再次漂移）'],
  },
  {
    name: 'undoLast 把"零还原的拒绝"也报成成功（不再走如实提示分支）',
    file: 'src/stores/aiStore.ts',
    from: '        } else if (r.restored === 0) {',
    to: '        } else if (false) {',
    expectFail: ['撤销被拒时如实提示原因，不得谎报成功'],
  },
  {
    name: 'refreshUndo 忽略 background 返回的撤销点',
    file: 'src/stores/aiStore.ts',
    from: '        undoPoints: res.points,',
    to: '        undoPoints: [],',
    expectFail: ['store 里的含删除撤销点被判定为不可撤销'],
  },
  {
    name: '撤销同父移动时少了 index 换算（实测抓到的真实 bug）',
    file: 'src/lib/undo/apply.ts',
    from: '      if (node.parentId === op.fromParentId) {',
    to: '      if (false) {',
    expectFail: ['撤销后整棵树（含顺序）与操作前逐节点一致'],
  },
  {
    name: 'jMove 在移动之后才取旧下标',
    file: 'src/lib/undo/mutations.ts',
    from: '  const moved = await chrome.bookmarks.move(id, dest);',
    to: '  const moved = await chrome.bookmarks.move(id, dest);\n  if (node?.parentId) {\n    fromParentId = node.parentId;\n    const after = await chrome.bookmarks.getChildren(node.parentId);\n    fromIndex = after.findIndex((s) => s.id === id);\n  }',
    expectFail: ['jMove 记录的是移动前的父目录与下标', '撤销点记录了全部可逆操作', '撤销后整棵树（含顺序）与操作前逐节点一致'],
  },
  {
    name: 'jRemove 不标记含删除',
    file: 'src/lib/undo/mutations.ts',
    from: '  markDelete();',
    to: '',
    expectFail: ['删除记录了子树快照与位置锚点', '自动清理一轮后撤销'],
  },
  {
    name: 'jCreate 不记录新建',
    file: 'src/lib/undo/mutations.ts',
    from: "  recordOp({ kind: 'create', id: node.id, title: node.title || '(未命名)', isFolder: !node.url });",
    to: '  void node;',
    expectFail: ['撤销后整棵树（含顺序）与操作前逐节点一致', '撤销点记录了全部可逆操作'],
  },
  {
    name: 'agent 不结束事务（撤销点永不落盘）',
    file: 'src/lib/ai/agent.ts',
    from: '  } finally {\n    // 只收尾**自己**这一轮的事务：被抢占后迟到苏醒时不得把新轮次的事务一起关掉\n    await endUndoTransaction(params.messageId);\n  }',
    to: '  } finally {\n    // reverted\n  }',
    expectFail: ['Agent 轮次自动产生撤销点'],
  },
  {
    name: '落点补偿 off-by-one（历史 bug：向后拖拽静默失效）',
    file: 'src/lib/bookmark-dnd.ts',
    from: "  return position === 'above' ? rowIndex : rowIndex + 1;",
    to: "  return position === 'below' ? Math.max(0, rowIndex - 1) : rowIndex;",
    expectFail: ['resolveDropIndex：上方=行下标', '向后拖一格真的生效'],
  },
  {
    name: '替身忽略 index（本次升级前的假替身）',
    file: 'tests/agent.test.ts',
    from: '    insertSiblingAt(node, target ?? childrenOf(dest.parentId).length);',
    to: '    insertSiblingAt(node, childrenOf(dest.parentId).length);',
    expectFail: ['move_bookmarks 保持输入顺序', '向后拖一格真的生效', '替身复现空操作'],
  },
  {
    name: 'move_bookmark 移动后才解析 fromPath',
    file: 'src/lib/ai/tools.ts',
    from: '  const fromPath = await resolvePath(bookmarkId);',
    to: '  const fromPath = "";',
    expectFail: ['move_bookmark fromPath 记录移动前路径'],
  },
  {
    name: 'resolvePath 把元根算进路径',
    file: 'src/lib/ai/tools.ts',
    from: "    if (!node.parentId) break;\n    parts.unshift(node.title || '(未命名)');\n    cur = node.parentId;\n  }\n  return parts.join(' > ') || '(未知路径)';",
    to: "    parts.unshift(node.title || '(未命名)');\n    if (!node.parentId) break;\n    cur = node.parentId;\n  }\n  return parts.join(' > ') || '(未知路径)';",
    expectFail: ['路径不把元根渲染成'],
  },
  {
    name: 'check_urls skipped 聚合为数组',
    file: 'src/lib/ai/tools.ts',
    from: "  for (const u of skipped) out.push({ url: u, status: 'skipped', message: 'URL 格式无效，已跳过' });",
    to: "  if (skipped.length) out.push({ url: skipped, status: 'skipped', message: 'URL 格式无效，已跳过' });",
    expectFail: ['check_urls skipped 逐条输出'],
  },
  {
    name: 'move_bookmarks 缺文件夹循环校验',
    file: 'src/lib/ai/tools.ts',
    from: '      const node = (await chrome.bookmarks.get(id).catch(() => []))[0];\n      if (node && !node.url) await assertNoCycle(id, pid);\n',
    to: '',
    expectFail: ['move_bookmarks 拦截文件夹移入自身子树'],
  },
  {
    name: 'open_bookmarks 吞掉失败仍计数',
    file: 'src/lib/ai/tools.ts',
    from: '    try {\n      await chrome.tabs.create({ url: node.url, active: !background });\n      opened.push(node.title || node.url);\n    } catch {\n      // 单个标签页创建失败（如被浏览器拦截）只计成功数，不虚报 opened\n    }',
    to: '    await chrome.tabs.create({ url: node.url, active: !background });\n    opened.push(node.title || node.url);',
    expectFail: ['open_bookmarks 失败不虚报'],
  },
  {
    name: 'merge_folders 吞错仍 moved++',
    file: 'src/lib/ai/tools.ts',
    from: '      await jMove(child.id, { parentId: targetId });\n      moved++;\n    } catch {\n      // 单条移动失败不阻断整体，但要如实计数（原先吞错后仍 moved++ 会虚报成功数）\n      moveFailed++;\n    }',
    to: '      await jMove(child.id, { parentId: targetId }).catch(() => {});\n      moved++;\n    } catch {\n      moveFailed++;\n    }',
    expectFail: ['merge_folders 如实计数'],
  },
  {
    name: 'agent 调用点重复计入系统提示（预算虚高）',
    file: 'src/lib/ai/agent.ts',
    from: '  const usedTokens = () => estimateRequestTokens(apiMessages);',
    to: '  const usedTokens = () => fixedOverheadTokens() + estimateRequestTokens(apiMessages);',
    expectFail: ['预算记账正确时工具循环继续'],
  },
  {
    name: '计划确认不再与 abort 赛跑（轮次被中止后永久挂起）',
    file: 'src/lib/ai/plan-approval.ts',
    from: "    signal.addEventListener('abort', onAbort, { once: true });",
    to: '    void onAbort;',
    expectFail: ['轮次停在计划确认时被 abort，必须能结束（不能永远挂起）'],
  },
  {
    name: 'endUndoTransaction 不再校验轮次（迟到的收尾会偷走新轮次的事务）',
    file: 'src/lib/undo/recorder.ts',
    from: '  if (expectedRunId !== undefined && tx && tx.runId !== expectedRunId) return null;',
    to: '  if (false) return null;',
    expectFail: ['迟到的旧轮次收尾不得产出撤销点，也不得关闭新轮次的事务'],
  },
  {
    name: '预授权不再看已批准规模（声明 3 条却放行 200 条）',
    file: 'src/lib/ai/agent.ts',
    from: '    return stepCountOf(argsJson) <= declared;',
    to: '    return true;',
    expectFail: ['实际规模超过已批准上限时必须再次确认（批准范围不能被静默超出）'],
  },
  {
    name: '声明的条数又被静默丢掉（inferCount 不认 count 字段）',
    file: 'src/lib/ai/turn-plan.ts',
    from: '  if (typeof explicit === \'number\' && Number.isFinite(explicit) && explicit >= 0) {',
    to: '  if (false) {',
    expectFail: ['inferStepCount 认得显式的 count 数字（声明条数不会丢）'],
  },
  {
    name: '卡片又把"条数未声明"显示成确定数字',
    file: 'src/components/chat/chat-panel.tsx',
    from: "                    {step.countDeclared ? `${step.count} 项` : '条数未声明'}",
    to: "                    {`${step.count} 项`}",
    expectFail: ['UI：计划卡片渲染每步条数，且对"未声明条数"有如实文案'],
  },
  {
    name: 'planMode 不再把"先声明计划"写进系统提示（模型无从知道该声明）',
    file: 'src/lib/ai/agent.ts',
    from: "    config.planMode === true ? SYSTEM_PROMPT + PLAN_MODE_INSTRUCTION : SYSTEM_PROMPT;",
    to: '    SYSTEM_PROMPT;',
    expectFail: ['planMode 开启时，系统提示要求先声明整轮计划再动手'],
  },
  {
    name: '整轮预授权放行未声明的写操作（把安全边界交给模型自觉）',
    file: 'src/lib/ai/agent.ts',
    from: "            !withinGrant(tc.function.name, tc.function.arguments),",
    to: '            !turnGrant?.approved,',
    expectFail: ['已批准的声明之外的写操作，仍必须再次确认（不能靠模型自觉）'],
  },
  {
    name: '取消后不再阻断整轮（用户说过不要还继续追问）',
    file: 'src/lib/ai/agent.ts',
    from: '        if (turnGrant && !turnGrant.approved) {',
    to: '        if (false) {',
    expectFail: ['取消之后不再重复追问（用户已经说过不要，不该被再问一次）'],
  },
  {
    name: '确认登记表断线时按"批准"结算（面板关了反而放行）',
    file: 'src/lib/ai/plan-approval.ts',
    from: '      for (const settle of all) settle(false);',
    to: '      for (const settle of all) settle(true);',
    expectFail: ['cancelAll 把未决请求按"未批准"结算（绝不挂死一轮）'],
  },
  {
    name: '计划决定不再匹配 messageId（迟到的决定能批准别的轮次）',
    file: 'src/lib/ai/plan-approval.ts',
    from: '      const settle = pending.get(messageId);',
    to: '      const settle = [...pending.values()][0];',
    expectFail: ['对未知 messageId 的 resolve 返回 false（不命中）'],
  },
  {
    name: 'agent 不再走计划闸门（写操作在确认前就落库）',
    file: 'src/lib/ai/agent.ts',
    from: "      if (planEnabled && cls === 'write') {",
    to: '      if (false) {',
    expectFail: ['计划模式：发出 chat:plan 事件，且清单里是这一步的写操作'],
  },
  {
    name: '计划取消后仍继续执行（"取消"变成空话）',
    file: 'src/lib/ai/agent.ts',
    from: '      if (!approved) {',
    to: '      if (false) {',
    expectFail: ['计划模式取消：写操作零执行'],
  },
  {
    name: '轮次计划不再排除闸门类（propose_deletions 被二次延迟）',
    file: 'src/lib/ai/turn-plan.ts',
    from: "    if (classifyTool(s.name) !== 'write') continue;",
    to: "    if (classifyTool(s.name) === 'read' || classifyTool(s.name) === 'unknown') continue;",
    // 回滚后闸门类会进计划，先撞上"只保留写类"这条，再撞上"闸门类不进计划"——两条都是真信号
    expectFail: [
      'buildPlan：只保留写类，且保持原顺序',
      'buildPlan：闸门类不进计划（它本身就是"延迟的删除"）',
    ],
  },
  {
    name: '轮次计划丢了失败计数（部分失败被吞成成功）',
    file: 'src/lib/ai/turn-plan.ts',
    from: '      failed += 1;',
    to: '      failed += 0;',
    expectFail: ['applyPlan：单条失败不中断，并如实计数与带首个原因'],
  },
  {
    name: '轮次计划丢掉安全默认（未确认也会执行）',
    file: 'src/lib/ai/turn-plan.ts',
    from: '  if (opts.confirmed !== true) {',
    to: '  if (false) {',
    expectFail: ['applyPlan 默认不执行：未确认时 executor 零调用、并标 cancelled'],
  },
  {
    name: '快捷键打开侧边栏失败又静默（按了没反应）',
    file: 'src/entrypoints/background.ts',
    from: "        await toolbarError('MarkAI：侧边栏未能自动打开，请点扩展图标手动打开');",
    to: '        // reverted',
    expectFail: ['快捷键打开侧边栏失败时使用工具栏提示'],
  },
  {
    name: '删除预扫描又把读取失败当成"书签已不存在"（不确定被说成已达成）',
    file: 'src/lib/ai/deletion-executor.ts',
    from: '        throw new Error(\n          `无法确认该书签的状态（读取失败）：${e instanceof Error ? e.message : String(e)}`,\n        );',
    to: '        // reverted',
    expectFail: ['读取失败不得被当作"书签已不存在"而计入删除成功'],
  },
  {
    name: '复制后重命名失败又谎报标题（吞掉失败照样回报请求的标题）',
    file: 'src/lib/ai/tools.ts',
    from: '      renamed = false;\n      note = `副本已创建，但重命名失败（保留原标题）：${e instanceof Error ? e.message : String(e)}`;',
    to: '      renamed = true;\n      reportedTitle = title;',
    expectFail: ['复制后重命名失败时，不得声称副本已用请求的标题'],
  },
  {
    name: '主题保存失败又被静默吞掉（设置没保存却看不出）',
    file: 'src/stores/themeStore.ts',
    from: "      pushToast('主题设置没有保存成功', {",
    to: "      void e; if (false) pushToast('主题设置没有保存成功', {",
    expectFail: ['主题保存失败必须如实告知（不能静默丢弃设置）'],
  },
  {
    name: '批量移动丢掉了部分成功的计数（把"移了 2 项"说成整体失败）',
    file: 'src/lib/bookmarks/bulk.ts',
    from: '  const ok = results.filter((r) => r.status === \'fulfilled\').length;',
    to: '  const ok = results.length;',
    expectFail: ['moveMany：部分失败时仍数出成功项'],
  },
  {
    name: '部分失败又被报成全部成功（describeBulk 少了 failed 分支）',
    file: 'src/lib/bookmarks/bulk.ts',
    from: '  if (o.failed === 0) return { title: `已${action} ${o.ok} 项${where}`, opts: { variant: \'success\' } };',
    to: '  if (true) return { title: `已${action} ${o.ok} 项${where}`, opts: { variant: \'success\' } };',
    expectFail: [
      'describeBulk：部分成功 → destructive 且报出「X 项，Y 项失败」',
      'moveManyWithToast：部分失败时如实报「已移动 X 项，Y 项失败」',
    ],
  },
  {
    name: '打开链接失败又被吞掉（用户点了没反应）',
    file: 'src/lib/open-url.ts',
    from: "    pushToast('无法打开链接', { description: failureMessage(url, e), variant: 'destructive' });",
    to: '    void e;',
    expectFail: ['单个链接打开失败必须给出可见反馈'],
  },
  {
    name: '批量打开又重新无条件报成功（把部分失败说成全部打开）',
    file: 'src/lib/open-url.ts',
    from: '  if (failed === 0) {',
    to: '  if (true) {',
    expectFail: [
      '批量部分失败必须如实报出「X 个成功、Y 个失败」',
      '批量部分失败时不得出现"全部成功"式的 success 提示',
    ],
  },
  {
    name: '恢复时不再查 runId 终态（已消费的点会被残留 pending 复活成新点）',
    file: 'src/lib/undo/recorder.ts',
    from: '  if (state.terminalRunIds.includes(pending.runId)) {',
    to: '  if (false) {',
    expectFail: ['已终结 runId 的残留 pending 不得被提升成新的可执行点'],
  },
  {
    name: '消费点时不记终态（移除与记账不再原子）',
    file: 'src/lib/undo/recorder.ts',
    from: '  const terminal = point ? rememberTerminalRun(state.terminalRunIds, point.runId) : state.terminalRunIds;',
    to: '  const terminal = state.terminalRunIds;',
    expectFail: ['消费成功后，该 runId 被记为持久终态'],
  },
  {
    name: '撤销执行互斥被移除（重叠请求会各自重建一份子树）',
    file: 'src/lib/undo/apply.ts',
    from: '  if (inFlight.has(target.id)) {',
    to: '  if (false) {',
    expectFail: ['同一撤销点正在执行时，重叠的第二次请求必须被立即拒绝'],
  },
  {
    name: '消费写失败重新落进成功提示（把"记录没更新"说成"已撤销"）',
    file: 'src/stores/aiStore.ts',
    from: '      if (!r.ok) {',
    to: '      if (!r.ok && r.restored === 0) {',
    expectFail: ['消费写失败必须如实告警，绝不显示成功'],
  },
  {
    name: '读取撤销记录失败重新被当成"没有记录"（不确定性被说成确定）',
    file: 'src/stores/aiStore.ts',
    from: "      // SW 已回收、消息通道失败等：状态未知。列表可以是空的，但必须带 unknown 标记，\n      // 让面板说\"读取失败\"而不是\"没有可撤销的操作\"。\n      set({ undoPoints: [], undoNotice: null, undoNoticeAt: null, undoUnknown: true });",
    to: '      set({ undoPoints: [], undoNotice: null, undoNoticeAt: null });',
    expectFail: ['读取撤销记录失败时，必须标出"状态未知"而不是清成空的'],
  },
  {
    name: '文件夹逆操作退回递归 removeTree（回放中途失败会毁掉残留内容）',
    file: 'src/lib/undo/apply.ts',
    from: '      await chrome.bookmarks.remove(op.id);\n      return;',
    to: '      await chrome.bookmarks.removeTree(op.id);\n      return;',
    expectFail: ['回放中途失败留下非空文件夹时，绝不递归删除里面的内容'],
  },
  {
    name: '撤销新建文件夹不再预检内容（会递归删除后来移入的数据）',
    file: 'src/lib/undo/apply.ts',
    from: '  const conflicts = await findFolderRemovalConflicts(target);\n  if (conflicts.length > 0) {',
    to: '  const conflicts: FolderRemovalConflict[] = [];\n  if (conflicts.length > 0) {',
    expectFail: ['文件夹里有后来移入的内容时，撤销必须被拒绝'],
  },
  {
    name: '后端不再拒绝非最新撤销点（会跨轮次递归删除后来移入的数据）',
    file: 'src/lib/undo/apply.ts',
    from: '  if (id && target.id !== points[0]?.id) {',
    to: '  if (false) {',
    expectFail: ['非最新撤销点被拒绝且没有任何副作用'],
  },
  {
    name: '替身 remove 重新允许删非空目录（会让「撤销新建文件夹」冲突测试假绿）',
    file: 'tests/agent.test.ts',
    from: '    assert.equal(childrenOf(id).length, 0, `remove: 文件夹 ${id} 非空，应使用 removeTree`);',
    to: '    // reverted (旧的假替身：非空目录也照删)',
    expectFail: ['替身 remove 必须拒绝非空文件夹'],
  },
  {
    name: 'aiStore 重试未排除被重试的 user 消息',
    file: 'src/stores/aiStore.ts',
    from: '    const source = get().messages;\n    const history = (opts?.replaceLastUser ? source.slice(0, -1) : source).slice(-HISTORY_LIMIT);',
    to: '    const history = get().messages.slice(-HISTORY_LIMIT);',
    expectFail: ['重试时历史排除被重试的 user 消息'],
  },
  {
    name: 'themeStore.load 读取失败又被静默吞掉（回落到 system 却不告知）',
    file: 'src/stores/themeStore.ts',
    from: "      pushToast('无法读取主题设置', {",
    to: "      void 0; if (false) pushToast('无法读取主题设置', {",
    expectFail: ['themeStore.load 读取失败时必须给出警告提示（不静默回落）'],
  },
];

let allGood = true;
for (const c of cases) {
  const path = `${REPO}/${c.file}`;
  const orig = readFileSync(path, 'utf8');
  if (!orig.includes(c.from)) {
    console.log(`SKIP   ${c.name}  —— 未找到回滚锚点（源码被重构过？请同步 cases）`);
    allGood = false;
    continue;
  }
  writeFileSync(path, orig.replace(c.from, c.to));
  let red = false;
  let out = '';
  try {
    execSync('npx tsx tests/agent.test.ts', { cwd: REPO, stdio: 'pipe' });
  } catch (e) {
    red = true;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  } finally {
    writeFileSync(path, orig);
  }

  const failed = out
    .split('\n')
    .filter((l) => l.trim().startsWith('✘') || l.includes('  ✘ '))
    .map((l) => l.replace(/.*✘\s*/, '').trim());
  const hit = failed.find((f) => c.expectFail.some((e) => f.startsWith(e)));
  if (red && hit) {
    console.log(`RED ✔  ${c.name}\n         → 失败用例「${hit}」`);
  } else if (red) {
    console.log(`RED? ~  ${c.name}\n         → 变红但失败用例不在预期内：${JSON.stringify(failed.slice(0, 3))}`);
    allGood = false;
  } else {
    console.log(`GREEN ✘  ${c.name}  —— 回滚后仍然全绿：该测试是假绿！`);
    allGood = false;
  }
}

try {
  execSync('npx tsx tests/agent.test.ts', { cwd: REPO, stdio: 'pipe' });
  console.log('\n恢复后全绿 ✔');
} catch {
  console.log('\n恢复后测试未通过 ✘');
  allGood = false;
}
console.log(allGood ? '\n反证完成：每条测试都能被对应回滚证伪 ✔' : '\n反证存在缺口 ✘');
process.exit(allGood ? 0 : 1);
