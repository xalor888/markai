/**
 * 浮层退出动画的"占位"状态。
 *
 * 组件关闭时立刻 return null 就永远看不到退场动画。这里把卸载延后 exitMs：
 * 关闭瞬间切到 `data-state="closed"`（CSS 播 120ms 的反向动画），结束后再卸载。
 * 只用一个 setTimeout，不引动画库、不跑 rAF。
 */
import { useEffect, useRef, useState } from 'react';

export interface Presence {
  mounted: boolean;
  state: 'open' | 'closed';
}

export function usePresence(open: boolean, exitMs = 120): Presence {
  const [mounted, setMounted] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setMounted(false);
    }, exitMs);
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, exitMs, mounted]);

  return { mounted: mounted || open, state: open ? 'open' : 'closed' };
}
