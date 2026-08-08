import { BookmarkPlus, LayoutPanelLeft, Settings, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/main.css';
import { AI_STORAGE_KEY } from '@/stores/aiStore';
import type { AIConfig, ChatMessage, DeletionProposal } from '@/lib/ai/types';
import { resolveConfig, PROVIDERS } from '@/lib/providers';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { BrandMark } from '@/components/theme/theme-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

// 同步预应用系统主题，避免挂载闪烁（ThemeProvider 载入存储配置后会精确校准）
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark');
}

/** 弹出窗：快速查看待办（待删清单数 + 最近 Agent 动态）+ 各入口 */
function PopupApp() {
  const [pendingCount, setPendingCount] = useState(0);
  const [recentPending, setRecentPending] = useState<{ id: string; title: string }[]>([]);
  const [lastText, setLastText] = useState('');
  const [activeTitle, setActiveTitle] = useState('');
  const [aiConfigured, setAiConfigured] = useState(true);
  const [canSave, setCanSave] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [taskRunning, setTaskRunning] = useState(false);
  const [autoDeleteMode, setAutoDeleteMode] = useState(false);

  // 当前活动标签页是否可收藏（http/https 才可）
  useEffect(() => {
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setCanSave(!!tab?.url && /^https?:\/\//i.test(tab.url)))
      .catch(() => {});
  }, []);

  /** 读取待办数据（挂载时 + storage 变化时共用） */
  const refresh = (setConfigured = true) => {
    // Agent 处理中状态：主动查询 background（SW 活着才有准确状态；
    // 查询失败 = SW 已回收 = 任务必然中断 → 显示未处理中）
    void chrome.runtime
      .sendMessage({ type: 'task:status' })
      .then((res) => {
        if (res && (res as { type?: string }).type === 'task:status:result') {
          setTaskRunning((res as { running: boolean }).running === true);
        }
      })
      .catch(() => setTaskRunning(false));
    void chrome.storage.local
      .get([AI_STORAGE_KEY, 'markai.config'])
      .then((data) => {
        const saved = data[AI_STORAGE_KEY] as
          | {
              // v2：多会话结构（active 会话取最近回复）
              conversations?: { id: string; title?: string; messages?: ChatMessage[] }[];
              activeId?: string;
              // v1 遗留兼容
              messages?: ChatMessage[];
              pendingDeletions?: DeletionProposal[];
            }
          | undefined;
        const pending = (saved?.pendingDeletions ?? []).filter((p) => p.status === 'pending');
        setPendingCount(pending.length);
        // 最近提议预览（最多 3 条，按时间倒序）
        setRecentPending(
          [...pending]
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
            .slice(0, 3)
            .map((p) => ({ id: p.id, title: p.title })),
        );
        // 最近 Agent 回复：优先取当前会话，其次最近活跃的会话，兼容 v1
        const convs = saved?.conversations ?? [];
        const active =
          convs.find((c) => c.id === saved?.activeId) ??
          [...convs].sort((a, b) => (b.messages?.at(-1)?.createdAt ?? 0) - (a.messages?.at(-1)?.createdAt ?? 0))[0];
        setActiveTitle(active?.title ?? '');
        const allMsgs = active?.messages ?? saved?.messages ?? [];
        const assistants = allMsgs.filter((m) => m.role === 'assistant');
        const last = assistants[assistants.length - 1];
        const text = last?.blocks
          .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        setLastText(text ?? '');
        // AI 服务是否已配置：与聊天实际判定一致（resolveConfig 会把未填的 Base URL 回落到服务商预设）；
        // 需要 Key 的服务商没填 Key 视为未配置（引导去设置页）
        const cfg = resolveConfig(data['markai.config'] as Partial<AIConfig> | undefined);
        const preset = PROVIDERS.find((p) => p.id === cfg.providerId);
        const needsKey = preset?.needsKey === true && !cfg.apiKey;
        setAutoDeleteMode(cfg.deleteMode === 'auto');
        if (setConfigured) setAiConfigured(!!cfg.baseUrl && !!cfg.model && !needsKey);
      })
      .catch(() => {
        // 读取失败：按未配置展示（引导用户去设置页），不静默
        if (setConfigured) setAiConfigured(false);
      });
  };

  useEffect(() => {
    refresh();
    // 实时性：popup 停留期间（侧边栏/完整页 Agent 完成提议/新回复）待办数实时刷新
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && (changes[AI_STORAGE_KEY] || changes['markai.config'])) refresh(false);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const openFullPage = (hash = '') => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`page.html${hash}`) }).catch(() => {});
    window.close();
  };

  const openSidePanel = async () => {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) {
      // await 送达后再关闭，避免 popup 销毁导致消息丢失
      await chrome.runtime.sendMessage({ type: 'sidepanel:open', windowId: win.id }).catch(() => {});
    }
    window.close();
  };

  const openOptions = async () => {
    // 先 await 打开完成再关窗：popup 立即销毁存在选项页不打开的竞态
    await chrome.runtime.openOptionsPage().catch(() => {});
    window.close();
  };

  /** 收藏当前活动标签页（重复检测，存入书签栏）；失败时保留 popup 并显示原因 */
  const saveCurrentTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url || !/^https?:\/\//i.test(url)) return;
    setSaveError('');
    try {
      const existing = await chrome.bookmarks.search(url).catch(() => []);
      if (existing.some((n) => n.url === url)) {
        setSaveError('该页面已在收藏夹中');
        return;
      }
      await chrome.bookmarks.create({ title: tab.title || url, url });
      window.close();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="w-[320px]">
      <ThemeProvider />
      <div className="flex h-10 items-center gap-1.5 border-b border-border bg-card px-3">
        <BrandMark />
        <Badge variant="outline" className="ml-auto">
          v0.2.0
        </Badge>
      </div>

      <div className="space-y-2 p-3">
        {/* Agent 处理中提示 */}
        {taskRunning && (
          <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-muted px-3 py-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="text-[11px] font-medium text-accent">Agent 正在处理中…</span>
          </div>
        )}

        {/* 待办卡片 */}
        <div className="rounded-lg border border-border bg-card p-3 transition-colors hover:border-indigo-500/30">
          <div className="flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
            <span className="text-xs font-medium text-foreground">待删除清单</span>
            {pendingCount > 0 && <Badge variant="destructive">{pendingCount} 项</Badge>}
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
            {pendingCount > 0
              ? autoDeleteMode
                ? '当前为「无需确认」模式：Agent 的删除建议会自动执行。'
                : 'Agent 提出了删除建议，等待你确认。'
              : autoDeleteMode
                ? '当前为「无需确认」模式：Agent 删除建议自动执行，无需手动确认。'
                : '当前没有待确认的删除提议。'}
          </p>
          {recentPending.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {recentPending.map((p) => (
                <p key={p.id} className="truncate text-[11px] text-muted-foreground/80">• {p.title}</p>
              ))}
              {pendingCount > recentPending.length && (
                <p className="text-[11px] text-muted-foreground/60">…等 {pendingCount} 项</p>
              )}
            </div>
          )}
          {pendingCount > 0 && (
            <Button size="sm" variant="destructive" className="mt-2 w-full" onClick={() => openFullPage('#deletions')}>
              去处理（{pendingCount} 项）
            </Button>
          )}
        </div>

        {/* 最近动态（点击打开完整页） */}
        <button
          type="button"
          onClick={() => openFullPage()}
          className="w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50"
          title="打开完整管理页"
        >
          <p className="truncate text-xs font-medium text-foreground">
            {activeTitle ? `最近动态 · ${activeTitle}` : '最近 Agent 动态'}
          </p>
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 break-words text-muted-foreground">
            {lastText || '还没有对话记录。打开管理页，开始与 Agent 对话吧。'}
          </p>
        </button>

        {/* 未配置提示 */}
        {!aiConfigured && (
          <div className="rounded-lg border border-accent/30 bg-accent-muted p-3">
            <p className="text-xs font-medium text-accent">AI 服务尚未配置</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              配置 API Key 与模型后，Agent 才能开始工作。
            </p>
            <Button size="sm" variant="default" className="mt-2 w-full" onClick={openOptions}>
              去配置
            </Button>
          </div>
        )}

        <Separator className="my-1" />

        {/* 入口按钮 */}
        <div className="grid grid-cols-1 gap-1.5">
          <Button variant="default" onClick={() => openFullPage()}>
            打开完整管理页
          </Button>
          <Button
            variant="outline"
            disabled={!canSave}
            onClick={() => void saveCurrentTab()}
            title={canSave ? '收藏当前标签页到书签栏' : '当前页面无法收藏（仅支持 http/https）'}
          >
            <BookmarkPlus className="h-3 w-3" />
            收藏当前页面
          </Button>
          {saveError && <p className="text-center text-[11px] text-destructive">{saveError}</p>}
          <div className="grid grid-cols-2 gap-1.5">
            <Button variant="outline" onClick={() => void openSidePanel()} title="打开侧边栏（Ctrl+Shift+M）">
              <LayoutPanelLeft className="h-3 w-3" />
              打开侧边栏
            </Button>
            <Button variant="outline" onClick={openOptions}>
              <Settings className="h-3 w-3" />
              AI 设置
            </Button>
          </div>
        </div>
      </div>
      <div className="border-t border-border bg-card px-3 py-1.5 text-center text-[11px] text-muted-foreground/70">
        Ctrl+Shift+M 随时打开侧边栏
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<PopupApp />);
