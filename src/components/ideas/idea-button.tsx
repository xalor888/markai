/**
 * 「点子」入口（顶栏）。
 *
 * 占位版只负责"打开点子面板"这个动作本身；面板内容由 `components/ideas/*` 提供。
 * 没装生成器时面板显示规则建议，所以这个入口在任何阶段都不会点出空白。
 */
import { Lightbulb } from 'lucide-react';
import { pushToast } from '@/lib/toast';

export function IdeaButton() {
  return (
    <button
      type="button"
      onClick={() =>
        pushToast('点子', { description: '点子面板正在接入：当前可在 Agent 面板看到规则建议。' })
      }
      data-testid="idea-entry"
      title="点子"
      aria-label="点子"
      className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Lightbulb className="h-3.5 w-3.5" />
    </button>
  );
}
