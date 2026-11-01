import { AlertTriangle } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/uiStore';

/**
 * 站内确认框：替代 `window.confirm`。
 *
 * 原生 confirm 在深色主题下是一块刺眼的白框、样式不可控、也无法在 e2e 里断言
 * （原生 dialog 会打断 CDP 流程）。这里用已有的 Dialog 组件，文案与危险色都能统一。
 */
export function ConfirmHost() {
  const req = useUIStore((s) => s.confirmRequest);
  const resolve = useUIStore((s) => s.resolveConfirm);
  const cancel = useUIStore((s) => s.cancelConfirm);

  return (
    <Dialog
      open={!!req}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      title={req?.title ?? ''}
      width="w-[380px]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={cancel}>
            取消
          </Button>
          <Button variant={req?.danger ? 'destructive' : 'default'} size="sm" onClick={resolve}>
            {req?.confirmText ?? '确定'}
          </Button>
        </>
      }
    >
      {req?.body && (
        <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
          {req.danger && (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
          )}
          <span className="min-w-0">{req.body}</span>
        </p>
      )}
    </Dialog>
  );
}
