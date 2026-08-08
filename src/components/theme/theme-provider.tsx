import { BookMarked, Moon, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { applyTheme, initThemeSync, useThemeStore, watchSystemTheme } from '@/stores/themeStore';
import { Button } from '@/components/ui/button';

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

/** MarkAI 品牌标识（实色图标 + 品牌字，无渐变） */
export function BrandMark({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-accent text-white">
        <BookMarked className="h-3.5 w-3.5" strokeWidth={2.2} />
      </span>
      <span className={`font-medium tracking-tight text-foreground ${size === 'sm' ? 'text-sm' : 'text-base'}`}>
        Mark<span className="text-accent">AI</span>
      </span>
    </div>
  );
}
