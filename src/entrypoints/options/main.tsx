import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { Brain, Database, Palette, Plug, ShieldCheck, SlidersHorizontal, Zap } from 'lucide-react';
import { ErrorBoundary } from '@/components/common/error-boundary';
import '@/assets/main.css';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastViewport } from '@/components/toast/toast';
import { ConfigForm, OptionsHeader } from '@/components/options/config-form';
import { useConfigStore } from '@/stores/configStore';

// 同步预应用系统主题，避免挂载闪烁（ThemeProvider 载入存储配置后会精确校准）
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark');
}

/** 左侧导航条目：与 ConfigForm 里各 Section 的 anchor 一一对应 */
const NAV = [
  { id: 'health', label: '健康检查', icon: ShieldCheck },
  { id: 'ai', label: 'AI 服务', icon: Plug },
  { id: 'context', label: '上下文与预算', icon: SlidersHorizontal },
  { id: 'agent', label: 'Agent 行为', icon: Zap },
  { id: 'memory', label: '长期记忆', icon: Brain },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'data', label: '数据管理', icon: Database },
] as const;

/**
 * 设置页
 *
 * 重写前的样子：单列 672px 的窄柱子，六个卡片竖着摞，整页 2300px；
 * 每个字段「标签 / 输入框 / 说明」三段竖排，一屏只能看三四项，找一项要滚半天。
 *
 * 现在：左边一列固定导航（点一下直接跳过去），右边是内容；
 * 字段改成左右两栏，同样信息量的高度砍掉近一半。
 */
function OptionsApp() {
  useEffect(() => {
    void useConfigStore.getState().load();
  }, []);

  // 滚动时高亮当前所在的分节（不用 IntersectionObserver 的复杂配置，
  // 直接用「最后一个进入视野上沿的标题」——行为可预测，也不会有抖动）
  useEffect(() => {
    const onScroll = () => {
      let current: string = NAV[0]!.id;
      for (const n of NAV) {
        const el = document.getElementById(n.id);
        if (el && el.getBoundingClientRect().top <= 120) current = n.id;
      }
      document.querySelectorAll<HTMLElement>('[data-nav-id]').forEach((a) => {
        a.dataset.active = String(a.dataset.navId === current);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="min-h-full">
      <ThemeProvider />
      <OptionsHeader />
      <div className="mx-auto flex w-full max-w-5xl gap-8 px-5 py-6">
        {/* 左侧导航：窄屏收起（内容区优先） */}
        <nav
          aria-label="设置分类"
          className="sticky top-20 hidden h-fit w-44 shrink-0 lg:block"
        >
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <a
                key={n.id}
                href={`#${n.id}`}
                data-nav-id={n.id}
                data-active="false"
                className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:bg-accent-muted data-[active=true]:font-medium data-[active=true]:text-accent"
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {n.label}
              </a>
            );
          })}
        </nav>

        <main className="min-w-0 flex-1">
          <ConfigForm />
        </main>
      </div>
      <ToastViewport />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary area="MarkAI 设置">
    <OptionsApp />
  </ErrorBoundary>,
);
