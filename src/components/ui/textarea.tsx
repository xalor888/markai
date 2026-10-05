import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * 文本域：6px 圆角，1px 边框，无阴影。
 * 正文 13px / 行高 20px —— 这是对话输入框，12px 在长输入时偏挤。
 */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-sm border border-input bg-card px-2.5 py-2 text-[13px] leading-5 text-foreground transition-colors',
        'placeholder:text-muted-foreground/60',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  );
}
