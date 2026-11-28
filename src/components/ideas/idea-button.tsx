/**
 * 「点子」入口（顶栏）。
 *
 * 只负责打开面板；生成逻辑在 `lib/ideas/*`，面板内容在 `idea-panel.tsx`。
 */
import { Lightbulb } from 'lucide-react';
import { useIdeasStore } from '@/stores/ideasStore';

export function IdeaButton() {
  const openPanel = useIdeasStore((s) => s.openPanel);
  return (
    <button
      type="button"
      onClick={openPanel}
      data-testid="idea-entry"
      title="点子"
      aria-label="点子"
      className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Lightbulb className="h-3.5 w-3.5" />
    </button>
  );
}
