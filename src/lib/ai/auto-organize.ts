/**
 * ── 新书签自动整理（后台执行；决策部分为纯函数，可单测） ──
 *
 * 目标：用户/浏览器新建书签后，不需要手动点「整理」，系统自动把它归位。
 *
 * 策略（先便宜后聪明）：
 *  1. AI 已配置 → 让模型在**同一根目录下的现有文件夹**里选一个；没有合适的就起一个新分类名；
 *  2. AI 未配置 / 调用失败 / 回复不可解析 → 按注册域归类到「自动整理 / <domain>」；
 *  3. 已有同名站点文件夹时直接复用，不重复建。
 *
 * 安全边界：
 *  - 只处理 http/https 书签；文件夹、chrome:// 等不碰；
 *  - Agent 轮次进行中不插手（background 侧先判断），避免和模型自己的整理互相打架；
 *  - 只在自己的事务里移动/新建，因此**可撤销**；
 *  - 已经在同名站点文件夹里的书签不再搬动（幂等）。
 */

import { CONFIG_STORAGE_KEY } from '@/stores/configStore';
import { getPreset, resolveConfig } from '@/lib/providers';
import { registrableDomain } from '@/lib/bookmarks/domain';
import { jCreate, jMove } from '@/lib/undo/mutations';
import { beginUndoTransaction, endUndoTransaction, isRecording } from '@/lib/undo/recorder';
import { chatCompletion } from '@/lib/ai/client';
import { isConfidentMatch, pickExistingFolder } from '@/lib/ai/organize-rules';
import { isOrganizeOptedOut } from '@/lib/ai/organize-optout';
import type { AIConfig } from '@/lib/ai/types';

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 兜底分类容器名（固定值，便于复用与用户识别） */
export const AUTO_CONTAINER = '自动整理';

export interface FolderOption {
  id: string;
  /** 完整路径（含根），用于给模型判断语义 */
  path: string;
  title: string;
  depth: number;
  parentId?: string;
}

/**
 * 批量整理的复用上下文。
 *
 * 为什么需要：每次整理都要 `getTree()`（1 万条书签约 **223ms**）来找根目录并收集候选文件夹。
 * 逐条调用 = 每条一次全树序列化 → 1 万条要 6~7 分钟，且规模越大越慢（本质 O(n²)）。
 * 批量场景下把「根目录 + 候选文件夹」提出来复用，把全树操作从「每条一次」降到「每批一次」。
 *
 * 缓存必须随创建更新（见下面 `rememberFolder`），否则同一批里新建的文件夹在后续条目眼里不存在，
 * 会把同一个分类建成两份。
 */
export interface OrganizeContext {
  rootId: string;
  folders: FolderOption[];
  /**
   * 父目录顺序缓存（`parentId → 子项 id 顺序`）。
   *
   * 批量移动时每条都要知道「移动前在旧父目录里的下标」（撤销要靠它）。
   * 若每条都去 `getChildren` 再 findIndex，1 万条规模下是 O(n²)（实测 402 秒）。
   * 这里由调用方维护一份本地顺序：首次 `getChildren` 一次，之后每条移动后本地同步删除。
   */
  order?: Map<string, string[]>;
}

export interface AutoOrganizeResult {
  ok: boolean;
  action: 'moved' | 'created' | 'skipped' | 'failed';
  /** 一句话结果（用于 toast / 日志） */
  detail: string;
  /** 成功时落到的文件夹名（用于「它去哪了」和日志回看） */
  target?: string;
  /** 本次整理产生的撤销点 runId（用户不满意时一步撤回） */
  runId?: string;
  /**
   * 本次是否「问过模型但失败/超时」。
   * 调用方据此累计连续失败——用户配了个坏 Key 时，不该让他每收藏一次都白等 12 秒。
   */
  aiFailed?: boolean;
  /**
   * 这次归类是**谁下的结论**（用户能据此判断 AI 到底用了多频繁）：
   *  - `local`    本地规则高置信度直接采纳（不发请求）
   *  - `model`    问过模型并采纳了它的结论
   *  - `fallback` 模型没给出可用结论（未配置/超时/答非所问），退回本地规则或域名兜底
   */
  via?: 'local' | 'model' | 'fallback';
}

