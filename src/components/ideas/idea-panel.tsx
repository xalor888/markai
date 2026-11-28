/**
 * 「点子」面板：一个会观察书签库、能直接往下做事的个人 Agent 入口。
 *
 * 结构：抽屉（右侧滑入），三组——现在可做 / 需要 AI / 已忽略。
 *  · 「开始」= 把 prompt 发给 Agent 并关面板。点子不是终点，是"把这句话填进输入框"。
 *  · 「忽略」= 记入 7 天冷却，然后从当前列表移除（不刷新，避免整块跳动）。
 *  · 「刷新」= round+1 并清空冷却，重新生成。
 *
 * 为什么用自定义事件（`markai:agent-prompt`）而不是直接 import aiStore：
 * 面板可能挂在侧边栏/完整页两种容器里，而 Agent 的 send 需要容器上下文。
 * 事件让"谁发"和"谁执行"解耦，workspace 里只加一个监听即可。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Lightbulb, Loader2, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { useConfigStore } from '@/stores/configStore';
import { generateIdeas, hasIdeaGenerator, type Idea } from '@/lib/features/ideas';
import { clearSeenIdeas, markIdeaSeen } from '@/lib/ideas/register';
import { useIdeasStore } from '@/stores/ideasStore';
import { cn } from '@/lib/utils';

const EFFORT_LABEL: Record<Idea['effort'], string> = {
  quick: '很快',
  medium: '几分钟',
  deep: '需要一会儿',
};

/** 把 prompt 交给 workspace 的 Agent（workspace.tsx 里监听） */
function dispatchPrompt(prompt: string) {
  document.dispatchEvent(new CustomEvent('markai:agent-prompt', { detail: prompt }));
}

