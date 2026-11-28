/**
 * 设置页「点子」分区。
 *
 * 这里只放**用户能改变行为**的两件事：点子从哪来、冷却表占了多少。
 * 没有"主动程度"滑块：规则点子是本地确定性扫描，不需要调参；
 * 模型增强的开关已经由「AI 服务」那一节统一管，重复放一个只会让人以为有两套。
 */
import { useCallback, useEffect, useState } from 'react';
import { Lightbulb, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingRow, SettingsSection } from '@/components/options/setting-primitives';
import { useConfigStore } from '@/stores/configStore';
import { clearSeenIdeas, readSeenCount } from '@/lib/ideas/register';
import { IDEA_COOLDOWN_MS } from '@/lib/ideas/rules';

const COOLDOWN_DAYS = Math.round(IDEA_COOLDOWN_MS / (24 * 60 * 60 * 1000));

export function IdeasSettingsSection() {
  const config = useConfigStore((s) => s.config);
  const [seenCount, setSeenCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const aiReady = Boolean(config?.apiKey && config?.baseUrl && config?.model);

  const reload = useCallback(() => {
    void readSeenCount().then(setSeenCount);
  }, []);

  useEffect(reload, [reload]);

  const reset = async () => {
    setBusy(true);
    try {
      await clearSeenIdeas();
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="ideas"
      icon={Lightbulb}
      title="点子"
      description="观察书签库，提几个现在就能做的事。规则点子永远可用，模型只做增强。"
      keywords="点子 建议 主动 idea suggestion 冷却 忽略"
    >
      <SettingRow
        label="点子来源"
        keywords="来源 规则 模型 AI 增强"
        hint={
          aiReady
            ? '规则 + 模型增强：规则先出结果，模型最多再补 3 条；模型失败只会少一部分，不会让面板空白。'
            : '当前只显示规则点子（老旧、重复、空文件夹、散落、断链、未分类）。配好 AI 服务后会额外补模型点子。'
        }
        action={
          <span
            className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
            data-testid="ideas-source"
          >
            {aiReady ? '规则 + 模型' : '仅规则'}
          </span>
        }
      >
        <p className="text-2xs leading-4 text-muted-foreground">
          每条点子都带真实统计与样本书签 id，点开就能核对；「开始」只是把指令填进 Agent 输入框。
        </p>
      </SettingRow>

      <SettingRow
        label="冷却表"
        keywords="冷却 忽略 已处理 重置 reset"
        hint={`忽略或开始过的点子 ${COOLDOWN_DAYS} 天内不再出现。清空后，下次打开面板会重新看到全部。`}
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || seenCount === 0}
            onClick={() => void reset()}
            aria-label="清空点子冷却表"
            data-testid="ideas-reset-cooldown"
          >
            <RotateCcw className="h-3 w-3" />
            清空
          </Button>
        }
      >
        <p className="text-2xs text-muted-foreground" data-testid="ideas-seen-count">
          {seenCount === null ? '正在读取…' : seenCount === 0 ? '还没有忽略或开始过任何点子。' : `${seenCount} 条仍在冷却期内。`}
        </p>
      </SettingRow>

      <SettingRow
        label="删除永远需要确认"
        keywords="删除 安全 确认 闸门"
        hint="点子与简单清理只会生成指令或暂存方案；真正删除仍走「待删清单」或暂存卡片，由你确认。"
      >
        <p className="text-2xs text-muted-foreground">
          这一节没有「直接删」开关：点子只能把可改的指令填进输入框，清理只能生成待确认方案。
        </p>
      </SettingRow>
    </SettingsSection>
  );
}
