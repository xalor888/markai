/**
 * 输入区扩展：发送图片。
 *
 * 三条入口：点按钮选文件、在输入框里粘贴、把文件拖进输入区。
 * 三者都走同一个 `prepareChatImage`（压缩 → 校验 → 预览），
 * 所以不会出现"粘贴能发、拖拽发不了"这种各写一套的偏差。
 *
 * 选中的图片先进入待发送区（可以删掉），随下一条消息一起发；
 * 发完自动清空——不把上一张图悄悄带到下一轮。
 */
import { ImagePlus, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import {
  CHAT_IMAGE_MAX_COUNT,
  prepareChatImage,
  type ChatImage,
} from '@/lib/ai/image-input';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** 一批文件里能收下几张：超过上限的部分直接丢弃并说明 */
async function acceptFiles(
  files: readonly File[],
  existing: readonly ChatImage[],
): Promise<{ next: ChatImage[]; rejected: number }> {
  const room = CHAT_IMAGE_MAX_COUNT - existing.length;
  if (room <= 0) return { next: [], rejected: files.length };
  const picked = files.filter((f) => f.type.startsWith('image/')).slice(0, room);
  const rejected = files.length - picked.length;
  const prepared: ChatImage[] = [];
  for (const file of picked) {
    const image = await prepareChatImage(file);
    if (image) prepared.push(image);
  }
  return { next: prepared, rejected: rejected + (picked.length - prepared.length) };
}

export function ComposerImageButton({
  disabled,
  images,
  onChange,
}: {
  disabled?: boolean;
  images: readonly ChatImage[];
  onChange: (next: ChatImage[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const add = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      setBusy(true);
      try {
        const { next, rejected } = await acceptFiles(files, images);
        if (next.length > 0) onChange([...images, ...next]);
        if (rejected > 0) {
          pushToast('有图片没有加上', {
            variant: 'destructive',
            description: `最多 ${CHAT_IMAGE_MAX_COUNT} 张、每张压缩后不超过 300KB。请换一张更小的图片。`,
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [images, onChange],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="composer-image-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void add(files);
        }}
      />
      <button
        type="button"
        disabled={disabled || busy || images.length >= CHAT_IMAGE_MAX_COUNT}
        onClick={() => inputRef.current?.click()}
        data-testid="composer-image"
        title={images.length >= CHAT_IMAGE_MAX_COUNT ? `最多 ${CHAT_IMAGE_MAX_COUNT} 张` : '发送图片'}
        aria-label="发送图片"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ImagePlus className={cn('h-3.5 w-3.5', busy && 'animate-pulse')} />
      </button>
    </>
  );
}

/** 待发送图片的缩略图条：可逐张删除，显示张数 */
export function ComposerImageStrip({
  images,
  onChange,
}: {
  images: readonly ChatImage[];
  onChange: (next: ChatImage[]) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div data-testid="composer-images" className="flex flex-wrap items-center gap-1.5 px-1 pt-1 pb-0.5">
      {images.map((image) => (
        <div
          key={image.id}
          data-testid="composer-image-item"
          className="group relative h-12 w-12 overflow-hidden rounded-md border border-border bg-muted"
          title={image.name}
        >
          <img src={image.dataUrl} alt={image.name} className="h-full w-full object-cover" />
          <button
            type="button"
            aria-label={`移除图片 ${image.name}`}
            data-testid="composer-image-remove"
            onClick={() => onChange(images.filter((i) => i.id !== image.id))}
            className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <span className="text-2xs text-muted-foreground">
        {images.length}/{CHAT_IMAGE_MAX_COUNT}
      </span>
    </div>
  );
}

/** 从粘贴/拖拽事件里取图片文件（过滤掉纯文本粘贴） */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'));
}

export { acceptFiles };
