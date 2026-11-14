/**
 * ── 书签库体检对话框：把"值得现在处理的事"摊开 ──
 *
 * 概览页给的是结论（2 组重复 / 3 个空文件夹），这里给证据与动作：
 *  - 重复链接：每组展示实际条目与所在路径（不是只报一个数字）；
 *  - 空文件夹：列出名字与路径，避免"清理空文件夹"变成一次盲操作；
 *  - 动作：交给 Agent 执行（仍然走计划/确认/可撤销），或复制清单自己处理。
 *
 * 这里**不直接删除任何东西**：对话框只负责把事实说清楚，写操作必须经过 Agent 的
 * 逐次确认与撤销记录。按钮文案也据此写成"让 Agent 合并"，而不是"立即合并"。
 */
import { useState } from 'react';
import { Globe, Layers, Merge, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { copyText } from '@/lib/clipboard';
import {
  describeDuplicates,
  pickDuplicateKeeper,
  type DuplicateKeepStrategy,
  type LibraryInsights,
} from '@/lib/bookmarks/insights';
import { cn } from '@/lib/utils';

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-base font-semibold tabular-nums',
          tone === 'danger' && value > 0 ? 'text-destructive' : 'text-foreground',
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function LibraryInsightsDialog({
  open,
  onOpenChange,
  insights,
  onAskAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insights: LibraryInsights;
  /** 把一句具体指令交给 Agent（对话框自身不写书签） */
  onAskAgent: (prompt: string) => void;
}) {
  const [keepStrategy, setKeepStrategy] = useState<DuplicateKeepStrategy>('oldest');
  /** 死链检查只覆盖前 N 条：全库一次性发几百个请求又慢又容易被站点限流 */
  const [deadLimit, setDeadLimit] = useState(25);
  const keepLabel = keepStrategy === 'oldest' ? '保留最早收藏' : '保留最近使用';
  const keepRule =
    keepStrategy === 'oldest'
      ? '优先保留收藏时间最早的那一条；没有收藏时间的条目不当作"最早"。'
      : '优先保留最近打开过的那一条；都没有打开记录时，退回收藏时间最新的那一条。';
  const mergePrompt =
    insights.duplicateGroups > 0
      ? `书签库里检测到 ${insights.duplicateGroups} 组重复链接（${insights.duplicateExtra} 条多余副本）。请按「${keepLabel}」策略合并：${keepRule} 先列出每组准备保留哪一条、其余哪些要删、理由是什么，再逐条确认执行；不要一次性自动删除。`
      : '';
  const cleanPrompt =
    insights.emptyFolders > 0
      ? `书签库里有 ${insights.emptyFolders} 个空文件夹。请列出它们的名字与路径，确认确实为空后逐条删除（只删空文件夹，不动任何书签）。`
      : '';
  const deepPrompt =
    insights.deepBookmarks > 0
      ? `书签库里有 ${insights.deepBookmarks} 条书签在第 4 层或更深（示例：${insights.deepSamples
          .slice(0, 3)
          .map((b) => `「${b.title}」在 ${b.path}`)
          .join('；')}）。请评估这些深层嵌套是否合理，给出扁平化方案（哪些提升到第 2 层、哪些保持），再逐条确认执行。`
      : '';
  const deadPrompt = `请检查当前书签库的失效链接：只检查前 ${deadLimit} 条（按当前排序），用 check_urls_bulk 分批（每批 5 个）检查，先给出失效清单与建议（删除 / 替换 / 保留），不要直接删除任何书签。`;
  const issueCount = insights.duplicateGroups + insights.emptyFolders + insights.deepBookmarks;
  const fixAllPrompt =
    issueCount > 0
      ? `书签库体检发现 ${issueCount} 处可改进：${insights.duplicateGroups} 组重复（${insights.duplicateExtra} 条多余）、${insights.emptyFolders} 个空文件夹、${insights.deepBookmarks} 条深层书签。请先给出一份修复计划，按风险从低到高排序（先清空文件夹、再合并重复、最后评估深层嵌套），写清每一步会动哪些书签；我确认后你再逐条执行，不要一次性批量删除。`
      : '';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="书签库体检"
      description="扫描结果只读：这里只列出事实，任何写操作都要你确认后才执行。"
      width="w-[560px]"
      testId="library-insights"
      footer={
        <>
          {issueCount > 0 && (
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onAskAgent(fixAllPrompt);
              }}
            >
              <Sparkles className="h-3 w-3" />
              生成修复计划
            </Button>
          )}
          {insights.duplicateGroups > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onAskAgent(mergePrompt);
              }}
            >
              <Merge className="h-3 w-3" />
              合并重复
            </Button>
          )}
          {insights.emptyFolders > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onAskAgent(cleanPrompt);
              }}
            >
              <Trash2 className="h-3 w-3" />
              清空文件夹
            </Button>
          )}
          <Button variant="ghost" size="sm" autoFocus onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="总书签" value={insights.total} />
          <Stat label="文件夹" value={insights.folders} />
          <Stat label="重复组" value={insights.duplicateGroups} tone="danger" />
          <Stat label="空文件夹" value={insights.emptyFolders} tone="danger" />
          <Stat label="深层书签" value={insights.deepBookmarks} tone="danger" />
        </div>

        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Merge className="h-3.5 w-3.5 text-accent" />
              重复链接
              {insights.duplicateGroups > 0 && (
                <Badge variant="outline">{insights.duplicateExtra} 条多余</Badge>
              )}
            </h3>
            {insights.duplicateGroups > 0 && (
              <button
                type="button"
                onClick={() => void copyText(describeDuplicates(insights), '重复清单已复制')}
                className="shrink-0 text-2xs text-accent transition-colors hover:underline"
              >
                复制清单
              </button>
            )}
          </div>
          <div className="mb-2 flex w-fit items-center rounded-lg bg-muted p-0.5" role="group" aria-label="重复合并策略">
            {(
              [
                ['oldest', '保留最早收藏'],
                ['recent', '保留最近使用'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={keepStrategy === value}
                onClick={() => setKeepStrategy(value)}
                className={cn(
                  'rounded-md px-2 py-1 text-2xs transition-colors',
                  keepStrategy === value
                    ? 'bg-card font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mb-1.5 text-2xs text-muted-foreground/70">
            建议会根据策略标在条目上；最近使用没有记录时，退回收藏时间。
          </p>
          {insights.duplicates.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-2xs text-muted-foreground">
              没有发现重复链接（同一条 URL 的锚点 / utm 参数 / 末尾斜杠不算不同页面）。
            </p>
          ) : (
            <ul className="max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
              {insights.duplicates.map((group) => {
                const keeper = pickDuplicateKeeper(group.items, keepStrategy);
                return (
                  <li key={group.key} className="rounded-lg border border-border bg-card px-3 py-2">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {group.items[0]!.title}
                      </p>
                      <Badge variant="outline">{group.items.length} 条</Badge>
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {group.items.map((item) => (
                        <li key={item.id} className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                          <span className="min-w-0 flex-1 truncate">
                            {item.path || '根目录'} · {item.url}
                          </span>
                          {keeper?.id === item.id && (
                            <span className="shrink-0 rounded-xs bg-accent-muted px-1 py-px text-accent">
                              建议保留
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          {insights.duplicateGroups > insights.duplicates.length && (
            <p className="mt-1 text-2xs text-muted-foreground/70">
              还有 {insights.duplicateGroups - insights.duplicates.length} 组未展开（交给 Agent 时会一次列全）。
            </p>
          )}
        </section>

        <section>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Trash2 className="h-3.5 w-3.5 text-accent" />
            空文件夹
            {insights.emptyFolders > 0 && <Badge variant="outline">{insights.emptyFolders} 个</Badge>}
          </h3>
          {insights.emptyFolderList.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-2xs text-muted-foreground">
              没有空文件夹。
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {insights.emptyFolderList.map((f) => (
                <li key={f.id} className="rounded-md border border-border bg-muted/40 px-2 py-1 text-2xs text-muted-foreground">
                  <span className="text-foreground">{f.title}</span>
                  <span className="ml-1 text-muted-foreground/60">{f.path || '根目录'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Layers className="h-3.5 w-3.5 text-accent" />
              深层嵌套
              {insights.deepBookmarks > 0 && (
                <Badge variant="outline">{insights.deepBookmarks} 条</Badge>
              )}
            </h3>
            {insights.deepBookmarks > 0 && (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onAskAgent(deepPrompt);
                }}
                className="shrink-0 text-2xs text-accent transition-colors hover:underline"
              >
                让 Agent 评估 →
              </button>
            )}
          </div>
          {insights.deepSamples.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-2xs text-muted-foreground">
              没有第 4 层或更深的书签（2–3 层是正常分类深度）。
            </p>
          ) : (
            <ul className="max-h-36 space-y-1 overflow-y-auto pr-0.5">
              {insights.deepSamples.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground">{item.title}</span>
                    <span className="block truncate text-2xs text-muted-foreground">{item.path}</span>
                  </span>
                  <Badge variant="outline">第 {item.depth} 层</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-border bg-muted/30 p-3">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Globe className="h-3.5 w-3.5 text-accent" />
            死链检查
          </h3>
          <p className="mt-1 text-2xs leading-4 text-muted-foreground">
            体检本身不发起网络请求（避免把一次查看变成全站抓取）。需要真实检查时交给 Agent：
            它会分批请求每个链接，先给失效清单与建议，不直接删除。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-2xs text-muted-foreground/70">只检查前</span>
            <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5" role="group" aria-label="死链检查条数">
              {[10, 25, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={deadLimit === n}
                  onClick={() => setDeadLimit(n)}
                  className={cn(
                    'rounded-sm px-2 py-0.5 text-2xs tabular-nums transition-colors',
                    deadLimit === n
                      ? 'bg-card font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="text-2xs text-muted-foreground/70">条</span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => {
                onOpenChange(false);
                onAskAgent(deadPrompt);
              }}
            >
              让 Agent 检查死链
            </Button>
          </div>
        </section>

        <p className="text-2xs leading-4 text-muted-foreground/70">
          数字来自当前书签树；刚整理过或有书签变动时，关闭重开会重新计算。
        </p>
      </div>
    </Dialog>
  );
}
