import { Check, Keyboard, LayoutPanelLeft, Maximize, MessageSquare, Moon, MoreHorizontal, Settings, Sun, Trash2, Wand2, Monitor, BookmarkPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { cn } from '@/lib/utils';

/**
 * 顶栏「更多」菜单。
 *
 * 为什么要有它：重做前顶栏摊着 **11 个纯图标**（收藏 / 待删 / 整理 / 时间线 / 全屏 /
 * 侧边栏 / 聊天 / 主题 / 设置 …），全部没有文字标签——用户只能靠猜，而且真正的内容
 * 区被挤到只剩一行。这里把"偶尔用一次"的入口全部收进菜单，顶栏只留
 * 「品牌标 · 搜索 · 更多」三样。
 *
 * 需要一眼看见的状态仍然保留在**触发按钮**上：有待删项时按钮带红点，
 * 整理有失败时也带红点——收起来不等于藏起来。
 */
export function MoreMenu({
  pendingCount,
  organizeAlert,
  chatOpen,
  mode,
  onToggleChat,
  onDeletions,
  onOrganize,
  onSettings,
  onShortcuts,
  onSwitchContainer,
  onSaveCurrentTab,
}: {
  pendingCount: number;
  /** 整理记录里有需要留意的失败 */
  organizeAlert: boolean;
  chatOpen: boolean;
  mode: 'compact' | 'full';
  onToggleChat: () => void;
  onDeletions: () => void;
  onOrganize: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
  /** 在完整页 / 侧边栏之间切换 */
  onSwitchContainer: () => void;
  onSaveCurrentTab: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  // 点击外部 / Esc 关闭（与仓库里其它浮层一致）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** 有需要主人看一眼的东西：触发按钮上点一个红点 */
  const hasAlert = pendingCount > 0 || organizeAlert;

  const item = (
    icon: React.ComponentType<{ className?: string }>,
    label: string,
    onClick: () => void,
    opts: { badge?: number; danger?: boolean; active?: boolean } = {},
  ) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors',
        opts.danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-muted',
        opts.active && 'bg-accent-muted text-accent',
      )}
    >
      {(() => {
        const Icon = icon;
        return <Icon className="h-3.5 w-3.5 shrink-0" />;
      })()}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {opts.badge !== undefined && opts.badge > 0 && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive/10 px-1.5 text-2xs font-semibold text-destructive">
          {opts.badge}
        </span>
      )}
    </button>
  );

  const themes: { id: Theme; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: '浅色', icon: Sun },
    { id: 'dark', label: '深色', icon: Moon },
    { id: 'system', label: '跟随系统', icon: Monitor },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多"
        title="更多"
        className={cn(
          'relative flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-muted',
          open ? 'bg-muted text-foreground' : 'text-muted-foreground',
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
        {hasAlert && (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="animate-fade-in absolute right-0 z-50 mt-1 w-52 overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg"
        >
          {item(BookmarkPlus, '收藏当前页面', onSaveCurrentTab)}
          {item(Trash2, '待删除清单', onDeletions, { badge: pendingCount, danger: pendingCount > 0 })}
          {item(Wand2, '整理记录', onOrganize, { active: organizeAlert })}
          <div className="my-1 h-px bg-border" />
          {item(MessageSquare, chatOpen ? '收起 Agent 面板' : '展开 Agent 面板', onToggleChat, { active: chatOpen })}
          {mode === 'full'
            ? item(LayoutPanelLeft, '在侧边栏打开', onSwitchContainer)
            : item(Maximize, '在完整页面打开', onSwitchContainer)}
          {item(Keyboard, '快捷键与操作', onShortcuts)}
          <div className="my-1 h-px bg-border" />
          <p className="px-3 pt-1 pb-1 text-2xs text-muted-foreground">主题</p>
          {themes.map((t) =>
            item(
              t.icon,
              t.label,
              () => void setTheme(t.id),
              theme === t.id ? { active: true } : {},
            ),
          )}
          <div className="my-1 h-px bg-border" />
          {item(Settings, '设置', onSettings)}
        </div>
      )}
    </div>
  );
}

/** 主题项右侧的勾（当前生效的那一项） */
export function ThemeCheck({ active }: { active: boolean }) {
  return active ? <Check className="h-3 w-3 text-accent" /> : null;
}