/* ────────────────────── 纯决策部分（无 chrome 依赖，可单测） ────────────────────── */

/** 收集某根目录下的全部文件夹（含根自身），限制深度与条数，避免把整库塞给模型 */
export function collectFolderOptions(root: BNode, maxDepth = 4, maxItems = 200): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (node: BNode, parents: string[], depth: number) => {
    if (out.length >= maxItems) return;
    const title = (node.title || '').trim() || (depth === 0 ? '根目录' : '(未命名)');
    const path = [...parents, title].join(' / ');
    out.push({ id: node.id, path, title, depth, ...(node.parentId ? { parentId: node.parentId } : {}) });
    if (depth >= maxDepth) return;
    for (const child of node.children ?? []) {
      if (child.url) continue;
      walk(child, [...parents, title], depth + 1);
      if (out.length >= maxItems) return;
    }
  };
  walk(root, [], 0);
  return out;
}

/**
 * 文件夹名的比较基准：去掉全部空白、转小写。
 *
 * 为什么不能直接 `===`：用户手建的「设计资料 」多一个尾空格、AI 回的「AI 工具」与已有的「AI工具」
 * 差一个空格、英文分类名大小写不一致——都会让「复用已有文件夹」失效，于是自动整理造出
 * 两个看着一模一样的文件夹。用户看到的是「它给我建了个重复的」。
 */
function foldFolderName(name: string): string {
  return (name || '').replace(/\s+/g, '').toLowerCase();
}

/** 在候选里找「标题与域名相同」的文件夹（幂等复用的关键）；同名的取最浅、id 最小 */
export function findDomainFolder(folders: FolderOption[], domain: string, parentId?: string): FolderOption | null {
  const target = foldFolderName(domain);
  const hits = folders.filter(
    (f) => f.depth > 0 && foldFolderName(f.title) === target && (parentId === undefined || f.parentId === parentId),
  );
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return hits[0]!;
}

/** 在候选里找指定父级下、指定标题的文件夹（用于复用「自动整理」容器与 AI 新分类） */
export function findFolderByTitle(folders: FolderOption[], title: string, parentId: string): FolderOption | null {
  const target = foldFolderName(title);
  const hits = folders.filter((f) => f.depth > 0 && foldFolderName(f.title) === target && f.parentId === parentId);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return hits[0]!;
}

/** 解析模型回复：只接受 {folderId} 或 {newFolder}，其它一律视为不可解析 */
export function parseOrganizeReply(reply: string): { folderId?: string; newFolder?: string } | null {
  if (!reply) return null;
  // 模型可能带 ```json 围栏或前后说明，抓第一个花括号对象
  const match = reply.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { folderId?: unknown; newFolder?: unknown };
    const folderId = typeof obj.folderId === 'string' && obj.folderId.trim() ? obj.folderId.trim() : undefined;
    const newFolderRaw = typeof obj.newFolder === 'string' ? obj.newFolder.trim() : '';
    // 文件夹名做基本清洗：去换行、限长，避免模型吐出一整段话当目录名
    const newFolder = newFolderRaw ? newFolderRaw.replace(/[\r\n\t]+/g, ' ').slice(0, 24) : undefined;
    if (folderId) return { folderId };
    if (newFolder) return { newFolder };
    return null;
  } catch {
    return null;
  }
}

/* ────────────────────── 运行时部分 ────────────────────── */

/** 读取配置（background 与 UI 共用同一个 storage key） */
async function readConfig(): Promise<AIConfig> {
  const data = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  return resolveConfig(data[CONFIG_STORAGE_KEY] as Partial<AIConfig> | undefined);
}

