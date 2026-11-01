/**
 * ── 新书签自动整理的「本地规则」层（纯函数，无 chrome 依赖） ──
 *
 * 为什么需要这一层：
 *  原来的兜底只有「按注册域建 `自动整理/<domain>`」。AI 未配置时，用户收藏十个站点
 *  就会得到十个单域名文件夹；而用户其实早就有「开发」「设计」「影音」这类自己的分类。
 *  本地规则的作用是**先认人**：能高置信度匹配到用户已有分类时，直接放进去；
 *  匹配不上才退回域名兜底，把 AI 调用留给真正模糊的情况。
 *
 * 设计原则（宁可不做，也不乱放）：
 *  - 只采纳**高置信度**匹配：站点品牌名精确/包含出现在文件夹名里，或站点语义分类名
 *    精确/包含出现在文件夹名里；
 *  - 只在同一根目录、深度 1..3 的文件夹里找（用户把分类搭到 4 层以上时不插手）；
 *  - 同分取更浅、id 更小的，保证**确定性**（同一输入永远同一结果，可单测、可解释）；
 *  - 每条结论都带一句人话原因，用于 toast / 日志（用户要能看到「为什么放这里」）。
 */

import type { FolderOption } from '@/lib/ai/auto-organize';
import { registrableDomain } from '@/lib/bookmarks/domain';

/**
 * 常见站点的语义分类（中文短词）。
 * 只在「用户已有同名/含该词的文件夹」时使用，**不会**凭这张表新建文件夹——
 * 否则未配置 AI 的用户会突然多出一堆「开发工具」「影音娱乐」。
 *
 * key 可以是**完整主机名**（`news.ycombinator.com`、`music.163.com`）也可以是**注册域**。
 * 查表顺序是「完整主机名 → 注册域」：像 `news.ycombinator.com` 这种只对子域成立的分类，
 * 用注册域去查永远查不到（`ycombinator.com` 不等于它），那条配置就会变成死数据。
 */
export const SITE_CATEGORY: Record<string, string> = {
  // 代码 / 开发
  'github.com': '开发',
  'gitlab.com': '开发',
  'gitee.com': '开发',
  'bitbucket.org': '开发',
  'stackoverflow.com': '开发',
  'developer.mozilla.org': '开发',
  'npmjs.com': '开发',
  'pypi.org': '开发',
  'crates.io': '开发',
  'nuget.org': '开发',
  'vercel.com': '开发',
  'netlify.com': '开发',
  'cloudflare.com': '开发',
  'docker.com': '开发',
  // 设计
  'figma.com': '设计',
  'dribbble.com': '设计',
  'behance.net': '设计',
  'refactoringui.com': '设计',
  'tailwindcss.com': '设计',
  'radix-ui.com': '设计',
  'framer.com': '设计',
  // 学习 / 文档
  'wikipedia.org': '学习',
  'coursera.org': '学习',
  'udemy.com': '学习',
  'zhihu.com': '学习',
  'juejin.cn': '学习',
  'segmentfault.com': '学习',
  'readthedocs.io': '学习',
  // 资讯 / 阅读
  'news.ycombinator.com': '阅读',
  'medium.com': '阅读',
  'substack.com': '阅读',
  'sspai.com': '阅读',
  '36kr.com': '阅读',
  'nytimes.com': '阅读',
  'theguardian.com': '阅读',
  // 影音
  'youtube.com': '影音',
  'bilibili.com': '影音',
  'netflix.com': '影音',
  'spotify.com': '影音',
  'music.163.com': '影音',
  'vimeo.com': '影音',
  // 购物
  'taobao.com': '购物',
  'tmall.com': '购物',
  'jd.com': '购物',
  'amazon.com': '购物',
  'pinduoduo.com': '购物',
  // 工具 / 效率
  'notion.so': '工具',
  'trello.com': '工具',
  'linear.app': '工具',
  'slack.com': '工具',
  'airtable.com': '工具',
  'excalidraw.com': '工具',
  // 社交
  'twitter.com': '社交',
  'x.com': '社交',
  'weibo.com': '社交',
  'reddit.com': '社交',
  'discord.com': '社交',
  't.me': '社交',
};

/** 站点品牌名：`docs.github.com` → `github`（先去子域与 TLD，再取注册域首段） */
export function brandOf(domain: string): string {
  if (!domain) return '';
  const host = domain.replace(/^\[|\]$/g, '');
  // IP 直连没有品牌名（192.168.1.10 不该被当作"品牌"去匹配）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return '';
  // 统一走注册域规则：docs.github.com 与 github.com 必须得到同一个品牌
  const reg = registrableDomain(`https://${host}`) ?? host;
  const parts = reg.toLowerCase().split('.').filter(Boolean);
  if (parts.length === 0) return '';
  const brand = (parts[0] || '').replace(/[^a-z0-9]/g, '');
  // `www` / `m` 这类没有信息量的前缀不作为品牌
  return brand === 'www' || brand === 'm' ? '' : brand;
}

