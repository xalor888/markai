import { useEffect, useState } from 'react';
import { X, ArrowRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

const HINTED_KEY = 'markai.hinted.workspaceTour';

const STEPS: { title: string; body: string }[] = [
  {
    title: '整理记录在这里',
    body: '顶栏的「整理」按钮记录了自动整理把每条书签放到了哪。失败可以重试，不满意能一步撤销。',
  },
  {
    title: '连以前的也能收拾',
    body: '整理记录面板顶部的「补整理已有书签」会处理散落在根目录的旧书签——你手动搭好的分类不会被动。',
  },
  {
    title: '随时能退回去',
    body: 'Agent 每轮操作结束后，聊天面板头部会出现「↶ 撤销」；自动整理的每条记录也能单独撤销。',
  },
];

/**
 * 首次打开完整页时的三步提示条。
 *
 * 为什么是「底部一条」而不是遮罩高亮导览：顶栏那几个图标本来就不显眼，
 * 用遮罩把界面压暗、还要点三下才能用，对「我只想赶紧整理一下书签」的人是净负担。
 * 一条可跳过的横幅能说清同样的事，且不挡任何操作。
 *
 * 只显示一次（写 `markai.hinted.workspaceTour`），跳过与看完都算看过。
 */
export function OnboardingTip({ onGoOrganize }: { onGoOrganize?: () => void }) {
  /*
   * 告诉全局"底部有 40px 常驻条"。
   *
   * toast 是 `fixed bottom-4` 居中浮层，而这条引导条常驻在布局最底部，
   * 两者必然重叠——实测（430px 侧边栏）引导条 top=717 h=40，
   * toast 底边 741，重叠约 24px，正好盖住「整理记录在这里 1/3」那行字。
   * 这里把条的高度写进 CSS 变量，toast 据此抬高；卸载时移除，不留残留。
   */
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--markai-bottom-bar', '2.5rem'); // 与下面 h-10 保持一致
    return () => {
      root.style.removeProperty('--markai-bottom-bar');
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void chrome.storage.local
      .get(HINTED_KEY)
      .then((data) => {
        if (alive && data[HINTED_KEY] !== true) setVisible(true);
      })
      .catch(() => {
        /* 读不到就不打扰 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const finish = () => {
    setVisible(false);
    void chrome.storage.local.set({ [HINTED_KEY]: true }).catch(() => {});
  };

  if (!visible) return null;
  const current = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  return (
    /*
     * 40px 单行。重做前它是中栏底部一条 200px 高的"说明书"：占着主内容区、
     * 两行正文、还带"下一步 →"，一屏里同时压着列表和聊天两处内容。
     * 现在只占一行，正文收进 title（悬停可读），点「知道了」永久消失。
     */
    <div
      role="note"
      aria-label="新手提示"
      title={current.body}
      className="animate-fade-in flex h-10 shrink-0 items-center gap-2 border-t border-border bg-accent-muted/50 px-3"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-xs text-foreground">
        {current.title}
        <span className="ml-1.5 text-2xs text-muted-foreground/70">
          {step + 1}/{STEPS.length}
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-1">
        {onGoOrganize && isLast && (
          <button
            type="button"
            onClick={() => {
              finish();
              onGoOrganize();
            }}
            className="rounded-sm px-1.5 py-0.5 text-2xs text-accent transition-colors hover:bg-accent/10"
          >
            去看看
          </button>
        )}
        <button
          type="button"
          onClick={() => (isLast ? finish() : setStep((s) => s + 1))}
          className={cn(
            'flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs transition-colors',
            isLast ? 'bg-accent text-accent-foreground hover:opacity-90' : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {isLast ? '知道了' : '下一步'}
          {!isLast && <ArrowRight className="h-3 w-3" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={finish}
          aria-label="跳过新手提示"
          className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