function IdeaCard({
  idea,
  onStart,
  onIgnore,
}: {
  idea: Idea;
  onStart: (idea: Idea) => void;
  onIgnore: (idea: Idea) => void;
}) {
  return (
    <article
      data-testid={`idea-card-${idea.id}`}
      className="group rounded-md border border-border bg-card p-2.5 transition-colors hover:border-accent/40"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded-sm bg-accent/10 p-1 text-accent">
          {idea.source === 'model' ? <Sparkles className="h-3 w-3" /> : <Lightbulb className="h-3 w-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs leading-4 font-medium">{idea.title}</h3>
          <p className="mt-0.5 text-2xs leading-4 text-muted-foreground">{idea.body}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground/80">
            {idea.count !== undefined && (
              <span className="rounded-sm bg-muted px-1 py-px tabular-nums">影响 {idea.count} 条</span>
            )}
            <span className="rounded-sm bg-muted px-1 py-px">{EFFORT_LABEL[idea.effort]}</span>
            {idea.source === 'model' && <span className="rounded-sm bg-accent/10 px-1 py-px text-accent">模型</span>}
          </div>
          {idea.evidence.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {idea.evidence.slice(0, 2).map((ev, i) => (
                <li key={i} className="text-2xs leading-4 text-muted-foreground/70">
                  · {ev.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="sm" onClick={() => onStart(idea)} data-testid={`idea-start-${idea.id}`} aria-label={`开始：${idea.title}`}>
          开始
          <ChevronRight className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onIgnore(idea)}
          data-testid={`idea-ignore-${idea.id}`}
          aria-label={`忽略：${idea.title}`}
        >
          忽略
        </Button>
      </div>
    </article>
  );
}

export function IdeaPanel() {
  const open = useIdeasStore((s) => s.open);
  const setOpen = useIdeasStore((s) => s.setOpen);
  const roots = useBookmarkStore((s) => s.roots);
  const config = useConfigStore((s) => s.config);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [ignored, setIgnored] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(false);
  const [round, setRound] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const aiReady = Boolean(config?.apiKey && config?.baseUrl && config?.model);

  const load = useCallback(
    async (nextRound: number) => {
      setLoading(true);
      setNote(null);
      try {
        const result = await generateIdeas({
          roots,
          habits: [],
          seenIds: [],
          round: nextRound,
        });
        setIdeas(result.ideas);
        if (result.note) setNote(result.note);
        if (result.ideas.length === 0 && !hasIdeaGenerator()) {
          setNote('点子助手未启用：当前只显示规则生成的建议。');
        }
      } finally {
        setLoading(false);
      }
    },
    [roots],
  );

  // 打开时才生成：不在后台常驻扫描全库，用户不看就不花这个 CPU
  useEffect(() => {
    if (open) void load(round);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const start = (idea: Idea) => {
    void markIdeaSeen(idea.id);
    setIdeas((prev) => prev.filter((i) => i.id !== idea.id));
    dispatchPrompt(idea.prompt);
    setOpen(false);
  };

  const ignore = (idea: Idea) => {
    void markIdeaSeen(idea.id);
    setIgnored((prev) => [idea, ...prev]);
    setIdeas((prev) => prev.filter((i) => i.id !== idea.id));
  };

  const refresh = async () => {
    await clearSeenIdeas();
    const next = round + 1;
    setRound(next);
    setIgnored([]);
    await load(next);
  };

  /*
   * 分组：规则点子（现在可做）/ 模型点子（需要 AI）——但模型点子也可能没有 AI 配置时不存在。
   * 「已忽略」是本次会话里忽略的，刷新后清空。
   */
  const { actionable, aiIdeas } = useMemo(() => {
    const actionable: Idea[] = [];
    const aiIdeas: Idea[] = [];
    for (const idea of ideas) (idea.source === 'model' ? aiIdeas : actionable).push(idea);
    return { actionable, aiIdeas };
  }, [ideas]);

  const clean = ideas.length === 0 && ignored.length === 0 && !loading;

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="点子"
      description="观察你的书签库，提几个现在就能做的事。点「开始」会让 Agent 接着做，删除仍需你确认。"
      width="w-[460px]"
      testId="idea-panel"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-2xs text-muted-foreground">
            {aiReady ? '规则 + 模型增强' : '未配置 AI：只显示规则点子'}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={loading}
              data-testid="idea-refresh"
              aria-label="刷新点子"
            >
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              刷新
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} data-testid="idea-close" aria-label="关闭点子面板">
              关闭
            </Button>
          </div>
        </div>
      }
    >
      <div className="max-h-[min(60vh,520px)] space-y-3 overflow-y-auto pr-0.5">
        {note && (
          <p className="rounded-sm border border-border bg-muted/40 px-2 py-1.5 text-2xs text-muted-foreground">{note}</p>
        )}

        {loading && ideas.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-2xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在看书签库…
          </div>
        ) : clean ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Sparkles className="h-6 w-6 text-accent/60" />
            <p className="text-xs font-medium">库很干净</p>
            <p className="max-w-[280px] text-2xs leading-4 text-muted-foreground">
              没有发现重复、空文件夹或长期未打开的书签。
            </p>
            <Button size="sm" variant="outline" onClick={() => void refresh()} data-testid="idea-scan-again" aria-label="再扫描一次">
              再扫描一次
            </Button>
          </div>
        ) : (
          <>
            {actionable.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">现在可做</h2>
                {actionable.map((idea) => (
                  <IdeaCard key={idea.id} idea={idea} onStart={start} onIgnore={ignore} />
                ))}
              </section>
            )}
            {aiIdeas.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">需要 AI</h2>
                {aiIdeas.map((idea) => (
                  <IdeaCard key={idea.id} idea={idea} onStart={start} onIgnore={ignore} />
                ))}
              </section>
            )}
            {ignored.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">已忽略</h2>
                {ignored.map((idea) => (
                  <div
                    key={idea.id}
                    className="flex items-center gap-2 rounded-sm border border-dashed border-border px-2 py-1.5"
                  >
                    <Trash2 className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{idea.title}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground/60">7 天内不再出现</span>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
