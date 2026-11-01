import { Keyboard } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';

/**
 * 快捷键与操作速查。
 *
 * 为什么需要：这些键在 README 里全部写着，但产品里看不到——用户不可能为了知道
 * 「F2 能重命名」去读文档。可发现性本身就是操作体验的一部分。
 * 这里只列**代码里真实绑定过**的键，不写"应该支持"的键，避免帮助本身在撒谎。
 */

interface Shortcut {
  keys: string[];
  desc: string;
}

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: '导航',
    items: [
      { keys: ['↑', '↓'], desc: '上下移动高亮' },
      { keys: ['←', '→'], desc: '折叠 / 展开文件夹' },
      { keys: ['Home', 'End'], desc: '跳到首项 / 末项' },
      { keys: ['PgUp', 'PgDn'], desc: '整页翻动' },
      { keys: ['Enter'], desc: '打开当前项（文件夹则进入）' },
      { keys: ['Shift', 'Enter'], desc: '在后台新标签页打开' },
    ],
  },
  {
    title: '选择',
    items: [
      { keys: ['空格'], desc: '选中 / 取消当前项' },
      { keys: ['Shift', '↑↓'], desc: '范围选择' },
      { keys: ['Ctrl', 'A'], desc: '全选当前列表' },
      { keys: ['Ctrl', '单击'], desc: '追加或取消这一项' },
    ],
  },
  {
    title: '操作',
    items: [
      { keys: ['F2'], desc: '重命名当前项' },
      { keys: ['Delete'], desc: '删除（文件夹会确认）' },
      { keys: ['Ctrl', 'C'], desc: '复制选中项的网址' },
      { keys: ['右键'], desc: '移动到 / 打开全部 / 让 MarkAI 整理' },
    ],
  },
  {
    title: '视图与搜索',
    items: [
      { keys: ['Ctrl', 'K'], desc: '聚焦搜索框' },
      { keys: ['/'], desc: '在树或列表内聚焦搜索' },
      { keys: ['Esc'], desc: '关闭浮层 / 清除搜索' },
      { keys: ['Ctrl', 'Shift', 'M'], desc: '打开 MarkAI 侧边栏' },
      { keys: ['?'], desc: '打开这张速查表' },
    ],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-muted px-1 font-sans text-2xs font-medium text-foreground">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="快捷键与操作"
      description="键盘能完成大部分整理工作。这些键在书签树和中栏列表里都生效。"
      width="w-[560px]"
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
              <Keyboard className="h-3 w-3" aria-hidden="true" />
              {group.title}
            </h3>
            <dl className="space-y-1.5">
              {group.items.map((item) => (
                <div key={item.desc} className="flex items-start justify-between gap-3">
                  <dt className="min-w-0 text-xs leading-5 text-foreground">{item.desc}</dt>
                  <dd className="flex shrink-0 items-center gap-0.5">
                    {item.keys.map((k, i) => (
                      <span key={`${k}-${i}`} className="flex items-center gap-0.5">
                        {i > 0 && <span className="text-2xs text-muted-foreground/50">+</span>}
                        <Kbd>{k}</Kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-2xs leading-4 text-muted-foreground">
        撤销不用记快捷键：Agent 每轮操作结束后，聊天面板头部会出现「↶ 撤销」；自动整理的每一步也能在「整理记录」里单独撤销。
      </p>
    </Dialog>
  );
}
