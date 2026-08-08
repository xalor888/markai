import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type Size = 'sm' | 'default' | 'lg' | 'icon';

const variantClasses: Record<Variant, string> = {
  // 主按钮：Indigo 实色（无渐变，克制不花哨），hover 加深
  default: 'bg-accent text-white hover:bg-accent/90',
  secondary: 'bg-muted text-foreground hover:bg-muted/80',
  outline: 'border border-border bg-card text-foreground hover:bg-muted/60',
  ghost: 'text-foreground hover:bg-muted/60',
  destructive: 'border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-7 gap-1 px-2 text-xs',
  default: 'h-8 gap-1.5 px-3 text-xs',
  lg: 'h-9 gap-2 px-4 text-sm',
  icon: 'h-7 w-7',
};

/** 按钮：4px 圆角，hover 仅改背景透明度，无放大/跳动动效 */
export function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
}
