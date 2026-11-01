import { parseCustomHeaders } from '@/lib/ai/request-headers';
import { isUsableUndoPoint } from '@/lib/undo/validate';
import {
  SEVERITY_ORDER,
  type HealthReport,
  type HealthSnapshot,
  type Issue,
  type IssueSeverity,
} from '@/lib/health/types';

/**
 * ── 诊断引擎（纯函数） ──
 *
 * 输入只读快照，输出一组有证据的 Issue。**不碰 chrome、不发网络请求、不写任何东西。**
 * 这样它才能在单测里被穷举，而不是靠 mock 猜浏览器行为。
 *
 * 每条检查都遵守同一个写法：
 *   有证据（数字/值）→ 判断 → 给出「1 个动作」就能解决的路。
 * 不写"可能有问题"这种没法行动的结论。
 */

/** 严重度扣分：够高才值得在红点上冒头，够低就不打扰 */
const PENALTY: Record<IssueSeverity, number> = { critical: 40, high: 18, medium: 8, low: 3 };

/** 上限：再多也就扣到 0，不出现负分 */
const scoreOf = (issues: Issue[]): number =>
  Math.max(0, Math.min(100, 100 - issues.reduce((n, i) => n + PENALTY[i.severity], 0)));

/** 合法的 http(s) URL 判断（不引用 DOM URL，诊断要在 SW 里也能跑） */
function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** 撤销点数据是否是一个"看起来正常"的数组 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 整理记录条目结构校验 */
function isUsableLogEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.at === 'number' && typeof e.title === 'string';
}

export const MAX_LOG_ENTRIES = 200;
export const MAX_UNDO_POINTS = 10;
/** 存储用量告警线：Chrome 的 local 配额是 10MB（unlimitedStorage 未申请时） */
const STORAGE_WARN_BYTES = 8 * 1024 * 1024;

/**
 * 跑一遍全部检查。
 *
 * 顺序固定（同一份快照永远得到同一个顺序），展示时再按严重度排——
 * 这样"每次刷新顺序乱跳"不会发生，测试也能钉住。
 */
