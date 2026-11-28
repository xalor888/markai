/**
 * ── 宠物工作室 ──
 *
 * 左边一只真组件预览（不是截图），右边四组控件：轮廓 / 配色 / 配件 / 名字与口头禅。
 * 所有改动**即时生效**：预览与页面里那只宠物读的是同一个 store，
 * 不存在"先保存再看效果"。关掉面板就是完成，没有取消/保存两套语义。
 *
 * 一个刻意的克制：这里不做"上传图片当宠物"。造型是内联 SVG，零资源、任意尺寸清晰、
 * 深色主题自动换配色；引入位图会把这三条同时打破，而收益只是"更像贴纸"。
 */
import { useEffect, useState } from 'react';
import { Cat, Check, Palette, RotateCcw, Sparkles } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PetAvatar } from '@/components/pet/pet-avatar';
import { usePetStore, PET_SIZES, type PetSize } from '@/stores/petStore';
import { usePetStudioStore } from '@/stores/petStudioStore';
import {
  PET_ACCESSORIES,
  PET_ACCESSORY_LABELS,
  PET_CATCHPHRASE_MAX,
  PET_DEFAULT_DESIGN,
  PET_NAME_MAX,
  PET_PALETTES,
  PET_SPECIES,
  PET_SPECIES_LABELS,
  cleanPetText,
  isDefaultDesign,
  paletteById,
} from '@/lib/pet/design';
import { cn } from '@/lib/utils';

/** 预览的心情：让用户看到它不只是一个静止图标 */
const PREVIEW_STATES = ['idle', 'happy', 'thinking', 'proud'] as const;

export function PetStudio() {
  const open = usePetStudioStore((s) => s.open);
  const setOpen = usePetStudioStore((s) => s.setOpen);
  const design = usePetStore((s) => s.design);
  const size = usePetStore((s) => s.size);
  const update = usePetStore((s) => s.update);
  const [previewIdx, setPreviewIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setPreviewIdx((i) => (i + 1) % PREVIEW_STATES.length), 1_800);
    return () => window.clearInterval(timer);
  }, [open]);

  const patch = (next: Partial<typeof design>) => void update({ design: { ...design, ...next } });
  const palette = paletteById(design.palette);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="制作宠物"
      description="它是谁，由你决定。所有改动即时生效，直接关掉面板就是保存。"
      width="w-[520px]"
      testId="pet-studio"
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void update({ design: PET_DEFAULT_DESIGN })}
            disabled={isDefaultDesign(design)}
            data-testid="pet-studio-reset"
            aria-label="恢复默认造型"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复默认
          </Button>
          <Button size="sm" onClick={() => setOpen(false)} data-testid="pet-studio-done" aria-label="完成">
            <Check className="h-3.5 w-3.5" />
            完成
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        {/* 预览：底色跟着配色板走，用户能直接看出"这只在页面里是什么样" */}
        <div className="flex w-[132px] shrink-0 flex-col items-center gap-2">
          <div
            className="flex h-[132px] w-[132px] items-center justify-center rounded-lg border border-border"
            style={{
              background: `radial-gradient(120% 100% at 30% 0%, ${palette.bottom}22, transparent 62%), var(--card)`,
            }}
            data-testid="pet-studio-preview"
          >
            <PetAvatar
              state={PREVIEW_STATES[previewIdx] ?? 'idle'}
              size={96}
              follow={false}
              decorative
              design={design}
            />
          </div>
          <div className="text-center">
            <div className="truncate text-xs font-medium text-foreground">{design.name}</div>
            <div className="mt-0.5 text-2xs text-muted-foreground">
              {PET_SPECIES_LABELS[design.species]} · {palette.label}
            </div>
          </div>
          <div className="flex gap-1">
            {PET_SIZES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => void update({ size: candidate as PetSize })}
                className={cn(
                  'rounded-sm border px-1.5 py-0.5 text-2xs transition-colors',
                  size === candidate
                    ? 'border-accent/40 bg-accent-muted text-accent'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={size === candidate}
                aria-label={`宠物大小 ${candidate}`}
                data-testid={`pet-studio-size-${candidate}`}
              >
                {candidate === 48 ? '小' : candidate === 56 ? '中' : '大'}
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-3.5">
          <Field icon={Cat} label="轮廓">
            <div className="grid grid-cols-4 gap-1.5">
              {PET_SPECIES.map((species) => (
                <button
                  key={species}
                  type="button"
                  onClick={() => patch({ species })}
                  aria-pressed={design.species === species}
                  aria-label={`轮廓：${PET_SPECIES_LABELS[species]}`}
                  data-testid={`pet-studio-species-${species}`}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md border px-1 py-1.5 transition-colors',
                    design.species === species
                      ? 'border-accent/40 bg-accent-muted'
                      : 'border-border hover:border-input hover:bg-muted/40',
                  )}
                >
                  {/* 缩略图用同一个组件：选项和结果不可能长得不一样 */}
                  <PetAvatar
                    state="idle"
                    size={30}
                    follow={false}
                    decorative
                    design={{ ...design, species, accessory: 'none' }}
                  />
                  <span className="text-2xs text-muted-foreground">{PET_SPECIES_LABELS[species]}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field icon={Palette} label="配色">
            <div className="flex flex-wrap gap-1.5">
              {PET_PALETTES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => patch({ palette: p.id })}
                  aria-pressed={design.palette === p.id}
                  aria-label={`配色：${p.label}`}
                  title={p.label}
                  data-testid={`pet-studio-palette-${p.id}`}
                  className={cn(
                    'h-7 w-7 rounded-full border-2 transition-transform hover:scale-105',
                    design.palette === p.id ? 'border-accent ring-2 ring-accent/20' : 'border-border',
                  )}
                  style={{ background: `linear-gradient(150deg, ${p.top}, ${p.bottom})` }}
                />
              ))}
            </div>
          </Field>

          <Field icon={Sparkles} label="配件">
            <div className="flex flex-wrap gap-1.5">
              {PET_ACCESSORIES.map((accessory) => (
                <button
                  key={accessory}
                  type="button"
                  onClick={() => patch({ accessory })}
                  aria-pressed={design.accessory === accessory}
                  aria-label={`配件：${PET_ACCESSORY_LABELS[accessory]}`}
                  data-testid={`pet-studio-accessory-${accessory}`}
                  className={cn(
                    'rounded-sm border px-2 py-1 text-2xs transition-colors',
                    design.accessory === accessory
                      ? 'border-accent/40 bg-accent-muted text-accent'
                      : 'border-border text-muted-foreground hover:border-input hover:text-foreground',
                  )}
                >
                  {PET_ACCESSORY_LABELS[accessory]}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-2xs text-muted-foreground">名字</span>
              <Input
                value={design.name}
                maxLength={PET_NAME_MAX}
                onChange={(e) => patch({ name: cleanPetText(e.target.value, PET_NAME_MAX) })}
                placeholder="墨点"
                aria-label="宠物名字"
                data-testid="pet-studio-name"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-2xs text-muted-foreground">口头禅（双击时说）</span>
              <Input
                value={design.catchphrase}
                maxLength={PET_CATCHPHRASE_MAX}
                onChange={(e) => patch({ catchphrase: cleanPetText(e.target.value, PET_CATCHPHRASE_MAX) })}
                placeholder="留空则用它自己的台词"
                aria-label="宠物口头禅"
                data-testid="pet-studio-catchphrase"
              />
            </label>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1 text-2xs font-medium text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      {children}
    </div>
  );
}
