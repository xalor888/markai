/**
 * 「检查更新」入口（顶栏）。
 *
 * 这一版是**未接实现的占位**：按钮可点，但只说清"当前版本 + 检查方式还没接"。
 * 真正的检查逻辑由 `lib/update/*` 提供，挂上后这里换成真实状态机
 * （检查中 / 已是最新 / 有新版本 / 失败原因）。
 *
 * 为什么先放占位而不是干脆不放：更新是用户明确要求的能力，
 * 一个"点了有回应"的入口比一个"根本没出现"的入口更接近完成态。
 */
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { appVersion } from '@/lib/version';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function UpdateCheckButton() {
  const [busy, setBusy] = useState(false);

  const check = async () => {
    if (busy) return;
    setBusy(true);
    try {
      pushToast('检查更新', { description: `当前版本 ${appVersion()}；自动更新通道尚未接入。` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void check()}
      data-testid="update-check"
      title="检查更新"
      aria-label="检查更新"
      className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
    </button>
  );
}
