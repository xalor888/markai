import { Globe } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getHost, isSpecialUrl } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 域名首字母（中文域名取首字，纯数字主机取第一个字符） */
function initialOf(host: string): string {
  const clean = host.replace(/^www\./, '');
  const ch = clean.slice(0, 1);
  return ch ? ch.toUpperCase() : '?';
}

/**
 * 网站 favicon。
 *
 * **图标源是 Google 的 s2 服务**（`google.com/s2/favicons`）。这不是随手选的：
 * 换成 Chrome 自带的本地图标源 `/_favicon/` 试过一轮，**功能是坏的**——它只查本机
 * 浏览历史里的 favicon 缓存，没访问过的站点一律返回同一张 601 字节的默认灰球
 * （实测 github.com / Hacker News / 一个不存在的域名，三者返回的 PNG 字节完全相同）。
 * 而 `onLoad` 会照常触发，于是"首字母占位"被隐藏，整列变成一模一样的灰球——
 * 比没有图标更糟，因为再也分不出哪行是哪个站。
 *
 * **代价要如实说**：这个请求把**域名**发给 Google（不带标题、不带完整路径、
 * 不带收藏时间）。这件事已写进 `docs/privacy.md`，并有一条断言盯着它不得被删掉
 * （T99「favicon 的域名外发必须在隐私文档里有披露」）——承诺与实现必须对得上，
 * 无论选哪条路。
 *
 * 先给占位、再换真图：离线/被墙/加载慢时，原先的 `<img>` 会长时间空白，
 * 列表每行行首就是一个洞。现在立刻渲染「域名首字母」方块（有底色、有字重），
 * 图片加载成功后再覆盖上去：
 *  - 有网：几乎即时切换成站点图标；
 *  - 没网：稳定显示首字母，仍然能一眼区分不同站点；
 *  - chrome:// / about: 这类没有 favicon 的页面：地球图标（语义不同，不能用字母冒充站点）。
 */
export function Favicon({ url, size = 14, className }: { url?: string; size?: number; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const host = getHost(url);

  /**
   * 图标地址。**没有域名时返回空串**：那一格直接停在首字母占位，不发无意义的请求。
   * （域名外发这件事已在 `docs/privacy.md` 披露，并由 T99 守着不许删。）
   */
  const src = useMemo(
    () => (host ? `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}` : ''),
    [host],
  );

  // url 变化（如编辑网址后）重置状态，让新地址重新尝试加载
  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [url]);

  const special = !host || isSpecialUrl(url);
  const initial = useMemo(() => (host ? initialOf(host) : '?'), [host]);

  if (special) {
    return <Globe className={cn('shrink-0 text-muted-foreground', className)} style={{ width: size, height: size }} />;
  }

  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[3px]', className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* 占位层：图片没到之前先撑住这一格，避免行首出现空洞 */}
      {(!loaded || error) && (
        <span
          className="absolute inset-0 flex items-center justify-center bg-accent-muted font-semibold text-accent select-none"
          style={{ fontSize: Math.max(7, Math.round(size * 0.62)), lineHeight: 1 }}
        >
          {initial}
        </span>
      )}
      {!error && src !== '' && (
        <img
          src={src}
          width={size}
          height={size}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={cn(
            'relative shrink-0 rounded-[2px] transition-opacity duration-150',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </span>
  );
}