/** 找到书签所在根目录节点（书签栏 / 其他书签 / 移动设备） */
async function findRootOf(id: string): Promise<{ root: BNode; rootId: string } | null> {
  const tree = await chrome.bookmarks.getTree();
  let curId = id;
  for (let depth = 0; depth < 32; depth++) {
    const nodes = await chrome.bookmarks.get(curId).catch(() => [] as BNode[]);
    const node = nodes[0];
    if (!node) return null;
    if (!node.parentId || node.parentId === '0') {
      const root = (tree[0]?.children ?? []).find((r) => r.id === node.id) ?? node;
      return { root, rootId: root.id };
    }
    curId = node.parentId;
  }
  return null;
}

/** 给模型看的候选清单：只保留同一根目录下的文件夹，条目有上限 */
function buildFolderPrompt(folders: FolderOption[]): string {
  return folders
    .filter((f) => f.depth > 0)
    .slice(0, 150)
    .map((f) => `- id=${f.id} | ${f.path}`)
    .join('\n');
}

/** 让模型选一个分类；失败返回 null（由调用方走域名兜底） */
async function classifyWithAI(
  config: AIConfig,
  title: string,
  url: string,
  folders: FolderOption[],
): Promise<{ pick: { folderId?: string; newFolder?: string } | null; failed: boolean }> {
  const controller = new AbortController();
  // 自动整理在后台跑，不能无限等：12 秒没结果就退回域名规则
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const turn = await chatCompletion(
      config,
      [
        {
          role: 'system',
          content:
            '你是书签分类器。只输出一个 JSON 对象，不要解释、不要 Markdown。' +
            '优先从给定文件夹里选最匹配的一个；没有合适的才给新分类名（2-12 个汉字，不要包含 / 与换行）。',
        },
        {
          role: 'user',
          content:
            `新书签：\n标题：${title}\n网址：${url}\n\n` +
            `现有文件夹（同一根目录）：\n${buildFolderPrompt(folders) || '（无）'}\n\n` +
            `输出格式二选一：{"folderId":"<上面的 id>"} 或 {"newFolder":"<新分类名>"}。`,
        },
      ],
      [],
      controller.signal,
      { onText: () => {}, onToolCall: () => {} },
    );
    const parsed = parseOrganizeReply(turn.content ?? '');
    // 回复不可解析也算「这次没成」：调用方据此累计失败次数（坏 Key / 端点不兼容都会走到这里）
    return { pick: parsed, failed: parsed === null };
  } catch {
    return { pick: null, failed: true };
  } finally {
    clearTimeout(timer);
  }
}

/** 复用同一父级下的同名文件夹，否则新建一个（文件夹不会被搬走，避免二次整理打乱结构） */
async function ensureFolder(parentId: string, title: string, folders: FolderOption[]): Promise<BNode> {
  const existing = findFolderByTitle(folders, title, parentId);
  if (existing) {
    const nodes = await chrome.bookmarks.get(existing.id).catch(() => [] as BNode[]);
    if (nodes[0] && !nodes[0].url) return nodes[0];
  }
  return jCreate({ parentId, title });
}

/** 把刚创建（或刚确认存在）的文件夹同步进上下文缓存，避免同批内重复创建 */
function rememberFolder(context: OrganizeContext | undefined, folder: BNode, rootId: string): void {
  if (!context) return;
  if (!folder?.id || folder.url) return;
  if (context.folders.some((f) => f.id === folder.id)) return;
  context.folders.push({
    id: folder.id,
    title: folder.title || '(未命名)',
    depth: folder.parentId === rootId ? 1 : 2,
    parentId: folder.parentId,
    path: folder.title || '(未命名)',
  });
}

/** 移动并返回目标路径（用于提示文案） */
async function moveInto(bookmarkId: string, folder: BNode): Promise<string> {
  await jMove(bookmarkId, { parentId: folder.id });
  return folder.title || '(未命名)';
}

