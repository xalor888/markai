import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
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

/** 设置页入口 */
function OptionsApp() {
  useEffect(() => {
    void useConfigStore.getState().load();
  }, []);

  return (
    <div className="min-h-full">
      <ThemeProvider />
      <OptionsHeader />
      {/* 宽度：512px 在宽屏上左右各空三百多像素，整页像一条窄柱子；
          672px 是说明文字仍在「一行读得完」范围内、又不再浪费空间的一档。
          表单本身仍单列——设置页最重要的是每项都看清说明，而不是把两列塞满。 */}
      <main className="mx-auto w-full max-w-2xl px-5 py-6">
        <ConfigForm />
      </main>
      <ToastViewport />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary area="MarkAI 设置">
    <OptionsApp />
  </ErrorBoundary>,
);
