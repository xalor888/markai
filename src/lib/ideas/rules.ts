/**
 * ── 点子规则引擎（纯函数，无 IO） ──
 *
 * 为什么规则层必须独立于模型：
 *  · 没配 AI 的用户也要有点子——否则"点子"就成了付费功能；
 *  · 模型会编（"有 40 条重复"），规则不会：每条都带真实 sampleIds，用户能点开核对；
 *  · 模型不可用时只少一部分，不会整块空白。
 *
 * 所有 `count` 都是**真实统计**。Chrome 的 `dateLastUsed` 经常缺失，
 * 缺的时候按 `dateAdded` 估算，并且必须在 evidence 里写清"按收藏时间估算"——
 * 把估算说成实测，用户第一次核对就会发现数字不对，之后就不再信任何点子。
 */
import type { Idea, IdeaEvidence, IdeaInput } from '@/lib/features/ideas';
import { analyzeLibrary, normalizeUrlForDup, pickDuplicateKeeper, type LibraryItem } from '@/lib/bookmarks/insights';

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 超过多少个月没打开算"老旧"。12 个月是"一年没碰"，用户凭直觉能判断。 */
export const STALE_MONTHS = 12;
/** 冷却期：同一个点子 7 天内不重复出现，否则每次打开都是同一批，像坏了 */
export const IDEA_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** 单条 evidence 最多带多少个样本 id（卡片不能被撑成列表） */
export const MAX_SAMPLE_IDS = 5;
/** 单域名散落在多少个文件夹以上才算"cluster" */
export const CLUSTER_FOLDER_THRESHOLD = 3;

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** 根级散落：只算根的直接子书签，不含文件夹（文件夹是分类，不是"没分类"） */
function rootLevelBookmarks(roots: BNode[]): { rootTitle: string; items: LibraryItem[] }[] {
  const out: { rootTitle: string; items: LibraryItem[] }[] = [];
  for (const root of roots) {
    const items: LibraryItem[] = [];
    for (const child of root.children ?? []) {
      if (!child.url) continue;
      items.push({
        id: child.id,
        title: child.title || child.url,
        url: child.url,
        path: root.title || '根目录',
        dateAdded: child.dateAdded ?? 0,
      });
    }
    if (items.length > 0) out.push({ rootTitle: root.title || '根目录', items });
  }
  return out;
}

/** 每个 URL 域名落在哪些文件夹（按路径），用于发现"同一站点散落各处" */
function domainFolders(roots: BNode[]): Map<string, { paths: Set<string>; items: LibraryItem[] }> {
  const map = new Map<string, { paths: Set<string>; items: LibraryItem[] }>();
  const walk = (node: BNode, parents: string[]) => {
    if (node.url) {
      let host = '';
      try {
        host = new URL(node.url).hostname.replace(/^www\./, '');
      } catch {
        return;
      }
      if (!host) return;
      const entry = map.get(host) ?? { paths: new Set<string>(), items: [] };
      entry.paths.add(parents.join(' / '));
      entry.items.push({
        id: node.id,
        title: node.title || node.url,
        url: node.url,
        path: parents.join(' / '),
        dateAdded: node.dateAdded ?? 0,
      });
      map.set(host, entry);
      return;
    }
    for (const child of node.children ?? []) walk(child, [...parents, node.title || '文件夹']);
  };
  for (const root of roots) {
    for (const child of root.children ?? []) walk(child, [root.title || '根目录']);
  }
  return map;
}

function evidence(text: string, ids: string[]): IdeaEvidence {
  return { text, sampleIds: ids.slice(0, MAX_SAMPLE_IDS) };
}

function makeIdea(
  partial: Omit<Idea, 'createdAt' | 'source' | 'evidence'> & { evidence: IdeaEvidence[] },
  now: number,
): Idea {
  return { ...partial, createdAt: now, source: 'rule' };
}