export function diagnose(snapshot: HealthSnapshot): HealthReport {
  const issues: Issue[] = [];

  /* ── 配置 ── */
  if (snapshot.configError) {
    issues.push({
      id: 'config.unreadable',
      area: 'config',
      severity: 'critical',
      title: '读不到配置',
      detail: snapshot.configError,
      manualHint: '在设置页重新填一次服务商与 API Key。若反复失败，导出诊断报告后反馈。',
    });
  }

  const cfg = snapshot.config;
  if (cfg) {
    const missing: string[] = [];
    if (!cfg.baseUrl?.trim()) missing.push('Base URL');
    if (!cfg.model?.trim()) missing.push('模型');
    if (snapshot.providerNeedsKey && !cfg.apiKey?.trim()) missing.push('API Key');
    if (missing.length > 0) {
      issues.push({
        id: 'config.incomplete',
        area: 'config',
        severity: 'high',
        title: 'AI 服务还没配完',
        detail: `缺少：${missing.join(' / ')}。在此之前，自动整理只会用本地规则，对话功能会直接失败。`,
        fix: { action: 'config.fill-defaults', label: '填入该服务商的默认值' },
        manualHint: missing.includes('API Key')
          ? '到服务商后台复制一个 Key 填进来。'
          : '在设置页把这两项补齐即可。',
      });
    }

    if (cfg.baseUrl?.trim() && !isHttpUrl(cfg.baseUrl.trim())) {
      issues.push({
        id: 'config.invalid-baseurl',
        area: 'config',
        severity: 'high',
        title: 'Base URL 不像一个地址',
        detail: `当前值：${cfg.baseUrl.trim().slice(0, 80)}`,
        fix: { action: 'config.normalize-baseurl', label: '修正为合法地址' },
      });
    }

    // 自定义请求头写错时，请求会带上错误的头（或整条被拒），
    // 但界面上只表现为"AI 没反应"——这是最难自查的一类。
    const headers = parseCustomHeaders(cfg.customHeaders ?? '');
    if (headers.errors.length > 0) {
      issues.push({
        id: 'config.bad-headers',
        area: 'config',
        severity: 'medium',
        title: '自定义请求头有写错的行',
        detail: headers.errors.slice(0, 3).join('；'),
        count: headers.errors.length,
        fix: { action: 'config.drop-bad-headers', label: '删掉写错的行' },
        manualHint: '格式是每行一条 `Name: Value`，空行与 # 开头的行会被忽略。',
      });
    }
  }

  /* ── 权限 ── */
  {
    const need = [
      { key: 'bookmarks', label: '书签读写' },
      { key: 'storage', label: '本地存储' },
      { key: 'sidePanel', label: '侧边栏' },
    ];
    const missing = need.filter((n) => !snapshot.permissions.includes(n.key));
    if (missing.length > 0) {
      issues.push({
        id: 'permission.missing',
        area: 'permission',
        severity: 'critical',
        title: '缺少必要权限',
        detail: `缺少：${missing.map((m) => m.label).join(' / ')}。缺权限时相关功能会静默失效。`,
        manualHint: '在 chrome://extensions 里重新加载扩展；若仍缺少，卸载后重装。',
      });
    }
  }

  /* ── 撤销点 ── */
  {
    const raw = asArray(snapshot.undoPoints);
    const usable = raw.filter(isUsableUndoPoint);
    const corrupt = raw.length - usable.length;
    if (corrupt > 0) {
      issues.push({
        id: 'undo.corrupt',
        area: 'undo',
        severity: 'high',
        title: `${corrupt} 个撤销点已损坏`,
        detail: '结构不完整，点「撤销」会失败或什么都撤不回。',
        count: corrupt,
        fix: { action: 'undo.drop-corrupt', label: '清理损坏的撤销点' },
        manualHint: '清理只删坏掉的那几条，正常的撤销记录一条不动。',
      });
    }
    if (usable.length > MAX_UNDO_POINTS) {
      issues.push({
        id: 'undo.overflow',
        area: 'undo',
        severity: 'medium',
        title: `撤销点超出保留上限（${usable.length}/${MAX_UNDO_POINTS}）`,
        detail: '超出的部分会被截断，更早的整理将无法回退。',
        count: usable.length - MAX_UNDO_POINTS,
        fix: { action: 'undo.trim-overflow', label: `保留最近 ${MAX_UNDO_POINTS} 个` },
      });
    }
  }

  /* ── 整理记录 ── */
  {
    const raw = asArray(snapshot.logEntries);
    const usable = raw.filter(isUsableLogEntry) as { id: string; runId?: string; undoneAt?: number }[];
    const corrupt = raw.length - usable.length;
    if (corrupt > 0) {
      issues.push({
        id: 'log.corrupt',
        area: 'log',
        severity: 'low',
        title: `${corrupt} 条整理记录格式异常`,
        detail: '这些记录不会显示在面板里，也不影响书签本身。',
        count: corrupt,
        fix: { action: 'log.trim-limit', label: '清理异常记录' },
      });
    }
    if (raw.length > MAX_LOG_ENTRIES) {
      issues.push({
        id: 'log.overflow',
        area: 'log',
        severity: 'low',
        title: `整理记录超出上限（${raw.length}/${MAX_LOG_ENTRIES}）`,
        detail: '更早的记录已被挤掉。',
        count: raw.length - MAX_LOG_ENTRIES,
        fix: { action: 'log.trim-limit', label: `保留最近 ${MAX_LOG_ENTRIES} 条` },
      });
    }
    // 记录指向的撤销点已经不在：撤销按钮会变成"点了没反应"
    const undoIds = new Set(
      asArray(snapshot.undoPoints)
        .filter(isUsableUndoPoint)
        .map((p) => (p as { runId: string }).runId),
    );
    const orphan = usable.filter((e) => e.runId && !undoIds.has(e.runId) && !e.undoneAt);
    if (orphan.length > 0) {
      issues.push({
        id: 'log.orphan',
        area: 'log',
        severity: 'medium',
        title: `${orphan.length} 条记录已经无法撤销`,
        detail: '它们对应的撤销点已被上限挤掉。标记之后，面板上不会再显示一个点了没用的「撤销」。',
        count: orphan.length,
        fix: { action: 'log.mark-orphan', label: '标记为不可撤销' },
      });
    }
  }

  /* ── 书签数据（只报告，不动） ── */
  const bm = snapshot.bookmarks;
  if (bm) {
    if (bm.orphaned > 0) {
      issues.push({
        id: 'bookmarks.orphaned',
        area: 'bookmarks',
        severity: 'high',
        title: `${bm.orphaned} 个书签找不到父文件夹`,
        detail: '它们不会出现在任何树里，但仍占着数据库。通常是别的工具异常写入留下的。',
        count: bm.orphaned,
        manualHint: '这类数据需要你自己确认后再处理；MarkAI 不会替你删书签。',
      });
    }
    if (bm.duplicateNameGroups > 0) {
      issues.push({
        id: 'bookmarks.duplicate-folders',
        area: 'bookmarks',
        severity: 'medium',
        title: `${bm.duplicateNameGroups} 组同名文件夹`,
        detail: '同一个父目录下有同名文件夹，归类时容易选错那个。',
        count: bm.duplicateNameGroups,
        manualHint: '在书签树里手动合并。MarkAI 不会自动合并——那会动到你的结构。',
      });
    }
    if (bm.maxDepth > 8) {
      issues.push({
        id: 'bookmarks.too-deep',
        area: 'bookmarks',
        severity: 'low',
        title: `文件夹嵌套过深（${bm.maxDepth} 层）`,
        detail: '超过 8 层后，自动整理会认为那是你精心搭的结构，不再碰它。',
        manualHint: '如果这是有意的，可以忽略这条。',
      });
    }
    if (bm.folders > 0 && bm.emptyFolders / bm.folders > 0.5) {
      issues.push({
        id: 'bookmarks.many-empty',
        area: 'bookmarks',
        severity: 'low',
        title: `${bm.emptyFolders} 个空文件夹`,
        detail: `占全部 ${bm.folders} 个文件夹的一半以上，浏览时噪音较大。`,
        count: bm.emptyFolders,
        manualHint: '可以在树里右键删除。MarkAI 不会自动删空文件夹。',
      });
    }
  }

  /* ── 存储 ── */
  if (snapshot.storageBytes !== null && snapshot.storageBytes > STORAGE_WARN_BYTES) {
    const mb = (snapshot.storageBytes / 1024 / 1024).toFixed(1);
    issues.push({
      id: 'storage.near-quota',
      area: 'storage',
      severity: 'medium',
      title: `本地存储已用 ${mb} MB`,
      detail: '接近 10 MB 配额，超出后写入会失败（配置可能存不下来）。',
      fix: { action: 'log.trim-limit', label: '清理最占空间的整理记录' },
      manualHint: '也可以在设置页清空对话历史与整理记录。',
    });
  }

  /* ── AI 运行时 ── */
  if (snapshot.lastAiError) {
    issues.push({
      id: 'ai.last-error',
      area: 'ai',
      severity: 'medium',
      title: '最近一次 AI 调用失败',
      detail: snapshot.lastAiError.slice(0, 200),
      manualHint: '在设置页点「测试连接」看具体报错；过期/额度不足是最常见原因。',
    });
  }

  /* ── 运行时 ── */
  if (snapshot.crashCount > 0) {
    issues.push({
      id: 'runtime.crashed',
      area: 'runtime',
      severity: 'high',
      title: `后台异常退出 ${snapshot.crashCount} 次`,
      detail: '后台脚本被浏览器回收或崩溃时会留下这条标记；自动整理在重启后仍会继续。',
      count: snapshot.crashCount,
      fix: { action: 'runtime.clear-crash-mark', label: '清除这个标记' },
      manualHint: '如果反复出现，导出一份诊断报告反馈。',
    });
  }

  // 展示顺序：先按严重度，再按 area（保证确定性）
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));

  return { score: scoreOf(issues), issues, checkedAt: Date.now() };
}

/**
 * 生成可复制的诊断文本。
 *
 * 这一条是为了解决"用户说不清哪里错"：红色感叹号对面是一串英文栈，
 * 让用户描述它是不现实的。把环境 + 结论压成一段纯文本，贴过来就能定位。
 */
export function formatDiagnosticReport(report: HealthReport, env: { version: string; browser: string }): string {
  const lines: string[] = [];
  lines.push(`MarkAI 诊断报告`);
  lines.push(`版本 ${env.version} · ${env.browser}`);
  lines.push(`时间 ${new Date(report.checkedAt).toISOString()}`);
  lines.push(`健康分 ${report.score}/100 · ${report.issues.length} 个问题`);
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('没有发现问题。');
  } else {
    for (const i of report.issues) {
      lines.push(`[${i.severity}] ${i.id} — ${i.title}`);
      lines.push(`  ${i.detail}`);
      if (i.manualHint) lines.push(`  建议：${i.manualHint}`);
    }
  }
  return lines.join('\n');
}
