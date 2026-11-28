/**
 * 背景图上传：把本地图片压到"长边 ≤ 1920、体积 ≤ 800KB"再存成 data URL。
 *
 * 为什么必须压：外观设置落的是 chrome.storage.local，配额只有几 MB；
 * 一张手机原图就有 4–8MB，直接存会把整个 storage 写满，连书签配置都存不进去。
 * 压缩只在设置页发生，侧边栏读到的永远是已经压好的 data URL。
 */
export const MAX_BACKGROUND_EDGE = 1920;
export const MAX_BACKGROUND_BYTES = 800 * 1024;

/** 等比缩到长边不超过 maxEdge；原图更小时不放大 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, maxEdge / longest);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** data URL 的实际字节数（base64 每 4 字符 3 字节，减去 = 填充） */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

type Bitmap = ImageBitmap | HTMLImageElement;

async function loadBitmap(file: File): Promise<Bitmap> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* Safari 对某些格式的 createImageBitmap 会拒绝，走 Image 回退 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('无法读取这张图片'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function compressImageFile(
  file: File,
  opts: { maxEdge?: number; maxBytes?: number } = {},
): Promise<string> {
  const maxEdge = opts.maxEdge ?? MAX_BACKGROUND_EDGE;
  const maxBytes = opts.maxBytes ?? MAX_BACKGROUND_BYTES;
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');

  const bitmap = await loadBitmap(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境不支持图片处理');

  let { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
  let quality = 0.86;
  let dataUrl = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    dataUrl = canvas.toDataURL('image/webp', quality);
    if (dataUrlByteLength(dataUrl) <= maxBytes) break;
    quality = Math.max(0.4, quality - 0.1);
    if (quality === 0.4 && width > 320 && height > 320) {
      width = Math.max(320, Math.round(width * 0.8));
      height = Math.max(320, Math.round(height * 0.8));
      quality = 0.72;
    }
  }
  if ('close' in bitmap) bitmap.close();
  if (!dataUrl.startsWith('data:image/')) throw new Error('图片编码失败');
  if (dataUrlByteLength(dataUrl) > maxBytes) {
    throw new Error('图片压缩后仍超过 800KB，请换一张更小的图片');
  }
  return dataUrl;
}
