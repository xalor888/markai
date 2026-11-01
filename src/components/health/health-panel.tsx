import { AlertTriangle, CheckCircle2, ClipboardCopy, Loader2, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { copyText } from '@/lib/clipboard';
import { pushToast } from '@/lib/toast';
import { formatDiagnosticReport } from '@/lib/health/diagnostics';
import { runFixes } from '@/lib/health/fixes';
import { runHealthCheck } from '@/lib/health';
import { AREA_LABEL, SEVERITY_LABEL, type HealthReport, type Issue } from '@/lib/health/types';
import { cn } from '@/lib/utils';
import pkg from '../../../package.json';

/**
 * 健康检查面板。
 *
 * 它存在的理由：扩展出问题时，用户能看到的只有图标上一个红色感叹号，
 * 点开是一串英文栈——既看不出严重程度，也不知道该修还是该删。
 *
 * 这里把「是什么问题、要不要管、按哪个按钮」讲成人话；
 * 并且给一份可复制的诊断文本——贴过来就能定位，不用再靠猜。
 *
 * 关键约束（与 fixes.ts 一致）：**修复只动 MarkAI 自己的元数据，永不动用户的书签。**
 * 面板上凡是涉及书签的问题，都只给手动指引，不给自动修复按钮。
 */
export function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await runHealthCheck());
    } catch (e) {
      pushToast('健康检查没有跑起来', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, []);

  // 打开设置页就算一次：用户来这里往往就是因为"感觉不对"
  useEffect(() => {
    void check();
  }, [check]);

  const fixable = report?.issues.filter((i) => i.fix) ?? [];

  const fixAll = async () => {
    if (fixable.length === 0) return;
    setFixing(true);
    try {
      const results = await runFixes(fixable.map((i) => i.fix!.action));
      const okCount = results.filter((r) => r.result.ok).length;
      pushToast(okCount > 0 ? `已修复 ${okCount} 项` : '没有可自动修复的问题', {
        description: results.map((r) => r.result.detail).join('；').slice(0, 180),
        variant: okCount > 0 ? 'success' : 'default',
      });
      await check();
    } finally {
      setFixing(false);
    }
  };

  const fixOne = async (issue: Issue) => {
    if (!issue.fix) return;
    const r = await runFixes([issue.fix.action]);
    const first = r[0]?.result;
    pushToast(first?.ok ? '已修复' : '修复没有完成', {
      description: first?.detail,
      variant: first?.ok ? 'success' : 'destructive',
    });
    await check();
  };

  const copyReport = async () => {
    if (!report) return;
    const text = formatDiagnosticReport(report, {
      version: pkg.version,
      browser: navigator.userAgent,
    });
    await copyText(text, '诊断报告已复制');
  };

  const score = report?.score ?? 0;
  // 只用项目已有的语义色（accent / destructive / muted），不引入第二套色系
  const tone = score >= 90 ? 'text-accent' : score >= 70 ? 'text-foreground' : 'text-destructive';

  return (
    <div className="space-y-3">
      {/* 总分 + 动作 */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <div className="flex items-center gap-2">
          {report && report.issues.length === 0 ? (
            <ShieldCheck className={cn('h-5 w-5 shrink-0', tone)} aria-hidden="true" />
          ) : (
            <AlertTriangle className={cn('h-5 w-5 shrink-0', tone)} aria-hidden="true" />
          )}
          <div>
            <p className="text-sm font-semibold text-foreground">
              健康分 <span className={tone}>{report ? score : '—'}</span>
              <span className="text-xs font-normal text-muted-foreground">/100</span>
            </p>
            <p className="text-2xs text-muted-foreground">
              {busy
                ? '正在检查…'
                : report
                  ? report.issues.length === 0
                    ? '没有发现问题'
                    : `${report.issues.length} 个问题，其中 ${fixable.length} 个可一键修复`
                  : '尚未检查'}
            </p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 gap-1 text-2xs" onClick={() => void check()} disabled={busy}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            重新检查
          </Button>
          {fixable.length > 0 && (
            <Button size="sm" className="h-7 gap-1 text-2xs" onClick={() => void fixAll()} disabled={fixing}>
              {fixing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
              修复全部（{fixable.length}）
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-2xs" onClick={() => void copyReport()} disabled={!report}>
            <ClipboardCopy className="h-3 w-3" />
            复制诊断报告
          </Button>
        </div>
      </div>

      {/* 问题列表 */}
      {report && report.issues.length > 0 && (
        <ul className="divide-y divide-border/60">
          {report.issues.map((issue) => (
            <li key={issue.id} className="flex flex-wrap items-start gap-2 py-2.5">
              <span
                className={cn(
                  'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                  issue.severity === 'critical' || issue.severity === 'high'
                    ? 'bg-destructive'
                    : issue.severity === 'medium'
                      ? 'bg-foreground/40'
                      : 'bg-muted-foreground/40',
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
                  {issue.title}
                  <Badge variant="outline" className="h-4 px-1 text-2xs font-normal">
                    {AREA_LABEL[issue.area]} · {SEVERITY_LABEL[issue.severity]}
                  </Badge>
                </p>
                <p className="mt-0.5 text-2xs leading-4 text-muted-foreground">{issue.detail}</p>
                {issue.manualHint && (
                  <p className="mt-0.5 text-2xs leading-4 text-muted-foreground/80">→ {issue.manualHint}</p>
                )}
              </div>
              {issue.fix && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 shrink-0 gap-1 px-1.5 text-2xs"
                  onClick={() => void fixOne(issue)}
                  disabled={fixing}
                >
                  <Wrench className="h-3 w-3" />
                  {issue.fix.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {report && report.issues.length === 0 && (
        <p className="flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-3 py-2 text-2xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />
          配置、权限、撤销点、整理记录、书签结构都正常。
        </p>
      )}

      <p className="text-2xs leading-4 text-muted-foreground/70">
        修复只动 MarkAI 自己的配置与记录，<strong className="font-medium text-muted-foreground">不会移动或删除你的任何书签</strong>。
        涉及书签结构的问题只会在上面报告，由你决定怎么处理。
      </p>
    </div>
  );
}
