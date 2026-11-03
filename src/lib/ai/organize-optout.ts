/**
 * ── 自动整理的「站点免打扰」名单 ──
 *
 * 为什么需要：用户在整理记录里点「↶ 撤销」，表达的是一句明确的话——「这个站点这么归类，我不认」。
 * 如果下一次收藏同一个站点时系统又照原样搬一遍，那不是自动，是没记性。
 *
 * 规则：
 *  - 撤销某次自动整理 → 该**注册域**进入名单，之后新书签不再自动整理（仍可手动「补整理」）；
 *  - 名单可一键清空（用户改主意时不该被永久困住）；
 *  - 只按注册域记忆，不按具体 URL——用户反对的是「这个站点的归类」，不是某一条。
 */

export const ORGANIZE_OPTOUT_KEY = 'markai.organize.optout';
/**
 * 名单上限。
 *
 * 从 100 提到 1000：100 条时**静默挤出最旧一条**，而这条名单记的是用户明确说过
 * 「这个站点别自动整理」。一个重度用户撤销 100 次之后，最早那条指令就悄悄失效了——
 * 那个站点又会被自动搬，而用户以为自己说过的话一直算数。
 * 模块文档写的规则是无条件的：「之后新书签不再自动整理」，上限不能把它变成假的。
 *
 * 1000 条 × 约 60 字节 ≈ 60 KB，相对 10 MB 配额可以忽略；而现实中
 * 一个用户撤销过的注册域数量远到不了这个量级，所以它实际上不可达，
 * 同时仍然给存储留了一道硬边界。
 */
export const ORGANIZE_OPTOUT_LIMIT = 1000;

export interface OptOutEntry {
  domain: string;
  at: number;
}

/** 读名单（容忍脏数据：只认带 domain 字符串的项） */
export async function readOptOutDomains(): Promise<OptOutEntry[]> {
  try {
    const data = await chrome.storage.local.get(ORGANIZE_OPTOUT_KEY);
    const raw = Array.isArray(data[ORGANIZE_OPTOUT_KEY]) ? (data[ORGANIZE_OPTOUT_KEY] as unknown[]) : [];
    return raw
      .filter((e): e is OptOutEntry => {
        if (!e || typeof e !== 'object') return false;
        const o = e as Partial<OptOutEntry>;
        return typeof o.domain === 'string' && o.domain.length > 0;
      })
      .map((e) => ({ domain: e.domain.toLowerCase(), at: typeof e.at === 'number' ? e.at : 0 }))
      .sort((a, b) => b.at - a.at)
      .slice(0, ORGANIZE_OPTOUT_LIMIT);
  } catch {
    return [];
  }
}

/** 该注册域是否已被用户「叫停」 */
export async function isOrganizeOptedOut(domain: string): Promise<boolean> {
  if (!domain) return false;
  const list = await readOptOutDomains();
  const target = domain.toLowerCase();
  return list.some((e) => e.domain === target);
}

/**
 * 把某个注册域加入免打扰（重复添加只更新时间，不产生重复项）。
 *
 * 返回被挤出去的那条（若有）：调用方必须把它告诉用户。
 * 静默丢弃一条「用户明确要求别再自动整理」的记录，比不记更糟——
 * 用户会以为自己的话一直算数（0.2.123）。
 */
export async function addOptOutDomain(
  domain: string,
  now: number = Date.now(),
): Promise<{ evicted?: OptOutEntry }> {
  const target = (domain || '').trim().toLowerCase();
  if (!target) return {};
  try {
    const list = await readOptOutDomains();
    const merged = [{ domain: target, at: now }, ...list.filter((e) => e.domain !== target)];
    const next = merged.slice(0, ORGANIZE_OPTOUT_LIMIT);
    const evicted = merged.length > next.length ? merged[next.length] : undefined;
    await chrome.storage.local.set({ [ORGANIZE_OPTOUT_KEY]: next });
    return evicted ? { evicted } : {};
  } catch {
    // 写不进去不该影响「撤销」本身已经完成的事实
    return {};
  }
}

/** 恢复单个站点（用户只想让这一个站点重新自动整理） */
export async function removeOptOutDomain(domain: string): Promise<void> {
  const target = (domain || '').trim().toLowerCase();
  if (!target) return;
  try {
    const list = await readOptOutDomains();
    await chrome.storage.local.set({ [ORGANIZE_OPTOUT_KEY]: list.filter((e) => e.domain !== target) });
  } catch {
    /* 忽略：下次读到的仍是旧名单，用户可再试 */
  }
}

/** 清空名单（用户改主意） */
export async function clearOptOutDomains(): Promise<void> {
  try {
    await chrome.storage.local.remove(ORGANIZE_OPTOUT_KEY);
  } catch {
    /* 忽略 */
  }
}
