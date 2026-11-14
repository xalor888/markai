/**
 * ── 设置页外壳：左侧分区导航 / ⌘K 搜索 / 自动保存状态 / 主题 ──
 *
 * 为什么重写外壳而不只是"再调一下卡片圆角"：
 * 旧版是「顶部一条 header + 页面中间一根 max-w-5xl 的柱子 + 左侧 176px 的锚点列表」。
 * 它的问题不在配色，而在**结构**——
 *   · 导航跟着页面一起滚，翻到第 8 节时导航已经不在视野里，想跳回去只能往上滚；
 *   · 顶部那条品牌 header 占了 60px，却只显示一个 logo（信息密度接近于零）；
 *   · 没有搜索。30 多个字段里找一个「自动压缩阈值」，只能靠肉眼扫。
 *
 * 这一版把设置页做成一个**固定的应用外壳**（这也是主流设置界面的共同结构）：
 *   侧栏（品牌 / 搜索 / 分区 / 主题与版本）　+　右侧独立滚动区（页头 + 内容）
 * 导航永远在，内容自己滚；搜索直接过滤字段，而不是把用户扔进 30 行表单里找。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Check,
  Database,
  Monitor,
  Moon,
  Palette,
  Plug,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  X,
  Zap,
  Keyboard,
} from 'lucide-react';
import { BrandMark } from '@/components/theme/theme-provider';
import { useConfigStore } from '@/stores/configStore';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { appVersion } from '@/lib/version';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';
import { SettingsSearchProvider } from './settings-search';

export interface SettingsSectionMeta {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: 'connection' | 'agent' | 'personal';
}

/** 分区清单：导航、搜索计数、滚动高亮都以这一份为唯一来源 */
export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: 'health', label: '健康检查', icon: ShieldCheck, group: 'connection' },
  { id: 'ai', label: 'AI 服务', icon: Plug, group: 'connection' },
  { id: 'context', label: '上下文与预算', icon: SlidersHorizontal, group: 'connection' },
  { id: 'agent', label: 'Agent 行为', icon: Zap, group: 'agent' },
  { id: 'memory', label: '长期记忆', icon: Brain, group: 'agent' },
  { id: 'personalize', label: '个性化', icon: Sparkles, group: 'agent' },
  { id: 'appearance', label: '外观', icon: Palette, group: 'personal' },
  { id: 'data', label: '数据管理', icon: Database, group: 'personal' },
];

