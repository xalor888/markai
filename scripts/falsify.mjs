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
    from: '  // 已正经收尾：清掉进行中的快照，避免下次启动把它当成"被中断的轮次"重复提升\n  await clearPending();',
    to: '  // reverted',
    expectFail: ['正常收尾后清除 pending'],
  },
  {
    name: '启动时不恢复被中断的轮次',
    file: 'src/lib/undo/recorder.ts',
    from: '  if (!pending || !Array.isArray(pending.ops) || pending.ops.length === 0) return null;',
    to: '  if (true) return null;',
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
    name: '撤销历史不再标出可撤销性（点了才知道撤不了）',
    file: 'src/lib/undo/journal.ts',
    from: '      undoable: ready.undoable,',
    to: '      undoable: true,',
    expectFail: ['撤销历史：不可撤销的点标出来并带原因'],
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
    from: '  await chrome.storage.local.remove(UNDO_STORAGE_KEY);\n}\n\n/** 取出并移除一个撤销点',
    to: '  // reverted\n}\n\n/** 取出并移除一个撤销点',
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
    name: 'release workflow 又发未验证的 Firefox 产物',
    file: '.github/workflows/release.yml',
    from: '      - name: 打包 Chrome zip',
    to: '      - name: 打包 Firefox zip\n        run: npm run zip:firefox\n\n      - name: 打包 Chrome zip',
    expectFail: ['release workflow 不再发布未验证的 Firefox 产物'],
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
    name: 'undoLast 把"拒绝"也报成成功',
    file: 'src/stores/aiStore.ts',
    from: "      if (!r.ok && r.restored === 0) {",
    to: "      if (false) {",
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
    from: '  } finally {\n    await endUndoTransaction();\n  }',
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
    name: 'aiStore 重试未排除被重试的 user 消息',
    file: 'src/stores/aiStore.ts',
    from: '    const source = get().messages;\n    const history = (opts?.replaceLastUser ? source.slice(0, -1) : source).slice(-HISTORY_LIMIT);',
    to: '    const history = get().messages.slice(-HISTORY_LIMIT);',
    expectFail: ['重试时历史排除被重试的 user 消息'],
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
