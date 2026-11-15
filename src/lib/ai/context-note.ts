/**
 * ── 注入给 Agent 的「当前上下文」说明 ──
 *
 * 抽成纯函数的理由很具体：这段文字决定模型把新建的子分类放到哪。
 * 0.2.169 之前它只给文件夹**标题**（「软件工具」），模型知道在整理什么，
 * 却拿不到 id —— 于是 create_folder 只能省略 parentId，落到工具默认值（书签栏根），
 * 用户看到的就是"整理完，书签栏下面凭空多出一堆分类文件夹"。
 *
 * 把"文案"变成可单测的函数，比在 background 里拼字符串可靠：
 * 任何人想改措辞，都会先撞上断言，改不掉"必须带 id"和"必须建在内部"这两个约束。
 */

export interface ContextFolder {
  id: string;
  title: string;
}

/** 上下文文件夹已被删除时的说明（模型不该以为自己还有视野） */
export const MISSING_FOLDER_NOTE = '（注：用户此前查看的上下文文件夹已不存在，请按全部书签处理）\n';

/**
 * 构造注入段。返回空字符串表示没有上下文（不需要注入）。
 *
 * 两个约束写死在这里，不随措辞漂移：
 *  1. 必须给出 folderId；
 *  2. 必须写明"新子分类建在它内部"，并点明省略 parentId 的后果。
 */
export function folderContextNote(folder: ContextFolder | null): string {
  if (!folder) return MISSING_FOLDER_NOTE;
  const title = folder.title || '(未命名)';
  return (
    `（当前上下文：用户正在查看书签文件夹「${title}」，folderId = "${folder.id}"）\n` +
    `（若本轮要"整理/归类这个文件夹"：新建的子分类必须建在它**内部**，` +
    `即 create_folder / create_bookmark / create_bookmarks 显式传 parentId="${folder.id}"；` +
    `省略 parentId 会落到书签栏根目录，那不是用户想要的。）\n`
  );
}