/** 归一化文件夹名用于比较：小写、去空白与常见分隔符 */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s\-_·・|/\\]+/g, '');
}

export interface LocalMatch {
  folder: FolderOption;
  /** 0-100，越高越确信 */
  score: number;
  /** 给用户看的一句话原因 */
  reason: string;
}

/**
 * 在用户已有文件夹里挑一个最合适的（本地、确定性、可解释）。
 *
 * 打分（只认高置信度）：
 *   100  文件夹名精确等于站点品牌（`GitHub` ← github.com）
 *    80  文件夹名包含站点品牌（`我的 GitHub 收藏` / `GitHub·前端`）
 *    70  文件夹名精确等于语义分类（`开发` ← github.com）
 *    60  文件夹名包含语义分类（`前端开发` / `开发资料`）
 * 低于 60 一律不采纳（宁可走域名兜底，也不把书签塞进一个只是"有点像"的文件夹）。
 */
export function pickExistingFolder(opts: {
  domain: string;
  /**
   * 完整主机名（可选）。只有「仅对子域成立」的分类条目需要它——
   * 例如 `news.ycombinator.com` 的注册域是 `ycombinator.com`，用注册域查表永远命不中。
   * 不传时退化为只查注册域（旧行为，保持向后兼容）。
   */
  host?: string;
  folders: FolderOption[];
  /** 只在这个父级下找；传 rootId 表示整根目录范围 */
  rootId: string;
  /** 最多匹配到第几层（含）；默认 3，用户搭得更深的分类不碰 */
  maxDepth?: number;
}): LocalMatch | null {
  const { domain, folders, rootId } = opts;
  const maxDepth = opts.maxDepth ?? 3;
  const brand = brandOf(domain);
  const hostKey = (opts.host ?? '').trim().toLowerCase();
  // 先完整主机名、再注册域：两条配置都写了时，更具体的那条优先
  const category = (hostKey ? SITE_CATEGORY[hostKey] : undefined) ?? SITE_CATEGORY[domain] ?? '';
  if (!brand && !category) return null;

  const candidates = folders.filter(
    (f) => f.id !== rootId && f.depth >= 1 && f.depth <= maxDepth && f.id !== f.parentId,
  );
  if (candidates.length === 0) return null;

  let best: LocalMatch | null = null;
  for (const folder of candidates) {
    const name = normalizeName(folder.title);
    if (!name) continue;
    let score = 0;
    let reason = '';
    const brandNorm = normalizeName(brand);
    const catNorm = normalizeName(category);

    if (brandNorm && name === brandNorm) {
      score = 100;
      reason = `已有「${folder.title}」文件夹，与站点 ${brand} 同名`;
    } else if (brandNorm && brandNorm.length >= 4 && name.includes(brandNorm)) {
      // 品牌名太短（<4，如 `x`、`go`）时包含匹配误伤太大：`x.com` 会命中「Excel 笔记」
      score = 80;
      reason = `已有「${folder.title}」文件夹包含站点名 ${brand}`;
    } else if (catNorm && name === catNorm) {
      score = 70;
      reason = `已有「${folder.title}」分类，站点属于${category}`;
    } else if (catNorm && catNorm.length >= 2 && name.includes(catNorm)) {
      score = 60;
      reason = `已有「${folder.title}」分类与站点类别（${category}）相符`;
    }

    if (score === 0) continue;
    // 同分：更浅的优先，再按 id 自然序，保证确定性
    if (
      !best ||
      score > best.score ||
      (score === best.score && (folder.depth < best.folder.depth || (folder.depth === best.folder.depth && folder.id.localeCompare(best.folder.id, 'en', { numeric: true }) < 0)))
    ) {
      best = { folder, score, reason };
    }
  }
  return best;
}

/**
 * 本地规则是否「足够确信，不必再问模型」。
 *
 * 阈值定在 90，也就是**只有品牌精确匹配（100 分）算数**。
 * 分类精确匹配（70 分）不在此列：它的误伤面明显更大（`开发` 能同时吃下 github、npm、docker，
 * 用户对某个站点未必是这么想的），所以仍然交给模型确认；
 * 只有模型不可用时（②.5 兜底）才按 60 分以上采纳。
 */
export function isConfidentMatch(match: LocalMatch | null): boolean {
  return !!match && match.score >= 90;
}
