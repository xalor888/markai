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
      /* 底部居中：原来在右上角，正好压住 Agent 面板的标题与头部按钮（截图里能看到）。
         底部是唯一没有常驻操作区的位置，也不挡顶栏与输入框。 */
      /*
       * `bottom-4 + --markai-bottom-bar`：底部有常驻条（新手引导 40px）时自动抬高，
       * 没有时仍贴底 16px。早先写死 bottom-4，实测在 430px 侧边栏里
       * 与引导条重叠约 24px，把「整理记录在这里 1/3」那行字盖住了。
       */
      className="pointer-events-none fixed bottom-[calc(1rem+var(--markai-bottom-bar,0px))] left-1/2 z-[100] flex w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={cn(
            'pointer-events-auto cursor-pointer animate-slide-up rounded-lg border bg-card px-3 py-2.5 shadow-lg',
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
              <p className="text-xs font-semibold text-foreground">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-2xs leading-4 break-words text-muted-foreground">
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
