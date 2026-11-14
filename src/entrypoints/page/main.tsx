import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '@/components/common/error-boundary';
import '@/assets/main.css';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { installLiquidGlass } from '@/lib/ui/liquid-glass-global';
import { ToastViewport } from '@/components/toast/toast';
import { Workspace } from '@/components/workspace/workspace';
import { initBookmarkListeners, initUIWindowSync, resolveTitlePath, useBookmarkStore } from '@/stores/bookmarkStore';
import { useAIStore, initCrossWindowSync } from '@/stores/aiStore';
import { useConfigStore } from '@/stores/configStore';
import { consumeSeed } from '@/lib/chat/seed';
import { preapplyTheme } from '@/stores/themeStore';

// 同步预应用系统主题，避免挂载闪烁（ThemeProvider 载入存储配置后会精确校准）
preapplyTheme();

/** 标签页标题跟随当前文件夹 */
function initTitleTracking(): () => void {
  const update = () => {
    const s = useBookmarkStore.getState();
    const title = s.selectedFolderId ? resolveTitlePath(s.roots, s.selectedFolderId) : '';
    document.title = title ? `MarkAI · ${title}` : 'MarkAI 智能书签管家';
  };
  update();
  const unsub = useBookmarkStore.subscribe((next, prev) => {
    if (next.selectedFolderId !== prev.selectedFolderId || next.roots !== prev.roots) update();
  });
  return unsub;
}

/** 完整页入口：三分栏 IDE 工作区 */
function PageApp() {
  useEffect(() => {
    void useBookmarkStore.getState().loadTree();
    void useAIStore.getState().load();
    void useConfigStore.getState().load();
    const unlisten = initBookmarkListeners();
    const stopUISync = initUIWindowSync();
    const stopSync = initCrossWindowSync();
    const stopTitle = initTitleTracking();

    // 窗口激活时强制同步：多窗口场景切回本窗口立即看到最新书签与对话（不依赖 storage 事件时序）
    const onActivate = () => {
      void useBookmarkStore.getState().loadTree();
      void useAIStore.getState().load();
    };
    document.addEventListener('visibilitychange', onActivate);
    window.addEventListener('focus', onActivate);

    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === 'markai:seed') void consumeSeed();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    void consumeSeed();

    return () => {
      unlisten();
      stopUISync();
      stopSync();
      stopTitle();
      document.removeEventListener('visibilitychange', onActivate);
      window.removeEventListener('focus', onActivate);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  return (
    <>
      <ThemeProvider />
      <Workspace
        mode="full"
        initialDeletionsOpen={location.hash.includes('deletions')}
        initialOrganizeOpen={location.hash.includes('organize')}
      />
      <ToastViewport />
    </>
  );
}

installLiquidGlass();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary area="MarkAI 工作区">
    <PageApp />
  </ErrorBoundary>,
);
