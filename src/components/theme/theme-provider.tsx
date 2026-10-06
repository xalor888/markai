import { Moon, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { applyTheme, initThemeSync, useThemeStore, watchSystemTheme } from '@/stores/themeStore';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 页面挂载时应用主题（每个入口调用一次） */
export function ThemeProvider() {
  const theme = useThemeStore((s) => s.theme);
  const load = useThemeStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    applyTheme(theme);
    const unwatch = watchSystemTheme();
    // 跨窗口主题同步（其他窗口切换后立即跟随）
    const stopSync = initThemeSync();
    return () => {
      unwatch();
      stopSync();
    };
  }, [theme]);

  return null;
}

/** 主题切换按钮（浅色/深色循环） */
export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => void setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? '切换到浅色模式' : '切换到深色模式'}
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
    >
      {isDark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
    </Button>
  );
}

/**
 * MarkAI 官方品牌矢量图标（与插件图标 100% 一致）：
 * 品牌 Indigo 圆角卡片外框 + 白色下垂书签（带底部 V 缺口）
 */
export function BrandIcon({
  size = 24,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="85" y="43" width="342" height="426" rx="52" className="fill-accent" />
      <path d="M224 139H352V235L288 168L224 235Z" fill="white" />
    </svg>
  );
}

/** MarkAI 统一品牌标识（官方图标 + 品牌字） */
export function BrandMark({
  size = 'sm',
  subtitle,
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  subtitle?: string;
  className?: string;
}) {
  const iconSize = size === 'lg' ? 30 : size === 'md' ? 24 : 20;
  const textSize = size === 'lg' ? 'text-lg' : size === 'md' ? 'text-base' : 'text-sm';

  return (
    <div className={cn('flex items-center gap-2 select-none', className)}>
      <BrandIcon size={iconSize} className="shrink-0 drop-shadow-xs" />
      <div className="flex items-baseline gap-1.5">
        <span className={cn('font-semibold tracking-tight text-foreground', textSize)}>
          Mark<span className="text-accent">AI</span>
        </span>
        {subtitle && (
          <span className="text-xs text-muted-foreground font-normal">{subtitle}</span>
        )}
      </div>
    </div>
  );
}
