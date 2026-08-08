import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useToastStore } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** Toast 视图：右上角堆叠，原生风格，自动消失 */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-3 right-3 z-[100] flex w-72 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={cn(
            'pointer-events-auto cursor-pointer animate-fade-in rounded-lg border bg-card px-3 py-2',
            t.variant === 'destructive' && 'border-destructive/40',
            t.variant === 'success' && 'border-success/40',
            t.variant === 'default' && 'border-border',
          )}
        >
          <div className="flex items-start gap-2">
            {t.variant === 'destructive' ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            ) : t.variant === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-[11px] leading-4 break-words text-muted-foreground">
                  {t.description}
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
