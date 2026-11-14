import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '@/components/common/error-boundary';
import '@/assets/main.css';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastViewport } from '@/components/toast/toast';
import { ConfigForm } from '@/components/options/config-form';
import { SettingsShell } from '@/components/options/settings-layout';
import { useConfigStore } from '@/stores/configStore';
import { preapplyTheme } from '@/stores/themeStore';

// 同步预应用系统主题，避免挂载闪烁（ThemeProvider 载入存储配置后会精确校准）
preapplyTheme();

/**
 * 设置页
 *
 * 结构：固定外壳（侧栏导航 + 搜索 + 主题） + 独立滚动的内容区。
 * 为什么是"外壳"而不是"页面中间一根柱子"：设置页不是一篇文章，而是一个长期
 * 会反复回来改的工具面板——导航必须一直在，搜索必须能直接定位字段。
 * 具体分区的视觉（卡片与行）见 `settings-layout` 与 `setting-primitives`。
 */
function OptionsApp() {
  useEffect(() => {
    void useConfigStore.getState().load();
  }, []);

  return (
    <div className="h-full">
      <ThemeProvider />
      <ErrorBoundary area="设置页外壳">
        <SettingsShell>
          <ConfigForm />
        </SettingsShell>
      </ErrorBoundary>
      <ToastViewport />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary area="MarkAI 设置">
    <OptionsApp />
  </ErrorBoundary>,
);