/** 老旧：超过 STALE_MONTHS 未使用（缺失时按收藏时间估算） */
function staleIdea(roots: BNode[], now: number): Idea | null {
  const cutoff = now - STALE_MONTHS * MONTH_MS;
  const stale: LibraryItem[] = [];
  let estimated = 0;
  const walk = (node: BNode, parents: string[]) => {
    if (node.url) {
      const lastUsed = node.dateLastUsed;
      const added = node.dateAdded;
      const reference = typeof lastUsed === 'number' && lastUsed > 0 ? lastUsed : added;
      if (typeof reference === 'number' && reference > 0 && reference < cutoff) {
        if (!(typeof lastUsed === 'number' && lastUsed > 0)) estimated++;
        stale.push({
          id: node.id,
          title: node.title || node.url,
          url: node.url,
          path: parents.join(' / '),
          dateAdded: added ?? 0,
        });
      }
      return;
    }
    for (const child of node.children ?? []) walk(child, [...parents, node.title || '文件夹']);
  };
  for (const root of roots) {
    for (const child of root.children ?? []) walk(child, [root.title || '根目录']);
  }
  if (stale.length === 0) return null;
  // 越老越靠前：用户最想先处理的是"两年没碰的"
  stale.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
  const allEstimated = estimated === stale.length;
  const basis = allEstimated
    ? `按收藏时间估算（这些书签没有使用记录）`
    : estimated > 0
      ? `${stale.length} 条中有 ${estimated} 条按收藏时间估算`
      : '按最后使用时间统计';
  return makeIdea(
    {
      id: 'stale',
      kind: 'stale',
      title: `${stale.length} 条书签超过 ${STALE_MONTHS} 个月没打开`,
      body: `它们一直占着位置。${basis}。可以先看一眼，再决定是删除、归档还是留着。`,
      prompt: `帮我检查这 ${stale.length} 条超过 ${STALE_MONTHS} 个月没打开的书签，按域名分组列出来，并给出"删除/保留"的建议。先不要删除，等我确认。`,
      count: stale.length,
      affectsWrites: true,
      effort: 'quick',
      evidence: [evidence(`${basis}；样本：${stale.slice(0, 3).map((i) => i.title).join('、')}`, stale.map((i) => i.id))],
    },
    now,
  );
}

/** 重复：复用 insights 的归一化与保留规则，不另写一套"什么算重复" */
function duplicateIdea(roots: BNode[], now: number): Idea | null {
  const insights = analyzeLibrary(roots, now);
  if (insights.duplicateGroups === 0) return null;
  const sampleIds: string[] = [];
  for (const group of insights.duplicates) {
    for (const item of group.items) {
      if (sampleIds.length >= MAX_SAMPLE_IDS) break;
      sampleIds.push(item.id);
    }
    if (sampleIds.length >= MAX_SAMPLE_IDS) break;
  }
  const keeper = insights.duplicates[0] ? pickDuplicateKeeper(insights.duplicates[0].items, 'oldest') : null;
  return makeIdea(
    {
      id: 'duplicate',
      kind: 'duplicate',
      title: `${insights.duplicateGroups} 组重复链接，多出 ${insights.duplicateExtra} 条`,
      body: keeper
        ? `同一个页面被收藏了多次。建议每组保留最早收藏的那条（例如「${keeper.title}」），其余清理。`
        : '同一个页面被收藏了多次，可以每组保留一条。',
      prompt: `帮我处理重复书签：每组只保留最早收藏的一条，其余加入删除提议。先列出来给我确认，不要直接删。`,
      count: insights.duplicateExtra,
      affectsWrites: true,
      effort: 'quick',
      evidence: [evidence(`共 ${insights.duplicateGroups} 组，涉及 ${insights.duplicateExtra} 条多余副本`, sampleIds)],
    },
    now,
  );
}

/** 空文件夹：analyzeLibrary 已按同一口径统计（根节点不计） */
function emptyFolderIdea(roots: BNode[], now: number): Idea | null {
  const insights = analyzeLibrary(roots, now);
  if (insights.emptyFolders === 0) return null;
  return makeIdea(
    {
      id: 'empty-folder',
      kind: 'empty-folder',
      title: `${insights.emptyFolders} 个空文件夹`,
      body: '整理到一半留下的空壳。删掉能让树短一截，找东西更快。',
      prompt: `帮我清理空文件夹（共 ${insights.emptyFolders} 个）。先列出路径给我确认，不要直接删。`,
      count: insights.emptyFolders,
      affectsWrites: true,
      effort: 'quick',
      evidence: [
        evidence(
          `样本：${insights.emptyFolderList.slice(0, 3).map((f) => f.title).join('、') || '（无标题）'}`,
          insights.emptyFolderList.map((f) => f.id),
        ),
      ],
    },
    now,
  );
}

/** 单域名散落：同一站点分布在多个文件夹，说明分类标准不一致 */
function clusterIdea(roots: BNode[], now: number): Idea | null {
  const byDomain = domainFolders(roots);
  const scattered = [...byDomain.entries()]
    .filter(([, v]) => v.paths.size >= CLUSTER_FOLDER_THRESHOLD)
    .sort((a, b) => b[1].paths.size - a[1].paths.size || b[1].items.length - a[1].items.length);
  if (scattered.length === 0) return null;
  const [domain, data] = scattered[0]!;
  const total = scattered.reduce((sum, [, v]) => sum + v.items.length, 0);
  return makeIdea(
    {
      id: 'cluster',
      kind: 'cluster',
      title: `${scattered.length} 个站点散落在 3 个以上文件夹`,
      body: `最典型的是 ${domain}：${data.items.length} 条分布在 ${data.paths.size} 个文件夹。合并到一个分类里会好找很多。`,
      prompt: `帮我把散落在多个文件夹里的同站点书签收拢：先从 ${domain} 开始（${data.items.length} 条，${data.paths.size} 个文件夹），列出建议的目标文件夹，等我确认再移动。`,
      count: total,
      affectsWrites: true,
      effort: 'medium',
      evidence: [evidence(`${domain} 分布在 ${data.paths.size} 个文件夹`, data.items.map((i) => i.id))],
    },
    now,
  );
}

