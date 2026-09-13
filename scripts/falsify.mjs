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
    name: 'appVersion 变成写死的常量',
    file: 'src/lib/version.ts',
    from: '    return chrome.runtime.getManifest().version;',
    to: "    return '0.2.2';",
    expectFail: ['appVersion 跟随清单变化（不是写死的常量）'],
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
    from: "      set({ undoPoints: res?.type === 'undo:list:result' ? res.points : [] });",
    to: "      set({ undoPoints: [] });",
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
    from: '  markDelete();\n  recordOp({ kind: \'delete\', id, title });',
    to: '  recordOp({ kind: \'delete\', id, title });',
    expectFail: ['含删除的轮次拒绝撤销并说明原因'],
  },
  {
    name: 'undoReadiness 忽略 containsDelete（会做半撤销）',
    file: 'src/lib/undo/journal.ts',
    from: '  if (point.containsDelete) {',
    to: '  if (false) {',
    expectFail: ['undoReadiness：含删除的轮次明确拒绝并给出原因', '含删除的轮次拒绝撤销并说明原因'],
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
