import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/main.css';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastViewport } from '@/components/toast/toast';
import { Workspace } from '@/components/workspace/workspace';
import { initBookmarkListeners, initUIWindowSync, resolveTitlePath, useBookmarkStore } from '@/stores/bookmarkStore';
import { useAIStore, initCrossWindowSync } from '@/stores/aiStore';
import { useConfigStore } from '@/stores/configStore';
import { pushToast } from '@/lib/toast';

// 同步预应用系统主题，避免挂载闪烁（ThemeProvider 载入存储配置后会精确校准）
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark');
}

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

/** Ctrl+K 聚焦搜索框（原生应用习惯） */
function initSearchShortcut(): () => void {
  const onKey = (e: globalThis.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      // 输入框内不拦截
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select')) return;
      e.preventDefault();
      document.getElementById('markai-search')?.focus();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
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
    const stopSearchShortcut = initSearchShortcut();

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
      stopSearchShortcut();
      document.removeEventListener('visibilitychange', onActivate);
      window.removeEventListener('focus', onActivate);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  return (
    <>
      <ThemeProvider />
      <Workspace mode="full" initialDeletionsOpen={location.hash.includes('deletions')} />
      <ToastViewport />
    </>
  );
}

/** 消费种子指令并发送给 Agent（SW 未响应时静默失败，不产生未处理异常） */
async function consumeSeed(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'seed:consume' })) as
      | { type: string; text?: string; folderId?: string; notice?: string }
      | undefined;
    if (res?.type === 'seed:value') {
      if (res.text) {
        // 流式中消费（Agent 正忙）：种子已在后台被移除，入队等流式结束串行发送，避免静默丢失
        if (useAIStore.getState().streaming) queueSeed(res.text, res.folderId);
        else await useAIStore.getState().send(res.text, res.folderId ? { folderId: res.folderId } : undefined);
      }
      if (res.notice) pushToast(res.notice);
    }
  } catch {
    // 后台暂不可达（如刚启动），种子仍在 storage 中，下次挂载会再消费
  }
}

/** 流式中到达的种子指令队列：订阅一次（不泄漏），流结束后串行发送 */
let seedQueue: { text: string; folderId?: string }[] = [];
let seedListener: (() => void) | null = null;
function queueSeed(text: string, folderId?: string): void {
  seedQueue.push({ text, folderId });
  if (!seedListener) {
    seedListener = useAIStore.subscribe((s) => {
      if (!s.streaming && seedQueue.length > 0) {
        const next = seedQueue.shift()!;
        void useAIStore.getState().send(next.text, next.folderId ? { folderId: next.folderId } : undefined);
      }
    });
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(<PageApp />);
