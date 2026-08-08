import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
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
      <main className="mx-auto w-full max-w-md px-4 py-5">
        <ConfigForm />
      </main>
      <ToastViewport />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<OptionsApp />);
