import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '@/components/common/error-boundary';
import '@/assets/main.css';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastViewport } from '@/components/toast/toast';
import { Workspace } from '@/components/workspace/workspace';
import { initBookmarkListeners, initUIWindowSync, useBookmarkStore } from '@/stores/bookmarkStore';
import { useAIStore, initCrossWindowSync } from '@/stores/aiStore';
import { useConfigStore } from '@/stores/configStore';
import { consumeSeed } from '@/lib/chat/seed';

// 同步预应用系统主题，避免挂载闪烁（ThemeProvider 载入存储配置后会精确校准）
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark');
}

/**
 * 侧边栏入口（Arc 风格紧凑工作区）：
 * 挂载时载入书签树 / 聊天记录 / AI 配置，并消费浏览器右键菜单注入的种子指令。
 */
function SidePanelApp() {
  useEffect(() => {
    void useBookmarkStore.getState().loadTree();
    void useAIStore.getState().load();
    void useConfigStore.getState().load();
    const unlisten = initBookmarkListeners();
    const stopUISync = initUIWindowSync();
    const stopSync = initCrossWindowSync();

    // 窗口激活时强制同步：多窗口场景切回本窗口立即看到最新书签与对话（不依赖 storage 事件时序）
    const onActivate = () => {
      void useBookmarkStore.getState().loadTree();
      void useAIStore.getState().load();
    };
    document.addEventListener('visibilitychange', onActivate);
    window.addEventListener('focus', onActivate);

    // contextMenus 种子指令：storage 消费 + 广播双通道
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === 'markai:seed') void consumeSeed();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    void consumeSeed();

    return () => {
      unlisten();
      stopUISync();
      stopSync();
      document.removeEventListener('visibilitychange', onActivate);
      window.removeEventListener('focus', onActivate);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  return (
    <>
      <ThemeProvider />
      <Workspace mode="compact" />
      <ToastViewport />
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary area="MarkAI 侧边栏">
    <SidePanelApp />
  </ErrorBoundary>,
);
