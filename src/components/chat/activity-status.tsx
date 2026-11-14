import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type Activity = {
  phase: 'connecting' | 'thinking' | 'streaming' | 'tool' | 'retrying';
  detail?: string;
  attempt?: number;
  startedAt: number;
};

/** 每秒刷新一次，只在组件挂载期间跑 interval（流结束就卸载） */
export function useElapsedSeconds(startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

const PHASE_LABEL: Record<Activity['phase'], string> = {
  connecting: '连接模型',
  thinking: '模型思考中',
  streaming: '生成中',
  tool: '调用工具',
  retrying: '重试中',
};

function labelOf(activity: Activity): string {
  if (activity.phase === 'tool' && activity.detail) return `调用 ${activity.detail}`;
  if (activity.phase === 'retrying' && activity.attempt) return `重试 ${activity.attempt}/5`;
  return PHASE_LABEL[activity.phase];
}

/**
 * Agent 头部状态：既说「在干什么」，也说「已经多久」。
 * 没有阶段事件时退回旧的「正在回复」，保证旧路径（非流式降级）也有反馈。
 */
export function ActivityStatus({ activity, streaming }: { activity: Activity | null; streaming: boolean }) {
  const seconds = useElapsedSeconds(activity?.startedAt);
  if (!activity) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 rounded-full', streaming ? 'animate-pulse bg-accent' : 'bg-success')} />
        <span className="hidden sm:inline">{streaming ? '正在回复' : '就绪'}</span>
      </span>
    );
  }
  const stalled = (activity.phase === 'connecting' || activity.phase === 'thinking') && seconds >= 20;
  return (
    <span
      className="flex min-w-0 shrink items-center gap-1 text-2xs text-muted-foreground"
      title={activity.detail ? `${labelOf(activity)}：${activity.detail}` : labelOf(activity)}
      data-testid="agent-activity"
      data-phase={activity.phase}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          activity.phase === 'retrying'
            ? 'bg-destructive'
            : activity.phase === 'streaming'
              ? 'bg-success'
              : 'animate-pulse bg-accent',
        )}
      />
      <span className="truncate">
        {labelOf(activity)}
        {seconds > 0 ? ` · ${seconds}s` : ''}
        {stalled ? (activity.phase === 'thinking' ? ' · 推理中' : ' · 仍在连接') : ''}
      </span>
    </span>
  );
}

/** 长时间没有任何增量时，在输入框上方给一条可操作的提示（并且真的能停止） */
export function StallBanner({ activity, onCancel }: { activity: Activity | null; onCancel: () => void }) {
  const seconds = useElapsedSeconds(activity?.startedAt);
  if (!activity) return null;
  const waiting = activity.phase === 'connecting' || activity.phase === 'thinking';
  // 思考中的模型本来就可能长时间不吐字，给它更长的宽限；连接阶段 30s 足够说明问题
  const threshold = activity.phase === 'thinking' ? 60 : 30;
  if (!waiting || seconds < threshold) return null;
  return (
    <div
      className="mb-1 flex items-center gap-2 rounded-md border border-accent/30 bg-accent-muted px-2.5 py-1.5 text-2xs text-foreground"
      data-testid="agent-stall"
    >
      <span className="min-w-0 flex-1">
        {activity.phase === 'thinking'
          ? `模型已经思考了 ${seconds} 秒，还没有输出。有些推理模型不会流式吐思考过程；这里会继续等，不会自动重试。`
          : `连接模型已经 ${seconds} 秒还没建立响应，可能是网络或网关问题。`}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded border border-accent/40 px-1.5 py-0.5 font-medium hover:bg-accent/10"
      >
        停止
      </button>
    </div>
  );
}
