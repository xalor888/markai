/**
 * 把书签树导出成文件内容。
 *
 * 为什么要有：`export_bookmarks` 这个 AI 工具只把清单**返回给模型分析**，不产生文件；
 * UI 里也只有「导出对话」「导出整理记录」。于是用户说「把我的书签导出备份」时，
 * 没有任何地方能拿到一个文件。
 *
 * 两种格式：
 *  - **Netscape HTML**：浏览器通用的书签文件格式，Chrome / Edge / Firefox / Safari
 *    都能直接导入。备份和迁移都应该用它。
 *  - **JSON**：保留完整结构（含 id 与时间戳），适合程序处理或自己写脚本。
 *
 * 纯函数、无副作用：格式对不对可以完全靠单测钉住，不用开浏览器。
 */

type Node = chrome.bookmarks.BookmarkTreeNode;

/** XML/HTML 文本转义（标题与 URL 都要转，否则特殊字符会把文件弄坏） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 秒级时间戳（Netscape 格式用秒，Chrome 的书签 API 用毫秒） */
function toSeconds(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '0';
  return String(Math.floor(ms / 1000));
}

/**
 * 生成 Netscape 书签 HTML。
 *
 * 结构约定（与 Chrome 自己导出的文件一致）：
 *   - 虚拟根（`roots[0]`）本身不输出，只输出它的子节点（书签栏 / 其他书签）；
 *   - 文件夹 → `<DT><H3 …>名字</H3>` 加一个嵌套 `<DL><p>…</DL><p>`；
 *   - 书签 → `<DT><A HREF="…" ADD_DATE="…">标题</A>`；
 *   - **空文件夹也要输出**（否则导入后结构就变了）。
 */
export function toNetscapeHtml(roots: Node[]): string {
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  const walk = (nodes: Node[], depth: number): void => {
    const pad = '    '.repeat(depth);
    for (const n of nodes) {
      if (n.url) {
        const addDate = toSeconds(n.dateAdded);
        const lastUsed =
          typeof n.dateLastUsed === 'number' && n.dateLastUsed > 0
            ? ` LAST_USED="${toSeconds(n.dateLastUsed)}"`
            : '';
        lines.push(
          `${pad}<DT><A HREF="${escapeHtml(n.url)}" ADD_DATE="${addDate}"${lastUsed}>${escapeHtml(n.title || n.url)}</A>`,
        );
      } else {
        const title = escapeHtml(n.title || '(未命名)');
        const addDate = toSeconds(n.dateAdded);
        const lastMod = toSeconds(n.dateGroupModified ?? n.dateAdded);
        lines.push(`${pad}<DT><H3 ADD_DATE="${addDate}" LAST_MODIFIED="${lastMod}">${title}</H3>`);
        lines.push(`${pad}<DL><p>`);
        // 空文件夹也要有 DL，否则导入方会认为它不存在
        if (n.children && n.children.length > 0) walk(n.children, depth + 1);
        lines.push(`${pad}</DL><p>`);
      }
    }
  };

  // roots[0] 是虚拟根：跳过它本身，导出它的子节点
  const top = roots.length === 1 && !roots[0]!.url ? (roots[0]!.children ?? []) : roots;
  walk(top, 1);

  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

export interface ExportJson {
  version: 1;
  exportedAt: string;
  bookmarks: unknown[];
}

/** 递归裁剪：只保留可读字段（不导出 parentId 这类内部引用，避免导入方误用） */
function slim(n: Node): Record<string, unknown> {
  return {
    title: n.title,
    ...(n.url ? { url: n.url } : {}),
    ...(typeof n.dateAdded === 'number' ? { dateAdded: new Date(n.dateAdded).toISOString() } : {}),
    ...(typeof n.dateLastUsed === 'number' && n.dateLastUsed > 0
      ? { dateLastUsed: new Date(n.dateLastUsed).toISOString() }
      : {}),
    ...(n.children ? { children: n.children.map(slim) } : {}),
  };
}

/** 生成 JSON 备份（保留文件夹层级） */
export function toJsonExport(roots: Node[], now: Date = new Date()): string {
  const top = roots.length === 1 && !roots[0]!.url ? (roots[0]!.children ?? []) : roots;
  const payload: ExportJson = {
    version: 1,
    exportedAt: now.toISOString(),
    bookmarks: top.map(slim),
  };
  return JSON.stringify(payload, null, 2);
}

/** 统计一个树里有多少书签 / 文件夹（给按钮旁边显示"将导出 N 条"） */
export function countTree(nodes: Node[]): { bookmarks: number; folders: number } {
  let bookmarks = 0;
  let folders = 0;
  const walk = (list: Node[]): void => {
    for (const n of list) {
      if (n.url) bookmarks++;
      else {
        folders++;
        if (n.children) walk(n.children);
      }
    }
  };
  const top = nodes.length === 1 && !nodes[0]!.url ? (nodes[0]!.children ?? []) : nodes;
  walk(top);
  // 虚拟根不计入 folders
  return { bookmarks, folders };
}
