/**
 * 设置页「点子」分区（占位）。
 *
 * 接上后：开关、主动程度、忽略的类别、历史点子的采纳率。
 */
import { Lightbulb } from 'lucide-react';
import { SettingsSection } from '@/components/options/setting-primitives';

export function IdeasSettingsSection() {
  return (
    <SettingsSection
      id="ideas"
      icon={Lightbulb}
      title="点子"
      description="让 Agent 主动观察书签库，提出可执行的整理点子。"
      keywords="点子 建议 主动 idea suggestion"
    >
      <div className="px-3 py-2.5 text-2xs text-muted-foreground">点子助手正在接入。</div>
    </SettingsSection>
  );
}
