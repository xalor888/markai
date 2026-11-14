/**
 * ── 斜杠命令（输入框里的"快捷指令"） ──
 *
 * 输入框已经有五个快捷 chip，但它们只在**有消息**时出现，而且点一下就立刻发送。
 * 斜杠命令解决另一个场景：想用一句话起手，但还没想好具体怎么写。
 *
 * 设计约束：
 *  - 选中命令只**填入 prompt**，不自动发送——用户还能补一句再回车；
 *  - 命令是纯文本，不走解析器：Agent 收到的是完整中文指令，模型换谁都能懂；
 *  - 过滤是纯函数，菜单只是它的投影。
 */

export interface SlashCommand {
  /** 展示与过滤用的命令名（含斜杠） */
  cmd: string;
  label: string;
  description: string;
  /** 选中后填入输入框的完整指令 */
  prompt: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    cmd: '/整理',
    label: '整理当前文件夹',
    description: '先给计划，确认后再移动与合并',
    prompt: '请整理当前文件夹：先列出你打算怎么分类和移动，等我确认后再执行。',
  },
  {
    cmd: '/清理',
    label: '扫描整个书签库',
    description: '重复链接、死链、空文件夹（只建议，不删除）',
    prompt: '扫描整个书签库：找出重复链接、可能失效的链接和空文件夹。先给建议清单，不要直接删除。',
  },
  {
    cmd: '/记住',
    label: '写一条长期记忆',
    description: '补全内容后回车；以后整理都会遵守',
    prompt: '记住：',
  },
  {
    cmd: '/概括',
    label: '概括当前文件夹',
    description: '按主题分组，列出每组有多少条',
    prompt: '概括当前文件夹：按主题分组，告诉我每组大致有多少条、有没有明显放错位置的。',
  },
  {
    cmd: '/找',
    label: '在全部书签里找',
    description: '补全关键词后回车',
    prompt: '在全部书签里找：',
  },
];

/**
 * 按输入过滤命令。
 * 输入不是以 `/` 开头 → 返回空数组（菜单不该出现）。
 * 只有 `/` → 返回全部。
 */
export function filterSlashCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const q = input.slice(1).trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (c) =>
      c.cmd.slice(1).toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
  );
}
