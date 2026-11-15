/**
 * ── 设置页：宠物分区 ──
 *
 * 为什么单独一个文件：设置页主体（config-form）已经一千三百多行，
 * 而宠物设置**不写在 `markai.config` 里**（见 petStore 文件头），
 * 留在那边会让人误以为它属于 AI 配置，改配置时被顺手清掉。
 *
 * 预览用的是真实组件（`PetAvatar`），不是另画一张示意图：
 * 用户调大小、切主题时看到的就是页面里那一只，不存在"设置页好看、实际不一样"。
 */
import { useEffect, useState } from 'react';
import { Cat } from 'lucide-react';
import { SettingsSection, SettingRow, ToggleRow } from '@/components/options/setting-primitives';
import { PetAvatar } from '@/components/pet/pet-avatar';
import { PET_SIZES, usePetStore, type PetSize } from '@/stores/petStore';
import type { PetState } from '@/lib/pet/mood';
import { cn } from '@/lib/utils';

/** 预览用的心情轮播：让用户一眼看到"它会变脸"，而不是一个静止图标 */
const PREVIEW_STATES: PetState[] = ['idle', 'happy', 'thinking', 'working', 'worried', 'sleeping'];
const PREVIEW_INTERVAL_MS = 2_200;

export function PetSettingsSection() {
  const enabled = usePetStore((s) => s.enabled);
  const size = usePetStore((s) => s.size);
  const chatter = usePetStore((s) => s.chatter);
  const follow = usePetStore((s) => s.follow);
  const update = usePetStore((s) => s.update);

  const [previewIdx, setPreviewIdx] = useState(0);

  useEffect(() => {
    void usePetStore.getState().load();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(
      () => setPreviewIdx((i) => (i + 1) % PREVIEW_STATES.length),
      PREVIEW_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [enabled]);

  return (
    <SettingsSection
      id="pet"
      icon={Cat}
      title="宠物"
      description="书签精灵常驻在完整页与侧边栏的角落。它按真实状态换表情：在听、在想、在干活、被删东西吓到。"
      keywords="宠物 精灵 pet 动画 表情 眼睛 跟随 碎碎念 陪伴"
      badge={<span className="text-2xs text-muted-foreground">0 字节资源</span>}
      footer={
        <span className="text-2xs text-muted-foreground">
          造型是内联 SVG：任意尺寸都清晰，深色主题自动换配色，不加载任何图片。
        </span>
      }
    >
      <SettingRow
        label="预览"
        keywords="预览 宠物 精灵 表情 pet"
        wide
        hint={
          enabled
            ? '每 2 秒换一次心情。真实页面里由你的操作决定（输入、流式回复、工具调用、待删确认）。'
            : '宠物已隐藏——下面的开关打开即可让它回来。'
        }
      >
        <div className="flex items-center gap-4">
          <div
            className={cn(
              'pet-shell flex h-[92px] w-[92px] shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40',
              !enabled && 'opacity-40 grayscale',
            )}
          >
            <PetAvatar
              state={enabled ? PREVIEW_STATES[previewIdx] ?? 'idle' : 'sleeping'}
              size={64}
              follow={false}
              decorative
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PET_SIZES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => void update({ size: candidate as PetSize })}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-2xs transition-colors',
                  size === candidate
                    ? 'border-accent/40 bg-accent-muted text-accent'
                    : 'border-border bg-card text-muted-foreground hover:border-input hover:text-foreground',
                )}
                aria-pressed={size === candidate}
              >
                {candidate === 48 ? '小' : candidate === 56 ? '中' : '大'}
                <span className="ml-1 tabular-nums opacity-70">{candidate}</span>
              </button>
            ))}
          </div>
        </div>
      </SettingRow>

      <ToggleRow
        label="显示宠物"
        keywords="显示 宠物 开关 pet enable"
        checked={enabled}
        onCheckedChange={(v) => void update({ enabled: v })}
        hint={enabled ? '常驻在中栏左下角；不挡任何控件' : '已隐藏（聊天气泡里的建议不受影响）'}
      />
      <ToggleRow
        label="眼珠跟随指针"
        keywords="跟随 指针 眼睛 follow cursor"
        checked={follow}
        disabled={!enabled}
        onCheckedChange={(v) => void update({ follow: v })}
        hint={'关掉更省电，也不会有「被盯着」的压迫感'}
        nested
      />
      <ToggleRow
        label="主动碎碎念"
        keywords="碎碎念 说话 提示 chatter speak"
        checked={chatter}
        disabled={!enabled}
        onCheckedChange={(v) => void update({ chatter: v })}
        hint="有值得说的事才说：两次之间至少 90 秒，同一件事 30 分钟内不重复"
        nested
      />
    </SettingsSection>
  );
}
