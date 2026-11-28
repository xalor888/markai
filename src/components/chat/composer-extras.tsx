/**
 * 输入区扩展：发送图片。
 *
 * 占位版只提供"选择图片"的入口与本地预览，不发送——因为模型侧的多模态协议
 * 由 `lib/ai/*` 统一改造，不能在一个按钮里偷偷拼一个各家端点都不认的格式。
 *
 * 真正的实现（选图 → 压缩 → 预览 → 随消息发出）接上后，ChatPanel 的调用方式不变。
 */
import { ImagePlus } from 'lucide-react';
import { pushToast } from '@/lib/toast';

export function ComposerImageButton({ disabled }: { disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() =>
        pushToast('发送图片', { description: '图片输入正在接入：当前可以先描述你要找的书签。' })
      }
      data-testid="composer-image"
      title="发送图片"
      aria-label="发送图片"
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <ImagePlus className="h-3.5 w-3.5" />
    </button>
  );
}
