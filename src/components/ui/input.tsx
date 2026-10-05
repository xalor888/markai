import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** 输入框：6px 圆角，1px 边框，无阴影；焦点用 2px 软环（比 1px 实环更贴近原生观感） */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-sm border border-input bg-card px-2.5 text-xs text-foreground transition-colors',
        'placeholder:text-muted-foreground/60',
        'hover:border-input focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  );
}
