/**
 * 设置页「外观」分区。
 *
 * 一块设置卡片负责四件事：主题（明暗）、强调色、背景、玻璃/动效/密度。
 * 所有写入都走 `useAppearanceStore.update()`——不要在这里直接碰 storage：
 * 外观是多窗口共享状态，绕过 store 会让已打开的侧边栏收不到同步。
 *
 * 图片背景支持链接与本地文件；本地文件先压到长边 ≤1920、体积 ≤800KB，
 * 否则一张手机原图就能把 chrome.storage.local 写满（详见 lib/ui/image-upload）。
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Check, Image as ImageIcon, Palette, RotateCcw, Upload } from 'lucide-react';
import { SettingRow, SettingsSection } from '@/components/options/setting-primitives';
import { ThemeCards } from '@/components/options/config-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  ACCENT_PRESETS,
  BACKGROUND_OPTIONS,
  MOTION_OPTIONS,
  isSafeImageUrl,
  useAppearanceStore,
  type BackgroundKind,
} from '@/stores/appearanceStore';
import { compressImageFile } from '@/lib/ui/image-upload';
import { cn } from '@/lib/utils';

const DENSITY_OPTIONS: { id: 'compact' | 'cozy'; label: string; hint: string }[] = [
  { id: 'compact', label: '紧凑', hint: '侧边栏默认，一屏放更多行' },
  { id: 'cozy', label: '宽松', hint: '行距更大，适合触控与阅读' },
];

/** 单选控件通用外观：与 ThemeCards 的边框/选中态同一套 token */
function optionClass(selected: boolean): string {
  return cn(
    'flex items-center justify-center gap-1.5 rounded-sm border px-2 py-1.5 text-2xs transition-colors',
    selected
      ? 'border-accent/50 bg-accent-muted font-medium text-accent'
      : 'border-border text-muted-foreground hover:border-input hover:bg-muted/60 hover:text-foreground',
  );
}

