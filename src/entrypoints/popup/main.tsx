import { BookmarkPlus, LayoutPanelLeft, Settings, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '@/components/common/error-boundary';
import '@/assets/main.css';
import { AI_STORAGE_KEY } from '@/stores/aiStore';
import type { AIConfig, ChatMessage, DeletionProposal } from '@/lib/ai/types';
import { resolveConfig, PROVIDERS } from '@/lib/providers';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { ToastViewport } from '@/components/toast/toast';
import { openUrl } from '@/lib/open-url';
import { ORGANIZE_LOG_KEY, readOrganizeLog, summarizeOrganizeLog, type OrganizeStats } from '@/lib/ai/organize-log';
import { appVersion } from '@/lib/version';
import { saveTabToBar } from '@/lib/bookmarks/save-tab';
import { pendingCardCopy } from '@/lib/bookmarks/pending-copy';
import { organizeCardCopy, type OrganizeLoadState } from '@/lib/bookmarks/organize-card-copy';
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
  /*
   * 待办数据的读取状态。
   *
   * 缺陷：`pendingCount` 初值是 0，第一次 storage 读回来之前界面就已经写着
   * 「当前没有待确认的删除提议。」——**在还不知道的情况下给出确定结论**。
   * SW 睡着时这次读要几百毫秒，用户看到的就是一句假话。
   * 读失败时更糟：永远停在"没有提议"。
   */
  const [pendingState, setPendingState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [saveError, setSaveError] = useState('');
  const [taskRunning, setTaskRunning] = useState(false);
  const [autoDeleteMode, setAutoDeleteMode] = useState(false);
  /** 自动整理摘要：popup 是用户最容易看到「它刚帮我干了什么」的地方 */
  const [organizeStats, setOrganizeStats] = useState<OrganizeStats | null>(null);
  /** 整理记录的读取状态：null 统计 + 失败 ≠ 今天没整理过 */
  const [organizeState, setOrganizeState] = useState<OrganizeLoadState>('loading');

  // 当前活动标签页是否可收藏（http(s) 与本地 file:// 都可以，浏览器自身页面不行）
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
    void readOrganizeLog()
      .then((entries) => {
        setOrganizeStats(summarizeOrganizeLog(entries));
        setOrganizeState('ok');
      })
      .catch(() => {
        // 读不到 ≠ 今天没整理过：必须区分，否则界面在说假话
        setOrganizeStats(null);
        setOrganizeState('error');
      });
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
        setPendingState('ok');
      })
      .catch(() => {
        // 读取失败：按未配置展示（引导用户去设置页），不静默
        if (setConfigured) setAiConfigured(false);
        // 待办数读不到 ≠ 没有待办：必须说出来，不能显示成"没有提议"
        setPendingState('error');
      });
  };

  useEffect(() => {
    refresh();
    // 实时性：popup 停留期间（侧边栏/完整页 Agent 完成提议/新回复）待办数实时刷新
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && (changes[AI_STORAGE_KEY] || changes['markai.config'] || changes[ORGANIZE_LOG_KEY])) {
        refresh(false);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const openFullPage = async (hash = '') => {
    // 打开成功才关弹窗：失败时保持打开，让下面的 ToastViewport 能把原因显示出来
    // （弹窗原先也会被关掉且没有任何提示——用户只看到"点了没反应"）。
    const opened = await openUrl(chrome.runtime.getURL(`page.html${hash}`));
    if (opened) window.close();
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
  const organizeCopy = organizeCardCopy(organizeState, organizeStats);

  const saveCurrentTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setSaveError('');
    /*
     * 落盘逻辑抽到 lib 里（可被单测直接调用）。
     * 原来的内联版本**漏了 parentId**，而 Chrome 的默认父级是「其他书签」——
     * 按钮提示写的却是「收藏到书签栏」，用户点完去书签栏找不到。
     * 实测：不传 parentId 创建出来的 parentId 是 "2"（其他书签）。
     */
    const res = await saveTabToBar({ title: tab?.title, url: tab?.url });
    if (res.ok) {
      window.close();
      return;
    }
    if (res.reason === 'unsupported-url') return; // chrome:// 等本来就不该收藏
    setSaveError(res.reason === 'duplicate' ? '该页面已在收藏夹中' : res.message);
  };

  return (
    <div className="w-[320px]">
      <ThemeProvider />
      <div className="flex h-11 items-center gap-2 border-b border-border bg-card px-3">
        <BrandMark />
        <Badge variant="outline" className="ml-auto">
          <span data-testid="popup-version">v{appVersion()}</span>
        </Badge>
      </div>

      <div className="space-y-2.5 p-3">
        {/* Agent 处理中提示 */}
        {taskRunning && (
          <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-muted px-3 py-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="text-2xs font-medium text-accent">Agent 正在处理中…</span>
          </div>
        )}

        {/* 待办卡片 */}
        <div
          data-testid="popup-pending"
          className="rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-accent/30"
        >
          <div className="flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
            <span className="text-xs font-medium text-foreground">待删除清单</span>
            {pendingCount > 0 && <Badge variant="destructive">{pendingCount} 项</Badge>}
          </div>
          <p className="mt-2 text-2xs leading-4 text-muted-foreground" data-testid="popup-pending-text">
            {pendingCardCopy({ state: pendingState, pendingCount, autoDeleteMode })}
          </p>
          {recentPending.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {recentPending.map((p) => (
                <p key={p.id} className="truncate text-2xs text-muted-foreground/80">• {p.title}</p>
              ))}
              {pendingCount > recentPending.length && (
                <p className="text-2xs text-muted-foreground/60">…等 {pendingCount} 项</p>
              )}
            </div>
          )}
          {pendingCount > 0 && (
            <Button size="sm" variant="destructive" className="mt-2 w-full" onClick={() => openFullPage('#deletions')}>
              去处理（{pendingCount} 项）
            </Button>
          )}
        </div>

        {/* 自动整理摘要：把后台行为摊到台面上 */}
        <button
          type="button"
          data-testid="popup-organize"
          onClick={() => openFullPage('#organize')}
          className="w-full rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-accent/30 hover:bg-muted"
          title="查看整理记录（动了哪些书签、能否重试）"
        >
          <div className="flex items-center gap-2">
            <Wand2 className="h-3.5 w-3.5 text-accent" />
            <span className="text-xs font-medium text-foreground">自动整理</span>
            <Badge variant="outline" className="ml-auto" data-testid="popup-organize-badge">
              {organizeCopy.badge}
            </Badge>
          </div>
          <p className="mt-2 text-2xs leading-4 text-muted-foreground" data-testid="popup-organize-body">
            {organizeCopy.body}
          </p>
          {organizeCopy.failedCount > 0 && (
            <p className="mt-1 text-2xs text-destructive">
              有 {organizeCopy.failedCount} 条整理失败，可查看并重试
            </p>
          )}
        </button>

        {/* 最近动态（点击打开完整页） */}
        <button
          type="button"
          onClick={() => openFullPage()}
          className="w-full rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:bg-muted"
          title="打开完整管理页"
        >
          <p className="truncate text-xs font-medium text-foreground">
            {activeTitle ? `最近动态 · ${activeTitle}` : '最近 Agent 动态'}
          </p>
          <p className="mt-1.5 line-clamp-2 text-2xs leading-4 break-words text-muted-foreground">
            {lastText || '还没有对话记录。打开管理页，开始与 Agent 对话吧。'}
          </p>
        </button>

        {/* 未配置提示 */}
        {!aiConfigured && (
          <div className="rounded-lg border border-accent/30 bg-accent-muted p-3.5">
            <p className="text-xs font-medium text-accent">AI 服务尚未配置</p>
            <p className="mt-1 text-2xs leading-4 text-muted-foreground">
              配置 API Key 与模型后，Agent 才能开始工作。
            </p>
            <Button size="sm" variant="default" className="mt-2 w-full" onClick={openOptions}>
              去配置
            </Button>
          </div>
        )}

        <Separator className="my-1" />

        {/* 入口按钮 */}
        <div className="grid grid-cols-1 gap-2">
          {/* 两个实心按钮会互相抢注意力：AI 未配置时真正的下一步是「去配置」 */}
          <Button variant={aiConfigured ? 'default' : 'outline'} onClick={() => openFullPage()}>
            打开完整管理页
          </Button>
          <Button
            variant="outline"
            disabled={!canSave}
            onClick={() => void saveCurrentTab()}
            title={canSave ? '收藏当前标签页到书签栏' : '当前页面无法收藏（支持网页与本地文件；浏览器自身页面不行）'}
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            收藏当前页面
          </Button>
          {saveError && <p className="text-center text-2xs text-destructive">{saveError}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => void openSidePanel()} title="打开侧边栏（Ctrl+Shift+M）">
              <LayoutPanelLeft className="h-3.5 w-3.5" />
              打开侧边栏
            </Button>
            <Button variant="outline" onClick={openOptions}>
              <Settings className="h-3.5 w-3.5" />
              AI 设置
            </Button>
          </div>
        </div>
      </div>
      <div className="border-t border-border bg-card px-3 py-2 text-center text-2xs text-muted-foreground/70">
        Ctrl+Shift+M 随时打开侧边栏
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary area="MarkAI 弹出窗">
    <>
      <PopupApp />
      {/* 弹窗原先没有 toast 视口：任何 pushToast 在这里都不可见（打开失败也没提示） */}
      <ToastViewport />
    </>
  </ErrorBoundary>,
);
