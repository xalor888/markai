import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/main.css';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastViewport } from '@/components/toast/toast';
import { Workspace } from '@/components/workspace/workspace';
import { initBookmarkListeners, initUIWindowSync, useBookmarkStore } from '@/stores/bookmarkStore';
import { useAIStore, initCrossWindowSync } from '@/stores/aiStore';
import { useConfigStore } from '@/stores/configStore';
import { pushToast } from '@/lib/toast';

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

ReactDOM.createRoot(document.getElementById('root')!).render(<SidePanelApp />);
