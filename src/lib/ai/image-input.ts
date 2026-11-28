/**
 * ── 聊天图片输入：压缩、校验、转成 API 多模态片段 ──
 *
 * 三条约束：
 *  1. **体积**：图片会随消息落进 `chrome.storage.local`（整份配额 10 MiB），
 *     聊天预算只有 6 MiB。原图（4–8 MB）一张就能把对话记录挤爆，
 *     所以进内存前必须先压到长边 1024、体积 300KB 以内。
 *  2. **条数**：一轮最多 3 张。再多既超预算，模型也看不过来。
 *  3. **协议**：只发 OpenAI 兼容的 `image_url`（data URL 内联）。
 *     不发 base64 顶层字段、不发 Anthropic 的 `source`——那些端点会 400。
 *
 * 压缩失败/格式不支持时**明确报错**，不静默换成"图片已附带"的假象。
 */
import { compressImageFile, dataUrlByteLength } from '@/lib/ui/image-upload';

/** 聊天图片长边上限：够看清截图里的字，又不至于把预算吃光 */
export const CHAT_IMAGE_MAX_EDGE = 1024;
/** 单张上限：3 张 × 300KB ≈ 900KB，落在 6 MiB 聊天预算内 */
export const CHAT_IMAGE_MAX_BYTES = 300 * 1024;
/** 一轮最多几张 */
export const CHAT_IMAGE_MAX_COUNT = 3;

export interface ChatImage {
  id: string;
  /** `data:image/webp;base64,...` */
  dataUrl: string;
  /** 原始文件名（只用于界面展示与历史占位，不发给模型） */
  name: string;
  /** 压缩后的像素尺寸，用于界面预留高度、避免加载时跳动 */
  width: number;
  height: number;
}

/** OpenAI 兼容的多模态内容片段 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

function imageSizeOf(dataUrl: string): { width: number; height: number } {
  // 压缩函数按最长边等比缩放；这里不需要真实解码，只给界面一个稳定比例。
  return { width: CHAT_IMAGE_MAX_EDGE, height: CHAT_IMAGE_MAX_EDGE };
}

/** 读图片的真实宽高（用于气泡里的比例占位）；失败时退回方形 */
async function measure(dataUrl: string): Promise<{ width: number; height: number }> {
  if (typeof Image === 'undefined') return imageSizeOf(dataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => resolve(imageSizeOf(dataUrl));
    img.src = dataUrl;
  });
}

let imageSeq = 0;

/**
 * 把用户选中的文件压成可发送的图片。
 *
 * 返回 `null` 表示这张不能收（非图片 / 压缩后仍超限），调用方据此提示，
 * 不要把它当成"加进去了但看不见"。
 */
export async function prepareChatImage(file: File): Promise<ChatImage | null> {
  if (!file.type.startsWith('image/')) return null;
  let dataUrl: string;
  try {
    dataUrl = await compressImageFile(file, {
      maxEdge: CHAT_IMAGE_MAX_EDGE,
      maxBytes: CHAT_IMAGE_MAX_BYTES,
    });
  } catch {
    return null;
  }
  if (dataUrlByteLength(dataUrl) > CHAT_IMAGE_MAX_BYTES) return null;
  const size = await measure(dataUrl);
  imageSeq += 1;
  return {
    id: `img-${Date.now().toString(36)}-${imageSeq}`,
    dataUrl,
    name: file.name || '粘贴的图片',
    ...size,
  };
}

/**
 * 拼成一条 user 消息的内容。
 *
 * 纯文本时返回字符串（保持与旧端点/旧测试的兼容）；带图片时才用数组，
 * 且**文本在前**：部分网关只读第一个 text 片段来生成会话标题。
 */
export function buildUserContent(text: string, images?: readonly ChatImage[]): string | ContentPart[] {
  if (!images || images.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } });
  }
  // 只有图片没有文字：给模型一句明确的任务，避免它回"你想让我做什么"
  if (!text) parts.unshift({ type: 'text', text: '请看这张图片，并结合我的书签库回答。' });
  return parts;
}

/** 历史里不再重发的图片，用一行文字保留"当时附过图"的事实 */
export function imagePlaceholder(images: readonly ChatImage[]): string {
  return images.map((i) => `[附图：${i.name}]`).join(' ');
}

/** 从消息里取可发送的图片（老版本数据没有该字段） */
export function imagesOf(message: { images?: ChatImage[] }): ChatImage[] {
  return Array.isArray(message.images) ? message.images.filter((i) => !!i?.dataUrl) : [];
}
