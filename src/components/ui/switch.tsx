import { cn } from '@/lib/utils';

/**
 * 开关（Switch）。
 *
 * 设置页里布尔项用开关而不是复选框：复选框在"整行是一件事"的语境下
 * 看起来像待办清单的勾选（多选一项），而开关明确表达"这个行为开/关"。
 * 键位语义仍走 role="switch" + aria-checked，屏幕阅读器读作"开关，已打开"。
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  id,
  className,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none',
        checked ? 'border-accent bg-accent' : 'border-input bg-muted',
        disabled && 'pointer-events-none opacity-45',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full shadow-none transition-[left] duration-150',
          checked ? 'left-[16px] bg-accent-foreground' : 'left-[3px] bg-card',
        )}
      />
    </button>
  );
}
