import { X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * 模态对话框：无阴影，靠 1px 边框 + 遮罩分层。
 * 容器圆角 8px（rounded-lg），符合"容器上限 8px"规范。
 * 原生行为：Esc 关闭、背景滚动锁定、焦点陷阱（Tab 循环）。
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'w-[420px]',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc 关闭 + 锁定背景滚动 + 打开聚焦面板 + 关闭还原焦点（原生对话框行为）
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const onKey = (e: globalThis.KeyboardEvent) => {
      // IME 组合输入中按 Esc（取消拼音候选）不应关闭对话框
      if (e.isComposing) return;
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    // 打开时聚焦：子组件声明了 autoFocus（如"取消"按钮）则优先聚焦它，
    // 否则聚焦面板（键盘用户直接进入对话框）
    const auto = panelRef.current?.querySelector<HTMLElement>('[autofocus]');
    if (auto) auto.focus();
    else panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      // 关闭后焦点还给触发元素（键盘用户保持操作位置）
      prevFocus?.focus();
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  /** 焦点陷阱：Tab / Shift+Tab 在对话框内循环 */
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusables = panelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/25" onClick={() => onOpenChange(false)} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className={cn('animate-scale-in relative max-w-[calc(100vw-32px)] rounded-lg border border-border bg-card p-4 outline-none', width)}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-foreground">{title}</h2>
            {description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={description}>
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {children}
        {footer && <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