/**
 * 根级书签：直接躺在根下的书签（没进任何文件夹）。
 *
 * 文案不用"游离"：它们确实属于某个根（书签栏/其他书签/移动设备），
 * 只是没被进一步分类。说成"游离"会让用户以为这些书签不属于任何地方。
 */
function unfiledIdea(roots: BNode[], now: number): Idea | null {
  const groups = rootLevelBookmarks(roots);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  if (total === 0) return null;
  const biggest = [...groups].sort((a, b) => b.items.length - a.items.length)[0]!;
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  return makeIdea(
    {
      id: 'unfiled',
      kind: 'unfiled',
      title: `${total} 条书签直接放在根下`,
      body: `没有归进任何文件夹。最多的是「${biggest.rootTitle}」下的 ${biggest.items.length} 条。分一下类，树会清爽很多。`,
      prompt: `帮我给根级散落的 ${total} 条书签分类：先列出它们，建议几个文件夹名，等我确认后再移动。`,
      count: total,
      affectsWrites: true,
      effort: 'medium',
      evidence: [evidence(`「${biggest.rootTitle}」下有 ${biggest.items.length} 条直接子书签`, ids)],
    },
    now,
  );
}

/**
 * 生成规则点子。
 *
 * 排序：quick 在前，其次按 count 降序，同分按 id 稳定排序。
 * 为什么 quick 优先：用户点开"点子"是想马上做点什么，
 * 一个"需要深度整理 3000 条"的大工程放在最上面，只会让人关掉面板。
 */
export function generateRuleIdeas(input: IdeaInput, now: number = Date.now()): Idea[] {
  const candidates = [
    duplicateIdea(input.roots, now),
    emptyFolderIdea(input.roots, now),
    staleIdea(input.roots, now),
    clusterIdea(input.roots, now),
    unfiledIdea(input.roots, now),
  ].filter((idea): idea is Idea => idea !== null);

  const seen = new Set(input.seenIds);
  const fresh = candidates.filter((idea) => !seen.has(idea.id));

  const effortRank = { quick: 0, medium: 1, deep: 2 } as const;
  return fresh.sort((a, b) => {
    const byEffort = effortRank[a.effort] - effortRank[b.effort];
    if (byEffort !== 0) return byEffort;
    const byCount = (b.count ?? 0) - (a.count ?? 0);
    if (byCount !== 0) return byCount;
    return a.id.localeCompare(b.id, 'en');
  });
}

/** 供 UI 判断"库很干净"：规则层一条都没有 */
export function libraryLooksClean(roots: BNode[], now: number = Date.now()): boolean {
  const insights = analyzeLibrary(roots, now);
  return (
    insights.duplicateGroups === 0 &&
    insights.emptyFolders === 0 &&
    rootLevelBookmarks(roots).reduce((sum, g) => sum + g.items.length, 0) === 0 &&
    staleIdea(roots, now) === null
  );
}

/** 冷却表：按 id 记录"最近一次被忽略/展示"的时间，过期即失效 */
export interface SeenRecord {
  id: string;
  at: number;
}

export const IDEAS_SEEN_KEY = 'markai.ideas.seen';
/** 冷却表上限：再大也只是历史垃圾，200 条足够覆盖所有规则 + 模型点子 */
export const SEEN_LIMIT = 200;

/**
 * 清洗冷却表：丢弃过期项、去重（保留最新）、按时间倒序截断。
 * 纯函数，storage 里可能是旧版本写的任意形状。
 */
export function pruneSeen(raw: unknown, now: number = Date.now()): SeenRecord[] {
  if (!Array.isArray(raw)) return [];
  const latest = new Map<string, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : '';
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0;
    if (!id || at <= 0) continue;
    if (now - at > IDEA_COOLDOWN_MS) continue;
    if (!latest.has(id) || at > latest.get(id)!) latest.set(id, at);
  }
  return [...latest.entries()]
    .map(([id, at]) => ({ id, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, SEEN_LIMIT);
}

/** 从冷却表取出仍在冷却期内的 id */
export function activeSeenIds(records: SeenRecord[]): string[] {
  return records.map((r) => r.id);
}
