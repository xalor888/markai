import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'outline' | 'accent' | 'destructive' | 'success';

const variantClasses: Record<Variant, string> = {
  default: 'bg-muted text-muted-foreground',
  outline: 'border border-border text-foreground',
  accent: 'border border-accent/30 bg-accent-muted text-accent',
  destructive: 'border border-destructive/30 bg-destructive/10 text-destructive',
  success: 'border border-success/30 bg-success/10 text-success',
};

/** 徽标：信息密度高的小标签 */
export function Badge({
  className,
  variant = 'default',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] leading-4 font-normal whitespace-nowrap',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
