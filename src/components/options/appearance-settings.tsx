/**
 * 设置页「外观」分区。
 *
 * 占位版只读展示当前外观（强调色 / 背景 / 动效），真正可编辑的控件
 * 由外观工作线替换本文件。保留同样的导出名，ConfigForm 不需要再改。
 */
import { Palette } from 'lucide-react';
import { SettingRow, SettingsSection } from '@/components/options/setting-primitives';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { ThemeCards } from '@/components/options/config-form';

export function AppearanceSettingsSection() {
  const accent = useAppearanceStore((s) => s.accent);
  const background = useAppearanceStore((s) => s.background);
  const motion = useAppearanceStore((s) => s.motion);

  return (
    <SettingsSection
      id="appearance"
      icon={Palette}
      title="外观"
      description="强调色、背景与动效。改动即时生效，并同步到已打开的侧边栏。"
      keywords="外观 主题 颜色 强调色 背景 壁纸 动效 动画 玻璃 appearance theme"
    >
      <SettingRow
        label="界面主题"
        keywords="主题 外观 theme dark light 系统"
        wide
        hint="跟随系统会随 macOS / Windows 的深浅模式自动切换。"
      >
        <ThemeCards />
      </SettingRow>
      <div className="px-3 py-2.5 text-2xs text-muted-foreground">
        当前：强调色 {accent} · 背景 {background} · 动效 {motion}
      </div>
    </SettingsSection>
  );
}
