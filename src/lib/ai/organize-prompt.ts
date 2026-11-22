/**
 * ── 「整理」类指令的唯一口径 ──
 *
 * 三个入口（聊天起手 chip、书签树右键、斜杠命令）都会发出"整理某个文件夹"的指令。
 * 过去它们各写各的，于是同一个行为在三个地方长度不同、要求不同——
 * 这次还要按设置分叉成"先落暂存区"与"直接落位"两条路，再各写一遍必然漂移。
 *
 * 所以指令由这里生成，入口只负责传参数。这样改一次就三处同时生效，
 * 也让"必须带 folderId""不许建到根目录"这两条能被单测钉死。
 */

export interface OrganizePromptInput {
  /** 被整理的文件夹标题（给人看的） */
  folderTitle: string;
  /** 被整理的文件夹 id（给模型用的落点依据） */
  folderId: string;
  /**
   * 是否先落暂存区（设置项 `organizeStaging`）。
   * true：新分类先进「自动整理」，用户在整理记录里点一下才落位。
   * false：直接写进被整理的文件夹（老行为）。
   */
  staging: boolean;
}

/**
 * 生成整理指令。
 *
 * 两条不变式（任何分支都必须成立）：
 *  1. 指令里带 folderId —— 只给标题等于让模型猜；
 *  2. 明确禁止把子分类建到书签栏根目录。
 */
export function buildOrganizePrompt({ folderTitle, folderId, staging }: OrganizePromptInput): string {
  const title = folderTitle || '(未命名)';
  if (staging) {
    return (
      `请整理书签文件夹「${title}」（folderId = "${folderId}"）：` +
      `先调用 stage_organize(folderId="${folderId}") 开一个暂存批次，` +
      `把新分类建在返回的 batchId 下、把书签移进 batchId（不要直接改我的文件夹，也不要建到书签栏根目录）；` +
      `完成后告诉我「已放进自动整理暂存区，等待确认」，我会在整理记录里决定应用还是放弃。`
    );
  }
  return (
    `请整理书签文件夹「${title}」（folderId = "${folderId}"）：` +
    `浏览其全部书签，在**这个文件夹内部**创建合适的子分类（create_folder 必须传 parentId="${folderId}"），` +
    `并把书签归类移动到位；不要把子分类建到书签栏或其他根目录下。`
  );
}

/**
 * 斜杠命令 `/整理` 的指令。
 *
 * 它没有 folderTitle / folderId 可填：真正的位置由 background 注入的
 * 「当前上下文」提供。因此只写流程与落点约束，不伪造 id。
 * 同样按设置分叉——用户关掉暂存后，斜杠命令不能还逼模型先开批次。
 */
export function buildSlashOrganizePrompt(staging: boolean): string {
  if (staging) {
    return (
      '请整理当前文件夹（就是消息开头「当前上下文」里给出的那个 folderId）：' +
      '先列出你打算怎么分类和移动，等我确认后再调用 stage_organize() 开一个暂存批次' +
      '（不传 folderId，用当前上下文），把新子分类建在返回的 batchId 下、把书签移进 batchId；' +
      '不要直接改我的文件夹，也不要建到书签栏根目录。'
    );
  }
  return (
    '请整理当前文件夹（就是消息开头「当前上下文」里给出的那个 folderId）：' +
    '新子分类必须建在这个文件夹**内部**（create_folder 显式传 parentId），不要建到书签栏根目录。' +
    '先列出你打算怎么分类和移动，等我确认后再执行。'
  );
}
