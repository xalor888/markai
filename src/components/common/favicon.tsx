import { Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getHost } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 网站 favicon（Google s2 服务，加载失败回退为地球图标） */
export function Favicon({ url, size = 14, className }: { url?: string; size?: number; className?: string }) {
  const [error, setError] = useState(false);
  const host = getHost(url);
  // url 变化（如编辑网址后）重置失败状态，让新地址重新尝试加载
  useEffect(() => {
    setError(false);
  }, [url]);
  // chrome:// / chrome-extension:// / about: 等特殊页面没有网站 favicon，直接回退
  const special = !host || /^(chrome|chrome-extension|about|edge|moz-extension):/i.test(url ?? '');
  if (special || error) {
    return <Globe className={cn('shrink-0 text-muted-foreground', className)} style={{ width: size, height: size }} />;
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setError(true)}
      className={cn('shrink-0 rounded-[2px]', className)}
    />
  );
}
