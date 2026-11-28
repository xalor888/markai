/**
 * 设置页「对外接口」分区（占位）。
 *
 * 接上后：开关、端口、token 生成/复制、允许的写操作、审计日志。
 */
import { Plug } from 'lucide-react';
import { SettingsSection } from '@/components/options/setting-primitives';

export function ExternalSettingsSection() {
  return (
    <SettingsSection
      id="external"
      icon={Plug}
      title="对外接口"
      description="让外部 Agent（MCP / CLI / Skills）在授权后读取与整理书签。"
      keywords="MCP CLI 接口 外部 agent 集成 external api"
    >
      <div className="px-3 py-2.5 text-2xs text-muted-foreground">对外接口正在接入。</div>
    </SettingsSection>
  );
}