const GROUPS: Array<{ id: SettingsSectionMeta['group']; label: string }> = [
  { id: 'connection', label: '模型与连接' },
  { id: 'agent', label: 'Agent' },
  { id: 'personal', label: '外观与数据' },
];

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>(SETTINGS_SECTIONS[0]!.id);
  /** 分区可见性（各 Section 渲染后上报；搜索时驱动导航淡化与空状态） */
  const [visibleSections, setVisibleSections] = useState<Record<string, boolean>>({});
  const [matchCount, setMatchCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingJump = useRef<string | null>(null);
  const saveError = useConfigStore((s) => s.saveError);

  const activeMeta = useMemo(
    () => SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0]!,
    [activeId],
  );

  const reportSection = (id: string, visible: boolean) => {
    setVisibleSections((prev) => (prev[id] === visible ? prev : { ...prev, [id]: visible }));
  };

  /* ── 滚动高亮：以滚动容器上沿为基准，取"最后一个越过上沿的分区" ── */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const compute = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top + 96;
      let current = '';
      for (const s of SETTINGS_SECTIONS) {
        const node = document.getElementById(s.id);
        if (!node || node.hidden) continue;
        if (node.getBoundingClientRect().top <= top) current = s.id;
        else if (!current) current = s.id;
      }
      if (current) setActiveId(current);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(compute);
    };
    compute();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  /* ── 查询变化后，高亮回到第一个可见分区；一个都不剩时清空高亮（别让隐藏项还挂着选中底） ── */
  useEffect(() => {
    if (!query) return;
    const first = SETTINGS_SECTIONS.find((s) => visibleSections[s.id]);
    setActiveId(first ? first.id : '');
  }, [query, visibleSections]);

  /* ── 搜索命中行数（未命中的行由 SettingRow 直接不渲染，所以数到的就是命中项） ── */
  useEffect(() => {
    const t = setTimeout(() => {
      setMatchCount(document.querySelectorAll('[data-setting-row]').length);
    }, 0);
    return () => clearTimeout(t);
  }, [query, visibleSections]);

  /* ── ⌘K / `/` 聚焦搜索，Esc 清空 ── */
  useEffect(() => {
    const isEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === '/' && !isEditable(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ── 深链接（options.html#health）：分区在配置载入后才出现，所以要重试几次 ── */
  useEffect(() => {
    const target = window.location.hash.replace('#', '');
    if (!target) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(target);
      if (el && !el.hidden) {
        el.scrollIntoView({ block: 'start' });
        setActiveId(target);
        clearInterval(timer);
      } else if (++tries > 30) {
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  /** 跳转：搜索中先清空查询，等分区重新出现后再滚 */
  const jumpTo = (id: string) => {
    if (query) {
      pendingJump.current = id;
      setQuery('');
      return;
    }
    const el = document.getElementById(id);
    if (el && !el.hidden) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActiveId(id);
    }
  };

  useEffect(() => {
    if (query || !pendingJump.current) return;
    const id = pendingJump.current;
    pendingJump.current = null;
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el || el.hidden) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActiveId(id);
    });
  }, [query]);

  const reported = Object.keys(visibleSections).length;
  const anyVisible = SETTINGS_SECTIONS.some((s) => visibleSections[s.id]);
  const noMatch = Boolean(query) && reported > 0 && !anyVisible;

  const isDimmed = (id: string) => Boolean(query) && visibleSections[id] === false;

  const compactNav = SETTINGS_SECTIONS.map((s) => {
    const Icon = s.icon;
    return (
      <a
        key={s.id}
        href={`#${s.id}`}
        onClick={(e) => {
          e.preventDefault();
          jumpTo(s.id);
        }}
        data-nav-id={s.id}
        data-active={String(s.id === activeId)}
        className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-2xs font-medium whitespace-nowrap transition-colors',
          s.id === activeId
            ? 'border-accent/30 bg-accent-muted text-accent'
            : 'border-border bg-card text-muted-foreground hover:text-foreground',
          isDimmed(s.id) && 'opacity-40',
        )}
      >
        <Icon className="h-3 w-3" />
        {s.label}
      </a>
    );
  });

  return (
    <SettingsSearchProvider
      query={query}
      visibleSections={visibleSections}
      reportSection={reportSection}
    >
      <div className="flex h-full min-h-0 bg-background">
        {/* ── 侧栏（桌面） ── */}
        <aside className="hidden h-full w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
          <div className="px-5 pt-5 pb-4">
            <BrandMark />
            <p className="mt-1.5 text-2xs text-muted-foreground">书签管家 Agent · 设置</p>
          </div>

          <div className="px-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索设置"
                aria-label="搜索设置"
                spellCheck={false}
                className={cn(
                  'h-8 w-full rounded-md border border-border bg-background pr-14 pl-8 text-xs text-foreground transition-colors',
                  'placeholder:text-muted-foreground/70',
                  'hover:border-input focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none',
                )}
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  aria-label="清空搜索"
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-xs p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : (
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-xs border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-foreground">
                  {IS_MAC ? '⌘K' : 'Ctrl K'}
                </span>
              )}
            </div>
          </div>

          <div className="mt-4 flex-1 overflow-y-auto px-2 pb-4">
            <nav aria-label="设置分类" className="space-y-4">
              {GROUPS.map((group) => (
                <div key={group.id}>
                  <p className="mb-1.5 px-2.5 text-2xs font-medium tracking-wide text-muted-foreground/80 uppercase">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {SETTINGS_SECTIONS.filter((s) => s.group === group.id).map((s) => {
                      const Icon = s.icon;
                      return (
                        <a
                          key={s.id}
                          href={`#${s.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            jumpTo(s.id);
                          }}
                          data-nav-id={s.id}
                          data-active={String(s.id === activeId)}
                          aria-current={s.id === activeId ? 'page' : undefined}
                          className={cn(
                            'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                            s.id === activeId
                              ? 'bg-accent-muted font-medium text-accent'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                            isDimmed(s.id) && 'opacity-40',
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{s.label}</span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </div>

          <div className="border-t border-border px-3 py-3">
            <p className="mb-1.5 px-1 text-2xs font-medium tracking-wide text-muted-foreground/80 uppercase">
              外观
            </p>
            <ThemeSegment />
            <div className="mt-3 flex items-center justify-between gap-2 px-1 text-2xs text-muted-foreground">
              <span>v{appVersion()}</span>
              <button
                type="button"
                onClick={() => void openUrl('chrome://extensions/shortcuts')}
                className="flex items-center gap-1 text-accent transition-colors hover:underline"
                title="在扩展快捷键页配置全局快捷键"
              >
                <Keyboard className="h-3 w-3" />
                快捷键
              </button>
            </div>
          </div>
        </aside>

        {/* ── 内容区 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="z-10 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur-md sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="lg:hidden">
                <BrandMark />
              </div>
              <div className="hidden min-w-0 sm:block">
                <p className="text-2xs text-muted-foreground">设置</p>
                <h1 className="truncate text-sm leading-5 font-semibold text-foreground">
                  {query ? `搜索「${query}」` : activeMeta.label}
                </h1>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {query ? (
                <span className="text-2xs text-muted-foreground">{matchCount} 项匹配</span>
              ) : saveError ? (
                <span className="flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-2xs text-destructive">
                  <ShieldAlert className="h-3 w-3" />
                  保存失败
                </span>
              ) : (
                <span className="hidden items-center gap-1 rounded-md border border-success/25 bg-success/10 px-2 py-1 text-2xs text-success sm:flex">
                  <Check className="h-3 w-3" />
                  自动保存
                </span>
              )}
              <ThemeToggleCompact />
            </div>
          </header>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-4 pt-4 pb-16 sm:px-7 sm:pt-6">
              {/* 小屏：品牌在顶栏、搜索与横向分区导航在这里（侧栏收起来，功能不跟着消失） */}
              <div className="mb-4 space-y-2 lg:hidden">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索设置"
                    aria-label="搜索设置（小屏）"
                    spellCheck={false}
                    className="h-9 w-full rounded-md border border-border bg-card pr-9 pl-8 text-xs text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="清空搜索"
                      className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-xs p-1 text-muted-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <nav aria-label="设置分类（小屏）" className="flex gap-1 overflow-x-auto pb-1">
                  {compactNav}
                </nav>
              </div>

              {noMatch ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
                  <Search className="h-5 w-5 text-muted-foreground/60" />
                  <p className="text-sm font-medium text-foreground">没有匹配「{query}」的设置</p>
                  <p className="max-w-xs text-2xs leading-4 text-muted-foreground">
                    试试更短的关键词，例如「思考」「模型」「记忆」「主题」；也可以直接清空搜索。
                  </p>
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="mt-1 text-2xs text-accent hover:underline"
                  >
                    清空搜索
                  </button>
                </div>
              ) : (
                children
              )}
            </div>
          </div>
        </div>
      </div>
    </SettingsSearchProvider>
  );
}

/** 侧栏主题分段：浅色 / 深色 / 跟随系统 */
function ThemeSegment() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const options: Array<{ value: Theme; icon: React.ComponentType<{ className?: string }>; label: string }> = [
    { value: 'light', icon: Sun, label: '浅色' },
    { value: 'dark', icon: Moon, label: '深色' },
    { value: 'system', icon: Monitor, label: '跟随系统' },
  ];
  return (
    <div role="radiogroup" aria-label="外观主题" className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
      {options.map((o) => {
        const selected = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.label}
            title={o.label}
            onClick={() => void setTheme(o.value)}
            className={cn(
              'flex h-7 items-center justify-center gap-1 rounded-sm text-2xs transition-colors',
              selected ? 'bg-card font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <o.icon className="h-3 w-3" />
          </button>
        );
      })}
    </div>
  );
}

/** 顶栏的紧凑主题切换（小屏也在，避免"换主题只能靠侧栏"） */
function ThemeToggleCompact() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <button
      type="button"
      onClick={() => void setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
      title={dark ? '切换到浅色模式' : '切换到深色模式'}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {dark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
    </button>
  );
}
