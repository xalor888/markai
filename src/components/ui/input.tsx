import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** 输入框：4px 圆角，1px 边框，无阴影 */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-sm border border-input bg-card px-2 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}