/**
 * 主入口：整理一个新建书签。
 * 返回结构化结果而不是抛错——后台监听器必须能把「没整理成」如实告诉用户。
 */
export async function autoOrganizeBookmark(
  id: string,
  opts: {
    /** 补整理等批量场景用：同一域名刚刚已经超时/失败过，就别再让后面的每一条都等一次 */
    skipAi?: boolean;
    /**
     * 忽略「站点免打扰」名单。
     * 免打扰挡的是**后台自动行为**；用户主动点「补整理」是明确要求，
     * 这时还挡就等于「点了没反应」（注释里承诺过的事必须真的成立）。
     */
    ignoreOptOut?: boolean;
    /** 批量场景的复用上下文（见 OrganizeContext） */
    context?: OrganizeContext;
  } = {},
): Promise<AutoOrganizeResult> {
  let config: AIConfig;
  try {
    config = await readConfig();
  } catch (e) {
    return { ok: false, action: 'failed', detail: `读取配置失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (config.autoOrganizeNew === false) return { ok: true, action: 'skipped', detail: '未开启自动整理' };

  const nodes = await chrome.bookmarks.get(id).catch(() => [] as BNode[]);
  const node = nodes[0];
  if (!node) return { ok: true, action: 'skipped', detail: '书签已不存在' };
  if (!node.url) return { ok: true, action: 'skipped', detail: '不是书签' };
  if (!/^https?:\/\//i.test(node.url)) return { ok: true, action: 'skipped', detail: '非网页书签' };

  const domain = registrableDomain(node.url);
  if (!domain) return { ok: true, action: 'skipped', detail: '无法识别域名' };

  // 用户撤销过这个站点的自动整理 = 明确说过「别这么摆」：不再自动搬。
  // 手动「补整理」仍会处理（那是用户主动要求的），这里只挡后台的自动行为。
  if (opts.ignoreOptOut !== true && (await isOrganizeOptedOut(domain))) {
    return {
      ok: true,
      action: 'skipped',
      detail: `你撤销过「${domain}」的自动整理，已不再自动处理（可在整理记录里恢复）`,
    };
  }

  let rootId: string;
  let folders: FolderOption[];
  if (opts.context) {
    // 批量场景：根目录与候选文件夹都由调用方按批准备好，这里不再碰全树
    rootId = opts.context.rootId;
    folders = opts.context.folders;
  } else {
    const rootInfo = await findRootOf(id).catch(() => null);
    if (!rootInfo) return { ok: false, action: 'skipped', detail: '无法定位所属根目录' };
    rootId = rootInfo.rootId;
    folders = collectFolderOptions(rootInfo.root);
  }

  // 父级必须**直接读真实节点**，不能从 collectFolderOptions 的快照里反查：
  // 那份快照按 maxDepth 截断（默认 4 层），更深层的父级根本不在里面，
  // 查不到就会被当成「根目录书签」——于是用户手搭的 5 层分类里的书签被搬去「自动整理」。
  // T77 回归：深于 4 层的用户分类必须保持不动。
  const parentNode = node.parentId
    ? (await chrome.bookmarks.get(node.parentId).catch(() => [] as BNode[]))[0]
    : undefined;
  // 已经在同名站点文件夹里：不重复搬（幂等，也避免用户刚放好又被挪走）
  if (parentNode && (parentNode.title || '').toLowerCase() === domain.toLowerCase()) {
    return { ok: true, action: 'skipped', detail: `已在「${domain}」文件夹中` };
  }
  // 尊重用户既有分类：只有放在根目录、或放在「自动整理」容器里的才继续自动归类
  const parentIsRoot = !parentNode || parentNode.id === rootId;
  const isAtRootOrContainer = parentIsRoot || parentNode?.title === AUTO_CONTAINER;

  // T10：这个判断必须**在 AI 分类之前**。
  // 原先 ①② 分支（模型选文件夹 / 模型给新分类名）跑在它前面，于是 AI 一配置好，
  // 用户刚手动拖进「工作 / 技术」的书签就会被模型搬到别处 —— 违背"用户手放的别动"。
  // 现在提前到发请求之前：既保住了用户分类，也省掉一次注定要被丢弃的 AI 调用。
  if (!isAtRootOrContainer) {
    return { ok: true, action: 'skipped', detail: '已在分类文件夹中，保持不动' };
  }

  const owner = isRecording() ? null : `auto-organize:${id}`;
  if (owner) await beginUndoTransaction(owner);
  try {
    // AI 未配置完整（缺 Key / 模型）时不发注定失败的请求，直接走本地规则 + 域名兜底。
    // 用户也可以在设置里关掉「允许 AI 参与自动分类」：本地规则已经能覆盖常见站点，
    // 关掉后收藏动作不会把网址发给服务商，也不会产生 token 成本。
    const preset = getPreset(config.providerId);
    const aiAllowed = config.autoOrganizeAi !== false && opts.skipAi !== true;
    const aiReady =
      aiAllowed && !!config.baseUrl && !!config.model && !(preset?.needsKey === true && !config.apiKey);

    // ②.0 本地规则先行：能高置信度认领到用户已有分类时，直接放进去。
    // 这一步既让「没配 AI」的用户也有像样的归类，也省掉一次注定只是重复判断的模型调用。
    // 只认 90 分以上（品牌名精确命中），模糊匹配与「分类名命中」仍然交给模型。
    // 传 host：`news.ycombinator.com` 这类只对子域成立的分类条目只有完整主机名才查得到。
    // 解析失败就退化成只用注册域（上面已校验过是 http/https，这里只是防御）。
    let host = '';
    try {
      host = new URL(node.url).hostname.toLowerCase();
    } catch {
      host = '';
    }
    const localMatch = pickExistingFolder({ domain, host, folders, rootId });
    if (isConfidentMatch(localMatch) && localMatch && localMatch.folder.id !== node.parentId) {
      const targetNode = (await chrome.bookmarks.get(localMatch.folder.id).catch(() => [] as BNode[]))[0];
      if (targetNode && !targetNode.url) {
        const path = await moveInto(id, targetNode);
        // 这一分支在问模型之前就走完了，不存在「AI 失败」这回事
        // 本地规则高置信度直接采纳：这条没花一次模型调用
        return {
          ok: true,
          action: 'moved',
          detail: `已归入「${path}」（${localMatch.reason}）`,
          target: path,
          via: 'local',
          ...(owner ? { runId: owner } : {}),
        };
      }
    }

    const aiResult = aiReady
      ? await classifyWithAI(config, node.title || domain, node.url, folders)
      : { pick: null, failed: false };
    const aiPick = aiResult.pick;
    const aiFailed = aiResult.failed;

    // ① 模型选了现有文件夹
    if (aiPick?.folderId) {
      const target = folders.find((f) => f.id === aiPick.folderId);
      if (target) {
        if (target.id === node.parentId) {
          return { ok: true, action: 'skipped', detail: `已在「${target.title}」中` };
        }
        const targetNode = (await chrome.bookmarks.get(target.id).catch(() => [] as BNode[]))[0];
        if (targetNode && !targetNode.url) {
          const path = await moveInto(id, targetNode);
          return { ok: true, action: 'moved', detail: `已归入「${path}」`, target: path, via: 'model', ...(owner ? { runId: owner } : {}) };
        }
      }
    }

    // ② 模型给了新分类名：放到同一根目录下（名字已存在则复用）
    if (aiPick?.newFolder) {
      const existing = findFolderByTitle(folders, aiPick.newFolder, rootId);
      const folder = existing
        ? ((await chrome.bookmarks.get(existing.id).catch(() => [] as BNode[]))[0] ?? (await ensureFolder(rootId, aiPick.newFolder, folders)))
        : await ensureFolder(rootId, aiPick.newFolder, folders);
      rememberFolder(opts.context, folder, rootId);
      if (!folder.url) {
        const path = await moveInto(id, folder);
        return {
          ok: true,
          action: existing ? 'moved' : 'created',
          detail: `${existing ? '已归入' : '已新建分类并归入'}「${path}」`,
          target: path,
          via: 'model',
          ...(owner ? { runId: owner } : {}),
        };
      }
    }

    // ②.5 模型没给出可用结论（未配置 / 超时 / 回复不可解析）时的本地兜底：
    // 此时任何「用户自己的分类」都比新建一个域名文件夹更贴近用户意图，所以 60 分以上就采纳。
    if (localMatch && localMatch.folder.id !== node.parentId) {
      const targetNode = (await chrome.bookmarks.get(localMatch.folder.id).catch(() => [] as BNode[]))[0];
      if (targetNode && !targetNode.url) {
        const path = await moveInto(id, targetNode);
        return {
          ok: true,
          action: 'moved',
          detail: `已归入「${path}」（${localMatch.reason}）`,
          target: path,
          via: 'fallback',
          ...(aiFailed ? { aiFailed: true } : {}),
          ...(owner ? { runId: owner } : {}),
        };
      }
    }

    // ③ 兜底：按注册域归类（走到这里时书签仍在根目录 / 自动整理容器内）
    const domainFolder = findDomainFolder(folders, domain);
    if (domainFolder) {
      const targetNode = (await chrome.bookmarks.get(domainFolder.id).catch(() => [] as BNode[]))[0];
      if (targetNode && !targetNode.url) {
        const path = await moveInto(id, targetNode);
        // target / runId / aiFailed 一个都不能少：
        //  - target：面板要显示「→ 去了哪个文件夹」，否则用户只看到一句「已归入」
        //  - runId：没有它这条记录就没有「↶ 撤销」按钮（用户不满意时无路可退）
        //  - aiFailed：这条分支是**坏 Key 时最常见**的落点，漏了它冷却就永远不触发
        return {
          ok: true,
          action: 'moved',
          detail: `已归入「${path}」`,
          target: path,
          via: 'fallback',
          ...(aiFailed ? { aiFailed: true } : {}),
          ...(owner ? { runId: owner } : {}),
        };
      }
    }
    const container = await ensureFolder(rootId, AUTO_CONTAINER, folders);
    // 容器下的站点文件夹本来就在 `folders` 里（它是整棵根目录子树的文件夹集合）；
    // 原先为了看容器内又调了一次 getSubTree（1 万条时 200ms+），完全是重复劳动。
    // 本批新建的文件夹也已通过 rememberFolder 同步进 folders。
    const siteFolder = findDomainFolder(folders, domain, container.id);
    rememberFolder(opts.context, container, rootId);
    const folder =
      siteFolder && siteFolder.id !== container.id
        ? ((await chrome.bookmarks.get(siteFolder.id).catch(() => [] as BNode[]))[0] ??
          (await jCreate({ parentId: container.id, title: domain })))
        : await jCreate({ parentId: container.id, title: domain });
    rememberFolder(opts.context, folder, rootId);
    const path = await moveInto(id, folder);
    // 同 ③ 的第一分支：这条也是坏 Key 时的高频落点，必须把 aiFailed 交给调用方，
    // 否则「连续失败 3 次暂停 10 分钟」在「没有任何匹配分类的用户」身上永远不生效。
    return {
      ok: true,
      action: 'created',
      detail: `已归入「${path}」`,
      target: path,
      via: 'fallback',
      ...(aiFailed ? { aiFailed: true } : {}),
      ...(owner ? { runId: owner } : {}),
    };
  } catch (e) {
    return { ok: false, action: 'failed', detail: `自动整理失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (owner) await endUndoTransaction(owner);
  }
}

/* ────────────────────── 补整理：找出「散落」的书签 ────────────────────── */

export interface SweepTarget {
  id: string;
  title: string;
  url: string;
  /** 所属根目录 id：批量整理按根复用上下文（避免每条都查一次整棵树） */
  rootId: string;
}

/**
 * 收集需要补整理的书签：**散落在根目录下的**，以及**堆在「自动整理」容器里没进站点文件夹的**。
 *
 * 为什么只收这两类：用户自己的分类文件夹（「技术」「设计」）里的书签是用户放过的，
 * 补整理去动它们就是替他改结构——和自动整理「尊重既有分类」的原则一致。
 *
 * @param maxItems 单次上限：补整理会逐条走 AI，一次几百条会拖很久；超出部分让用户分批。
 * @param exclude 已经处理过的书签 id（补整理批处理用）。
 *   **必须在收集阶段就排除，而不是收集完再 filter**：否则「前 200 条都处理过」时，
 *   截断后的批次会被一个空 filter 清空，`break` 带走剩下的全部书签，且不给任何提示。
 */
export function collectLooseBookmarksFromRoots(
  roots: chrome.bookmarks.BookmarkTreeNode[],
  maxItems = 200,
  exclude?: ReadonlySet<string>,
): SweepTarget[] {
  const out: SweepTarget[] = [];
  const push = (node: chrome.bookmarks.BookmarkTreeNode, rootId: string): boolean => {
    if (out.length >= maxItems) return false;
    if (!node.url || !/^https?:\/\//i.test(node.url)) return true;
    if (exclude?.has(node.id)) return true;
    out.push({ id: node.id, title: node.title || node.url, url: node.url, rootId });
    return out.length < maxItems;
  };
  for (const root of roots) {
    for (const child of root.children ?? []) {
      if (child.url) {
        if (!push(child, root.id)) return out;
        continue;
      }
      // 「自动整理」容器里直接躺着的书签（没能归入站点文件夹的那些）
      if ((child.title || '') === AUTO_CONTAINER) {
        for (const grand of child.children ?? []) {
          if (grand.url && !push(grand, root.id)) return out;
        }
      }
    }
  }
  return out;
}

/**
 * `chrome.bookmarks.getTree()` 形态的便捷入口（`[根节点]`）。
 * 后台拿到的就是这种形态；UI 侧手里只有三个根文件夹，用 `collectLooseBookmarksFromRoots`。
 */
export function collectLooseBookmarks(
  tree: chrome.bookmarks.BookmarkTreeNode[],
  maxItems = 200,
  exclude?: ReadonlySet<string>,
): SweepTarget[] {
  return collectLooseBookmarksFromRoots(tree[0]?.children ?? [], maxItems, exclude);
}

/**
 * 把一条书签直接放进指定文件夹（批量整理时复用同域名的结论）。
 *
 * 为什么不复用 autoOrganizeBookmark：那条路径每次都要走完整决策（收集候选、可能问模型）。
 * 补整理几百条同域名书签时，第一条得出的结论对后面完全适用——把结论传下来即可。
 * 仍走同一套撤销事务，所以用户在整理记录里看到的那条照样能一步撤回。
 */
export async function moveBookmarkInto(
  bookmarkId: string,
  folderId: string,
  reason = '同站点已在上面归好类',
  opts: {
    context?: OrganizeContext;
    /**
     * 父目录顺序缓存（`parentId → 子项 id`）。
     * 批量移动时每条都要「移动前下标」，默认实现会 `getChildren` 整个父目录——
     * 1 万条书签在根目录时等于每条读 1 万项并线性查找，整体退化成 O(n²)
     * （干净环境实测：3000 条 35s，1 万条 402s）。传进来就让调用方自己维护这份顺序。
     */
    orderCache?: Map<string, string[]>;
  } = {},
): Promise<AutoOrganizeResult> {
  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => [] as BNode[]);
  const node = nodes[0];
  if (!node) return { ok: true, action: 'skipped', detail: '书签已不存在' };
  if (!node.url || !/^https?:\/\//i.test(node.url)) return { ok: true, action: 'skipped', detail: '非网页书签' };
  const target = (await chrome.bookmarks.get(folderId).catch(() => [] as BNode[]))[0];
  if (!target || target.url) return { ok: false, action: 'failed', detail: '目标文件夹已不存在' };
  if (node.parentId === folderId) return { ok: true, action: 'skipped', detail: `已在「${target.title}」中` };

  // 取「移动前下标」：优先用调用方维护的本地顺序，避免每条都读整个父目录
  let known: { fromParentId?: string; fromIndex?: number } | undefined;
  const cache = opts.orderCache ?? opts.context?.order;
  if (cache && node.parentId) {
    let order = cache.get(node.parentId);
    if (!order) {
      const kids = await chrome.bookmarks.getChildren(node.parentId).catch(() => [] as BNode[]);
      order = kids.map((k) => k.id);
      cache.set(node.parentId, order);
    }
    const idx = order.indexOf(bookmarkId);
    if (idx >= 0) {
      known = { fromParentId: node.parentId, fromIndex: idx };
      order.splice(idx, 1);
    }
  }

  const owner = isRecording() ? null : `auto-organize:${bookmarkId}`;
  if (owner) await beginUndoTransaction(owner);
  try {
    await jMove(bookmarkId, { parentId: folderId }, known);
    const path = target.title || '(未命名)';
    return {
      ok: true,
      action: 'moved',
      detail: `已归入「${path}」（${reason}）`,
      target: path,
      ...(owner ? { runId: owner } : {}),
    };
  } catch (e) {
    return { ok: false, action: 'failed', detail: `归入失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (owner) await endUndoTransaction(owner);
  }
}

/* ────────────────────── AI 连续失败冷却 ────────────────────── */

/** 连续失败多少次后暂停 AI 分类 */
export const AI_FAIL_STREAK_LIMIT = 3;
/** 暂停时长：够用户去设置页改配置，又不至于永远不再试 */
export const AI_COOLDOWN_MS = 10 * 60_000;

export interface AiStreakState {
  streak: number;
  cooldownUntil: number;
  /** 本次是否**刚刚**进入冷却（调用方据此提示一次） */
  justCooled: boolean;
}

/**
 * 累计「AI 分类连续失败」并决定是否进入冷却（纯函数，便于单测）。
 *
 * 为什么需要：用户把 API Key 配错、或端点不兼容时，**每一次收藏**都会先等 12 秒超时
 * 再退回本地规则。收藏本该是即时动作，白等 12 秒的体感是「这扩展坏了」。
 * 连续失败到一定次数就暂停模型调用一段时间，期间只用本地规则（归类仍然发生，只是不问模型）。
 *
 * 注意 `failed: false` 但也没成功（例如根本没问模型）时不动计数——
 * 否则「关掉 AI 分类」的用户会被误判成失败并在界面上看到无意义的提示。
 */
export function nextAiStreakState(opts: {
  state: AiStreakState;
  failed: boolean;
  now: number;
}): AiStreakState {
  const { state, failed, now } = opts;
  // 冷却结束：计数归零，重新允许试一次
  if (state.cooldownUntil > 0 && now >= state.cooldownUntil) {
    return { streak: 0, cooldownUntil: 0, justCooled: false };
  }
  if (!failed) return { streak: 0, cooldownUntil: state.cooldownUntil, justCooled: false };
  const streak = state.streak + 1;
  if (streak >= AI_FAIL_STREAK_LIMIT && state.cooldownUntil === 0) {
    return { streak, cooldownUntil: now + AI_COOLDOWN_MS, justCooled: true };
  }
  return { streak, cooldownUntil: state.cooldownUntil, justCooled: false };
}
