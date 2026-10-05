import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type Size = 'sm' | 'default' | 'lg' | 'icon' | 'icon-sm';

const variantClasses: Record<Variant, string> = {
  // 主按钮：Indigo 实色（无渐变，克制不花哨），hover 加深
  default: 'bg-accent text-accent-foreground hover:bg-accent/90',
  secondary: 'bg-muted text-foreground hover:bg-muted',
  outline: 'border border-border bg-card text-foreground hover:bg-muted',
  // 幽灵按钮用于工具栏：默认压到次要色，hover 才提到主色，让一排图标按钮不抢内容
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  destructive: 'border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-7 gap-1 px-2.5 text-xs',
  default: 'h-8 gap-1.5 px-3 text-xs',
  lg: 'h-9 gap-2 px-4 text-sm',
  icon: 'h-7 w-7',
  'icon-sm': 'h-6 w-6',
};

/**
 * 按钮：圆角走 --radius-sm（6px），hover 仅改背景，无放大/跳动动效。
 * size 为 icon / icon-sm 时为正方形（工具栏图标用），不设内边距。
 */
export function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45',
        'focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
}
