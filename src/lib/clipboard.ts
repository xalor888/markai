/** ── 剪贴板工具（navigator.clipboard 优先，失败降级 execCommand） ── */

import { pushToast } from './toast';

/** 复制文本到剪贴板，成功/失败均有反馈 */
export async function copyText(text: string, label = '已复制'): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      pushToast(label, { variant: 'success' });
      return true;
    }
    throw new Error('clipboard API 不可用');
  } catch {
    // 降级：隐藏 textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) {
        pushToast(label, { variant: 'success' });
        return true;
      }
    } catch {
      // 忽略
    }
    pushToast('复制失败', { variant: 'destructive' });
    return false;
  }
}
