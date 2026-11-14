/**
 * ── 设置页的两种基本块：分区卡片 与 设置行 ──
 *
 * 旧版是「一条分隔线 + 三段竖排字段」：六个区各自裸露在同一个背景上，
 * 字段标签在上、控件在下、说明在最后。信息没错，但扫视时找不到边界——
 * 用户看到的是"一整根很长的表单"，而不是"几组可以分别理解的设置"。
 *
 * 这一版把结构显式化：
 *  - `SettingsSection`：一张卡片，头部有一个图标块 + 标题 + 一句"这块是干什么的"；
 *  - `SettingRow`：标签与说明在左、控件右对齐在固定列宽里，形成一个可扫视的列；
 *  - `ToggleRow`：布尔项整行就是一个开关，点击区域覆盖整行（不用瞄准小方块）。
 *
 * 视觉上仍沿用全站的"1px 边框 + 无阴影 + Slate"规范：这不是换皮，
 * 是把"分区 → 字段"的层级用边框、留白与对齐补回来。
 */

import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { SectionMatchContext, useSectionMatched, useSettingsSearch } from './settings-search';

export interface SettingsSectionProps {
  /** 锚点 id：左侧导航与 `options.html#ai` 这类链接都靠它 */
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  /** 一句话说明这一节在管什么（不是重复标题） */
  description?: string;
  /** 搜索别名：中文叫法 + 英文/术语（`api key base url`） */
  keywords?: string;
  badge?: ReactNode;
  /** 卡片底部操作条（例如「测试连接」） */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  keywords,
  badge,
  footer,
  children,
  className,
}: SettingsSectionProps) {
  const { query, match, reportSection } = useSettingsSearch();
  const sectionHit = !query || match(title, description, keywords);
  const ref = useRef<HTMLElement>(null);
  const [childHit, setChildHit] = useState(false);

  /*
   * 分区是否还有"命中但未渲染的行"。
   *
   * 只数 DOM 里剩下的 `[data-setting-row]`：未命中的行由 SettingRow 返回 null，
   * 所以"还有行"就等于"还有命中项"。layout effect 在绘制前完成，
   * 因此输入搜索词时不会先闪一下空卡片。
   */
  useLayoutEffect(() => {
    if (!query || sectionHit) {
      setChildHit(true);
      return;
    }
    setChildHit(Boolean(ref.current?.querySelector('[data-setting-row]')));
  }, [query, sectionHit]);

  const hidden = Boolean(query) && !sectionHit && !childHit;

  useLayoutEffect(() => {
    reportSection(id, !hidden);
  }, [id, hidden, reportSection]);

  return (
    <SectionMatchContext.Provider value={!query || sectionHit}>
      <section
        ref={ref as RefObject<HTMLElement>}
        id={id}
        hidden={hidden}
        data-settings-section={id}
        className={cn(
          'scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card',
          'transition-colors',
          className,
        )}
      >
        <header className="flex items-start gap-3 px-5 py-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-sm leading-5 font-semibold text-foreground">{title}</h2>
              {badge}
            </div>
            {description && (
              <p className="mt-1 text-2xs leading-4 text-muted-foreground">{description}</p>
            )}
          </div>
        </header>
        <div className="divide-y divide-border/60 border-t border-border/60">{children}</div>
        {footer && (
          <div className="border-t border-border/60 bg-muted/25 px-5 py-3">{footer}</div>
        )}
      </section>
    </SectionMatchContext.Provider>
  );
}

export interface SettingRowProps {
  label: string;
  /** 说明文字：为什么有这个开关 / 改了会发生什么 */
  hint?: ReactNode;
  htmlFor?: string;
  /** 搜索别名（标题之外的词，如 `模型 上下文 窗口 context`） */
  keywords?: string;
  /** 控件右侧的轻量操作（获取列表 / 刷新目录） */
  action?: ReactNode;
  /** 控件换行到标签下方（多行控件：请求头、滑块、记忆列表） */
  wide?: boolean;
  /** 覆盖右列宽度（默认 288px） */
  controlClassName?: string;
  children: ReactNode;
}

export function SettingRow({
  label,
  hint,
  htmlFor,
  keywords,
  action,
  wide = false,
  controlClassName,
  children,
}: SettingRowProps) {
  const { query, match } = useSettingsSearch();
  const inMatchedSection = useSectionMatched();
  const hit = match(label, keywords);
  // 分区标题命中时整节保留；否则逐行过滤（未命中返回 null，供分区统计剩余行数）
  if (query && !inMatchedSection && !hit) return null;

  const heading = (
    <div className="min-w-0">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </Label>
      {hint && <div className="mt-0.5 text-2xs leading-4 text-muted-foreground">{hint}</div>}
    </div>
  );

  return (
    <div
      data-setting-row
      className={cn(
        'px-5 py-3.5',
        wide
          ? 'flex flex-col gap-2.5'
          : 'flex flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-6',
      )}
    >
      {/*
       * 宽行（多行控件）把操作放到标题行右侧：否则它会掉到控件下方，
       * 和「实际发送」这类说明并排，看起来像给说明配了个按钮。
       */}
      {wide ? (
        <div className="flex items-start justify-between gap-3">
          {heading}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      ) : (
        heading
      )}
      <div
        className={cn(
          'flex min-w-0 items-center gap-2',
          !wide && 'sm:justify-self-end',
          !wide && (controlClassName ?? 'sm:w-72'),
          wide && 'w-full',
        )}
      >
        <div className="min-w-0 flex-1">{children}</div>
        {!wide && action}
      </div>
    </div>
  );
}

export interface ToggleRowProps {
  label: string;
  hint?: ReactNode;
  keywords?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** 子开关：缩进一层，表明它挂在上一个开关下面 */
  nested?: boolean;
}

export function ToggleRow({
  label,
  hint,
  keywords,
  checked,
  onCheckedChange,
  disabled,
  nested = false,
}: ToggleRowProps) {
  const { query, match } = useSettingsSearch();
  const inMatchedSection = useSectionMatched();
  const hit = match(label, keywords);
  const id = useId();
  if (query && !inMatchedSection && !hit) return null;

  // 整行可点：label 通过 htmlFor 关联到开关按钮，命中区不再只有 32×18 的小轨道
  return (
    <div
      data-setting-row
      className={cn('flex items-start gap-4 px-5 py-3.5', nested && 'pl-10')}
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </Label>
        {hint && <div className="mt-0.5 text-2xs leading-4 text-muted-foreground">{hint}</div>}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className="mt-0.5"
      />
    </div>
  );
}

/** 标签行右侧的轻量文字操作 */
export function InlineAction({
  onClick,
  disabled,
  busy,
  icon: Icon,
  children,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-2xs whitespace-nowrap text-accent transition-colors hover:bg-accent-muted disabled:pointer-events-none disabled:opacity-40"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      {children}
    </button>
  );
}
