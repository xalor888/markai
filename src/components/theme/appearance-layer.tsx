/**
 * 背景层 + 动效开关。
 *
 * 渲染一次、固定在所有内容之下（`-z-10`），不参与任何交互。
 * 之所以不用 `body::before`：扩展页面里 `body` 的背景会与主题 token 打架，
 * 而且"图片背景 + 压暗遮罩"需要两层元素才能既清晰又够读。
 */
import { useEffect } from 'react';
import { initAppearanceSync, useAppearanceStore } from '@/stores/appearanceStore';
import { cn } from '@/lib/utils';

export function AppearanceLayer() {
  const background = useAppearanceStore((s) => s.background);
  const dim = useAppearanceStore((s) => s.backgroundDim);
  const load = useAppearanceStore((s) => s.load);

  useEffect(() => {
    void load();
    return initAppearanceSync();
  }, [load]);

  if (background === 'none') return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        data-testid="appearance-background"
        className={cn(
          'absolute inset-0',
          background === 'aurora' && 'mk-bg-aurora',
          background === 'mesh' && 'mk-bg-mesh',
          background === 'image' && 'mk-bg-image',
        )}
        style={
          background === 'image'
            ? { backgroundImage: 'var(--mk-bg-image)', backgroundSize: 'cover', backgroundPosition: 'center' }
            : undefined
        }
      />
      {/* 压暗遮罩：图片/渐变上的 11px 小字要靠它才稳定达 AA */}
      <div
        className="absolute inset-0 bg-background"
        style={{ opacity: background === 'mesh' ? 0.86 : 0.35 + (dim / 100) * 0.55 }}
      />
    </div>
  );
}
