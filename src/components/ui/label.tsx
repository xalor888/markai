import type { LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** 表单标签 */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('text-xs font-medium text-muted-foreground', className)} {...props} />
  );
}