export function AppearanceSettingsSection() {
  const accent = useAppearanceStore((s) => s.accent);
  const background = useAppearanceStore((s) => s.background);
  const backgroundImage = useAppearanceStore((s) => s.backgroundImage);
  const backgroundDim = useAppearanceStore((s) => s.backgroundDim);
  const glass = useAppearanceStore((s) => s.glass);
  const motion = useAppearanceStore((s) => s.motion);
  const density = useAppearanceStore((s) => s.density);
  const loaded = useAppearanceStore((s) => s.loaded);
  const load = useAppearanceStore((s) => s.load);
  const update = useAppearanceStore((s) => s.update);
  const reset = useAppearanceStore((s) => s.reset);

  const fileInputId = useId();
  const urlInputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickingImage, setPickingImage] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // 已存的远程链接回填到输入框；data URL 不回填（几万字符会把输入框撑爆）
  useEffect(() => {
    if (backgroundImage && !backgroundImage.startsWith('data:')) setImageUrl(backgroundImage);
  }, [backgroundImage]);

  const imageMode = background === 'image' || pickingImage;

  const applyUrl = () => {
    const value = imageUrl.trim();
    if (!value) {
      setImageError('请输入图片链接');
      return;
    }
    if (!isSafeImageUrl(value)) {
      setImageError('只接受 http(s) 图片链接，或直接从本地选择文件');
      return;
    }
    setImageError(null);
    setPickingImage(false);
    void update({ background: 'image', backgroundImage: value });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setImageError(null);
    setImageBusy(true);
    try {
      const dataUrl = await compressImageFile(file);
      setPickingImage(false);
      setImageUrl('');
      await update({ background: 'image', backgroundImage: dataUrl });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e));
    } finally {
      setImageBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const clearImage = () => {
    setImageUrl('');
    setPickingImage(false);
    setImageError(null);
    void update({ backgroundImage: '', background: 'aurora' });
  };

  const chooseBackground = (id: BackgroundKind) => {
    if (id === 'image') {
      // 没有合法图片时 normalizeAppearance 会把 image 回落到极光；
      // 所以先只展开控件，拿到图片后再提交 background='image'。
      setPickingImage(true);
      setImageError(null);
      return;
    }
    setPickingImage(false);
    setImageError(null);
    void update({ background: id });
  };

  return (
    <SettingsSection
      id="appearance"
      icon={Palette}
      title="外观"
      description="强调色、背景、玻璃与动效。改动即时生效，并同步到已打开的侧边栏。"
      keywords="外观 主题 颜色 强调色 背景 壁纸 图片 动效 动画 玻璃 密度 appearance theme glass wallpaper"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-2xs text-muted-foreground">写入本机；不会上传到任何服务器。</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="appearance-reset"
            aria-label="恢复默认外观"
            onClick={() => void reset()}
          >
            <RotateCcw className="h-3 w-3" />
            恢复默认
          </Button>
        </div>
      }
    >
      <SettingRow
        label="界面主题"
        keywords="主题 外观 theme dark light 系统"
        wide
        hint="跟随系统会随 macOS / Windows 的深浅模式自动切换。"
      >
        <ThemeCards />
      </SettingRow>

      <SettingRow
        label="强调色"
        keywords="强调色 主题色 accent 颜色 色板"
        wide
        hint="按钮、选中态与焦点环共用这一个颜色；语义色（成功/危险）不跟着变。"
      >
        <div role="radiogroup" aria-label="强调色" className="flex flex-wrap gap-1.5">
          {ACCENT_PRESETS.map((preset) => {
            const selected = accent === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`强调色：${preset.label}`}
                data-testid={`accent-${preset.id}`}
                onClick={() => void update({ accent: preset.id })}
                className={cn(optionClass(selected), 'mk-press pl-1.5')}
              >
                <span
                  aria-hidden="true"
                  className="h-3 w-3 rounded-full ring-1 ring-black/10"
                  style={{ background: preset.swatch }}
                />
                {preset.label}
                {selected && <Check className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow
        label="背景"
        keywords="背景 壁纸 极光 网格 图片 background wallpaper"
        wide
        hint="自定义图片会先压到长边 1920px、800KB 以内再保存。"
      >
        <div role="radiogroup" aria-label="背景样式" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {BACKGROUND_OPTIONS.map((opt) => {
            // 进入图片模式但还没落图时，其余选项不能同时显示为选中（radiogroup 只能有一个）
            const activeBackground: BackgroundKind = imageMode ? 'image' : background;
            const selected = opt.id === activeBackground;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`背景：${opt.label}`}
                title={opt.hint}
                data-testid={`background-${opt.id}`}
                onClick={() => chooseBackground(opt.id)}
                className={cn(optionClass(selected), 'mk-press flex-col gap-0.5 py-2')}
              >
                {opt.id === 'image' ? <ImageIcon className="h-3.5 w-3.5" /> : null}
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </SettingRow>

      {imageMode && (
        <SettingRow
          label="自定义背景图"
          htmlFor={urlInputId}
          keywords="图片 链接 上传 壁纸 image url upload"
          wide
          hint="可以粘贴图片链接，或从本地选一张图（本地图会压缩后存成 data URL）。"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Input
                id={urlInputId}
                type="url"
                value={imageUrl}
                placeholder="https://example.com/background.jpg"
                aria-label="背景图片链接"
                data-testid="appearance-image-url"
                onChange={(e) => setImageUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyUrl();
                  }
                }}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="appearance-image-apply"
                aria-label="应用图片链接"
                onClick={applyUrl}
              >
                应用
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileRef}
                id={fileInputId}
                type="file"
                accept="image/*"
                className="hidden"
                tabIndex={-1}
                aria-label="选择本地背景图片"
                data-testid="appearance-image-file"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                data-testid="appearance-image-upload"
                className={cn(
                  'mk-press inline-flex h-7 items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted',
                  imageBusy && 'pointer-events-none opacity-50',
                )}
                aria-label="选择本地背景图片"
              >
                <Upload className="h-3 w-3" />
                {imageBusy ? '压缩中…' : '选择本地图片'}
              </button>
              {backgroundImage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="appearance-image-clear"
                  aria-label="清除背景图片"
                  onClick={clearImage}
                >
                  清除图片
                </Button>
              )}
              {backgroundImage && (
                <span className="text-2xs text-muted-foreground">
                  {backgroundImage.startsWith('data:') ? '本地图片已就绪' : '已使用远程图片'}
                </span>
              )}
            </div>
            {imageError && (
              <p role="alert" data-testid="appearance-image-error" className="text-2xs text-destructive">
                {imageError}
              </p>
            )}
          </div>
        </SettingRow>
      )}

      <SettingRow
        label="背景压暗"
        keywords="压暗 暗度 遮罩 dim fade 背景"
        wide
        hint="图片/渐变越亮，小字越难读；这个值直接乘进遮罩。"
      >
        <div data-testid="appearance-dim-slider" className="flex items-center gap-3">
          <Slider
            id="appearance-dim"
            min={0}
            max={100}
            value={backgroundDim}
            onChange={(v) => void update({ backgroundDim: v })}
            aria-label="背景压暗程度"
            data-testid="appearance-dim"
            className="flex-1"
          />
          <span className="w-9 shrink-0 text-right text-2xs text-muted-foreground">{backgroundDim}%</span>
        </div>
      </SettingRow>

      <SettingRow
        label="玻璃强度"
        keywords="玻璃 模糊 透明度 glass blur 性能"
        wide
        hint="越高越透、模糊越重；0 = 近实心（弱机与省电场景）。"
      >
        <div data-testid="appearance-glass-slider" className="flex items-center gap-3">
          <Slider
            id="appearance-glass"
            min={0}
            max={100}
            value={glass}
            onChange={(v) => void update({ glass: v })}
            aria-label="玻璃强度"
            data-testid="appearance-glass"
            className="flex-1"
          />
          <span className="w-9 shrink-0 text-right text-2xs text-muted-foreground">{glass}%</span>
        </div>
      </SettingRow>

      <SettingRow label="动效" keywords="动效 动画 过渡 motion animation 减弱" wide hint="关闭后仍保留焦点环，不影响键盘操作。">
        <div role="radiogroup" aria-label="动效强度" className="grid grid-cols-3 gap-1.5">
          {MOTION_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={motion === opt.id}
              aria-label={`动效：${opt.label}`}
              title={opt.hint}
              data-testid={`motion-${opt.id}`}
              onClick={() => void update({ motion: opt.id })}
              className={cn(optionClass(motion === opt.id), 'mk-press')}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="界面密度" keywords="密度 紧凑 宽松 density compact cozy 行距" wide hint="只影响列表与设置行的间距，不改字号。">
        <div role="radiogroup" aria-label="界面密度" className="grid grid-cols-2 gap-1.5">
          {DENSITY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={density === opt.id}
              aria-label={`密度：${opt.label}`}
              title={opt.hint}
              data-testid={`density-${opt.id}`}
              onClick={() => void update({ density: opt.id })}
              className={cn(optionClass(density === opt.id), 'mk-press')}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label="预览"
        keywords="预览 preview 示例"
        wide
        hint="用真实组件片段（不是截图）：迷你侧栏 + 玻璃卡片 + 按钮。"
      >
        <div
          data-testid="appearance-preview"
          className="mk-glass-2 relative overflow-hidden rounded-lg border border-border p-2.5"
          style={{ '--mk-glass': glass / 100 } as CSSProperties}
        >
          <div className="mb-2 flex items-center justify-between text-2xs text-muted-foreground">
            <span className="font-medium text-foreground">预览</span>
            <span>
              {accent} · {density}
            </span>
          </div>
          <div className="flex gap-2">
            <div
              className="flex w-16 shrink-0 flex-col rounded-md border border-border bg-muted/35 p-1.5"
              style={{ gap: 'var(--mk-row-gap)' }}
            >
              {['书签栏', '最近', '标签'].map((label, i) => (
                <div
                  key={label}
                  className={cn(
                    'mk-hover-rail rounded-xs px-1 py-1 text-2xs',
                    i === 0 ? 'bg-accent-muted font-medium text-accent' : 'text-muted-foreground',
                  )}
                >
                  {label}
                </div>
              ))}
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="rounded-md border border-border bg-card px-2 py-1.5">
                <p className="text-2xs font-medium text-foreground">玻璃卡片</p>
                <p className="mt-0.5 text-2xs leading-4 text-muted-foreground">11px 小字也不会被模糊吃掉。</p>
              </div>
              <span
                role="presentation"
                className="mk-press rounded-sm bg-accent px-2 py-1 text-2xs font-medium text-accent-foreground"
              >
                强调色按钮
              </span>
            </div>
          </div>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
