import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 复选框：4px 圆角、16px 命中区，选中态 Indigo；onCheckedChange 携带 Shift 状态（范围多选用） */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean, shiftKey?: boolean) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onCheckedChange(!checked, e.shiftKey);
      }}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border transition-colors disabled:pointer-events-none disabled:opacity-40',
        'focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none',
        checked ? 'border-accent bg-accent text-accent-foreground' : 'border-input bg-card hover:border-accent/60',
        className,
      )}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
}
