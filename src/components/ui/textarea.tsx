import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** 文本域：4px 圆角，1px 边框，无阴影 */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-sm border border-input bg-card px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}
