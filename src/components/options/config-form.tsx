import { AlertTriangle, Brain, CheckCircle2, ChevronRight, Database, Download, Eye, EyeOff, Loader2, Monitor, Moon, Palette, Plug, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, Sun, Sparkles, Trash2, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { useAIStore, AI_STORAGE_KEY } from '@/stores/aiStore';
import { useMemoryStore, initMemorySync } from '@/stores/memoryStore';
import { CATEGORY_LABELS, type MemoryCategory } from '@/lib/ai/memory';
import { clearUndoPoints } from '@/lib/undo/recorder';
import { countTree, toJsonExport, toNetscapeHtml } from '@/lib/bookmarks/export-file';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { PROVIDERS, getPreset, getModelContextWindow } from '@/lib/providers';
import { parseCustomHeaders } from '@/lib/ai/request-headers';
import type { OneShotOutbound } from '@/lib/ai/types';
import { pushToast } from '@/lib/toast';
import { openUrl } from '@/lib/open-url';
import { appVersion } from '@/lib/version';
import { Badge } from '@/components/ui/badge';
import { HealthPanel } from '@/components/health/health-panel';
import { ErrorBoundary } from '@/components/common/error-boundary';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/theme/theme-provider';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

/** token 数友好显示：400000 → 400K，1047000 → 1.05M */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 分区卡片：统一标题样式与内边距（此前每个 section 各写一遍标题 className） */
function Section({
  icon: Icon,
  title,
  badge,
  children,
  className,
  anchor,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** 左侧导航跳转用的锚点 id */
  anchor?: string;
}) {
  /*
   * 分节不再是一张张带边框的卡片：
   * 六个圆角框叠在一起，边界比内容还抢眼，页面看起来像"六个抽屉"。
   * 改成一个节标题 + 一条分隔线，靠留白分组——这也是原生设置页的做法。
   */
  return (
    <section id={anchor} className={cn('scroll-mt-20 border-t border-border pt-4 first:border-t-0 first:pt-0', className)}>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Icon className="h-4 w-4 shrink-0 text-accent" />
          {title}
        </h2>
        {badge}
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

/** 字段容器：标签在上、控件在下、说明在最后（统一三段式间距） */
function Field({
  label,
  hint,
  htmlFor,
  children,
  action,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  /** 标签行右侧的操作（如「获取模型列表」） */
  action?: React.ReactNode;
}) {
  /*
   * 左右两栏：标签在左（固定 148px），控件在右。
   *
   * 重写前是「标签 / 控件 / 说明」三段竖排，每个字段占掉约 100px 高度——
   * 整页 2300px，找一项要滚半天。两栏之后同样的信息量高度砍掉近一半，
   * 而且标签天然对齐，扫视时一列词就能定位到要改的那项。
   *
   * 窄屏（<640px）自动退回单列，避免标签被挤成两行。
   */
  return (
    <div className="grid grid-cols-1 gap-x-5 py-2 sm:grid-cols-[148px_minmax(0,1fr)]">
      <div className="flex items-center justify-between gap-2 sm:block sm:pt-2">
        <Label htmlFor={htmlFor} className="text-xs font-medium">
          {label}
        </Label>
        {action && <div className="sm:hidden">{action}</div>}
      </div>
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{children}</div>
          {action && <div className="hidden shrink-0 pt-1 sm:block">{action}</div>}
        </div>
        {hint && <p className="mt-1 text-2xs leading-4 text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

/** 文字按钮：用于 Label 行右侧的轻量操作 */
function InlineAction({
  onClick,
  disabled,
  busy,
  icon: Icon,
  children,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-1 text-2xs text-accent transition-colors hover:bg-accent-muted disabled:pointer-events-none disabled:opacity-40"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      {children}
    </button>
  );
}

/** AI 配置表单：Provider 预设 / API Key / Base URL / 模型 + 连接测试 + 外观 + 数据管理 */
export function ConfigForm() {
  const config = useConfigStore((s) => s.config);
  const loaded = useConfigStore((s) => s.loaded);
  const update = useConfigStore((s) => s.update);
  const applyPreset = useConfigStore((s) => s.applyPreset);
  const theme = useThemeStore((s) => s.theme);

  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [modelInput, setModelInput] = useState('');
  /**
   * 自定义请求头输入框。
   *
   * 本地 state 而不是直接绑 config：这些文本要按行解析、非法行要就地报错，
   * 每次按键都写 storage 会让输入过程被往返覆盖（也是在别处踩过的坑）。
   * 失焦/停止输入时才提交。
   */
  const [headersInput, setHeadersInput] = useState('');
  const [headerErrors, setHeaderErrors] = useState<string[]>([]);
  /** 书签导出的统计（按钮旁显示"将导出 N 条"；读不到时为 null，按钮禁用） */
  const [exportCounts, setExportCounts] = useState<{ bookmarks: number; folders: number } | null>(null);
  /** 导出失败的原因（读不到书签树 / 生成内容失败），不静默 */
  const [exportError, setExportError] = useState<string | null>(null);

  // 统计书签数量：读不到就不给数（按钮禁用），不要把"读不到"显示成 0 条
  useEffect(() => {
    void chrome.bookmarks
      .getTree()
      .then((roots) => setExportCounts(countTree(roots)))
      .catch((e: unknown) => {
        setExportCounts(null);
        setExportError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  /**
   * 导出书签到本地文件。
   *
   * 失败必须可见：按钮点了没反应，比不给这个功能更糟。
   */
  const exportBookmarksNow = async (format: 'html' | 'json'): Promise<void> => {
    try {
      setExportError(null);
      const roots = await chrome.bookmarks.getTree();
      const content = format === 'html' ? toNetscapeHtml(roots) : toJsonExport(roots);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = format === 'html' ? `MarkAI-书签-${stamp}.html` : `MarkAI-书签-${stamp}.json`;
      const blob = new Blob([content], {
        type: format === 'html' ? 'text/html;charset=utf-8' : 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      pushToast('已导出书签', { description: name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExportError(msg);
      pushToast('导出失败', { variant: 'destructive', description: msg });
    }
  };
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClearMemories, setConfirmClearMemories] = useState(false);
  const [dataCounts, setDataCounts] = useState<{ messages: number; pending: number }>({ messages: 0, pending: 0 });

  // 长期记忆管理
  const memories = useMemoryStore((s) => s.memories);
  const loadMemories = useMemoryStore((s) => s.load);
  const addMemory = useMemoryStore((s) => s.add);
  const removeMemory = useMemoryStore((s) => s.remove);
  const toggleMemory = useMemoryStore((s) => s.toggle);
  const clearMemories = useMemoryStore((s) => s.clear);
  const [newMemContent, setNewMemContent] = useState('');
  const [newMemCat, setNewMemCat] = useState<MemoryCategory>('preference');

  // 设置保存失败必须可见：这条路径存的是 API Key 与删除模式，静默失败会变成假象
  const saveError = useConfigStore((s) => s.saveError);
  // 模型上下文输入：本地字符串 state（受控 value 派生 + onChange 过滤会拦截 64K/100K 等合法输入）
  const [ctxInput, setCtxInput] = useState(() => String(Math.round((config.contextWindow ?? 1_048_576) / 1000)));
  /** 模型已知窗口的展示值（跟随模型时显示在输入框旁，让用户知道实际用的是多少） */
  const [autoHint, setAutoHint] = useState('');
  // 请求竞态纪元（测试连接 / 模型列表各自独立，避免并发时互相卡死对方状态）
  const testEpoch = useRef(0);
  const modelsEpoch = useRef(0);

  const preset = getPreset(config.providerId);
  const models = preset?.models ?? [];
  /**
   * 生效的上下文窗口：没手动填 → 跟随所选模型。
   * （此前恒为 1M、与模型无关，128K 的模型也拿 1M，护栏因此永不触发。）
   */
  const autoWindow = getModelContextWindow(config.model || preset?.defaultModel || '');
  const effectiveWindow = config.contextWindow ?? autoWindow;
  const isAuto = typeof config.contextWindow !== 'number';

  // 自定义请求头：从配置载入一次（之后由用户输入驱动，避免被往返覆盖）
  useEffect(() => {
    setHeadersInput(config.customHeaders ?? '');
    setHeaderErrors(parseCustomHeaders(config.customHeaders).errors);
    // 只在首次载入配置时同步；用户编辑期间不覆盖输入框
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 载入长期记忆与跨窗口同步监听
  useEffect(() => {
    void loadMemories();
    const stopSync = initMemorySync();
    return () => stopSync();
  }, [loadMemories]);

  // 读取本地数据量（消息数 + 待删数；v2 多会话结构：汇总全部会话）
  useEffect(() => {
    void chrome.storage.local
      .get(AI_STORAGE_KEY)
      .then((data) => {
        const saved = data[AI_STORAGE_KEY] as
          | {
              conversations?: { messages?: unknown[] }[];
              messages?: unknown[]; // v1 兼容
              pendingDeletions?: { status?: string }[];
            }
          | undefined;
        const msgCount = Array.isArray(saved?.conversations)
          ? saved!.conversations!.reduce((acc, c) => acc + (c.messages?.length ?? 0), 0)
          : (saved?.messages?.length ?? 0);
        setDataCounts({
          messages: msgCount,
          pending: (saved?.pendingDeletions ?? []).filter((p) => p.status === 'pending').length,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (loaded) setModelInput(config.model);
  }, [loaded, config.model]);

  // 载入主题（设置页无 ThemeProvider 之外的入口）
  useEffect(() => {
    void useThemeStore.getState().load();
  }, []);

  // 模型上下文输入与外部变化同步（必须与上方 hooks 连续声明，不能放在条件 return 之后）
  // 依赖里带上 config.model：换模型后"跟随模型"的值变了，输入框必须跟着变
  useEffect(() => {
    const auto = getModelContextWindow(config.model || getPreset(config.providerId)?.defaultModel || '');
    setAutoHint(`${Math.round(auto / 1000)}K`);
    setCtxInput(String(Math.round((config.contextWindow ?? auto) / 1000)));
  }, [config.contextWindow, config.model, config.providerId]);

  const handleAddMemory = async () => {
    const text = newMemContent.trim();
    if (!text) return;
    try {
      await addMemory(text, newMemCat);
      setNewMemContent('');
      pushToast('已保存到长期记忆', { variant: 'default' });
    } catch (e) {
      pushToast('保存记忆失败', { variant: 'destructive', description: String(e) });
    }
  };

  if (!loaded) return <p className="p-4 text-xs text-muted-foreground">加载中…</p>;

  const runTest = async () => {
    if (testing) return; // 防并发
    setTesting(true);
    setTestResult(null);
    // 独立纪元：与 fetchModels 互不覆盖（共用会卡死对方按钮状态）
    const epoch = ++testEpoch.current;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'ai:test',
        config: useConfigStore.getState().effectiveConfig(),
      })) as OneShotOutbound | undefined;
      // 期间切换了服务商/配置：丢弃过期结果，避免旧状态覆盖当前 provider
      if (epoch !== testEpoch.current) return;
      if (res?.type === 'ai:test:result') {
        setTestResult({ ok: res.ok, message: res.message });
        if (res.ok) pushToast('连接成功', { variant: 'success' });
      }
    } catch (e) {
      if (epoch === testEpoch.current) {
        pushToast('连接测试失败', {
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        });
      }
    } finally {
      if (epoch === testEpoch.current) setTesting(false);
    }
  };

  /** 从服务商拉取模型列表（GET /models，兼容 OpenAI 与 Ollama 格式） */
  const fetchModels = async () => {
    if (fetchingModels) return;
    setFetchingModels(true);
    const epoch = ++modelsEpoch.current;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'ai:models',
        config: useConfigStore.getState().effectiveConfig(),
      })) as OneShotOutbound | undefined;
      if (epoch !== modelsEpoch.current) return; // 过期响应：丢弃
      if (res?.type === 'ai:models:result') {
        if (res.ok && res.models.length > 0) {
          setRemoteModels(res.models);
          pushToast(res.message, { variant: 'success' });
          // 服务商返回了当前模型上下文长度 → 自动填入设置
          if (typeof res.contextWindow === 'number' && res.contextWindow >= 8000) {
            void update({ contextWindow: res.contextWindow });
          }
        } else {
          pushToast('获取模型列表失败', { description: res.message, variant: 'destructive' });
        }
      }
    } catch (e) {
      if (epoch === modelsEpoch.current) {
        pushToast('获取模型列表失败', {
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        });
      }
    } finally {
      if (epoch === modelsEpoch.current) setFetchingModels(false);
    }
  };

  /** 提交模型上下文输入（blur/Enter 时校验并写回） */
  const commitCtx = () => {
    const k = Number(ctxInput);
    if (Number.isFinite(k) && k >= 8) {
      // 上限 2000K（2M token）：与 resolveConfig / agent 预算护栏的 2_000_000 上限保持一致，
      // 超出会被静默钳回 2M，表单若允许 4000K 会与实际生效值脱节
      const clamped = Math.min(Math.max(Math.round(k), 8), 2000);
      void update({ contextWindow: clamped * 1000 });
      setCtxInput(String(clamped));
    } else {
      // 非法输入：回落到"跟随模型"（而不是回落到某个写死的默认值）
      void update({ contextWindow: undefined });
      setCtxInput(String(Math.round(effectiveWindow / 1000)));
    }
  };

  /** 恢复为"跟随所选模型"（清除手动填写值） */
  const resetCtxToModel = () => {
    void update({ contextWindow: undefined });
    setCtxInput(String(Math.round(autoWindow / 1000)));
  };

  /** 清空本地对话与待删数据（v2 多会话：连会话列表一起清；先写墓碑防其他窗口复活） */
  const clearLocalData = async () => {
    try {
      // 墓碑源必须是 storage 中的实际会话（options 页从不 load aiStore，内存镜像恒为空）
      const data = await chrome.storage.local.get(AI_STORAGE_KEY);
      const stored = data[AI_STORAGE_KEY] as { conversations?: { id: string }[] } | undefined;
      const s = useAIStore.getState();
      const allIds = [
        ...new Set([
          ...(stored?.conversations ?? []).map((c) => c.id),
          ...s.conversations.map((c) => c.id),
        ]),
      ];
      // 1) 先把全部会话 id 写入墓碑并持久化：其他窗口的旧快照合并时被过滤，不会复活
      useAIStore.setState({
        deletedIds: [...new Set([...s.deletedIds, ...allIds])],
        clearedIds: [...new Set([...s.clearedIds, ...allIds])],
      });
      await useAIStore.getState()._persist(true);
      // 2) 清空 storage（墓碑随之消失，但第 3 步会立即重建）
      await chrome.storage.local.remove(AI_STORAGE_KEY);
      // 撤销记录里存着被删书签的子树快照（也是书签数据），「清空本地数据」必须一并清掉，
      // 否则用户没有任何入口能删除它——隐私说明里也就只能写"清不掉"。
      await clearUndoPoints();
      await useAIStore.getState().refreshUndo();
      // 3) 重建：墓碑 + 新空会话一起写回（remove 后其他窗口合并时墓碑仍在）
      useAIStore.setState({ messages: [], pendingDeletions: [], conversations: [], activeId: null });
      await useAIStore.getState().load();
      await useAIStore.getState()._persist(true);
      setDataCounts({ messages: 0, pending: 0 });
      pushToast('本地数据已清空', { variant: 'success' });
    } catch (e) {
      pushToast('清空失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  // 未配置完成时给一条三步引导：装完扩展直接落在这里的新用户不知道"先填哪个"
  const needsSetup = !config.baseUrl || !config.model || (preset?.needsKey === true && !config.apiKey);

  return (
    <div className="space-y-4">
      {needsSetup && (
        <div className="animate-fade-in rounded-lg border border-accent/30 bg-accent-muted/60 px-3.5 py-2.5">
          <p className="text-xs font-medium text-accent">三步开始用</p>
          <ol className="mt-1 space-y-0.5 text-2xs leading-4 text-muted-foreground">
            <li>1. 选服务商（国内网络建议 DeepSeek 或 Moonshot Kimi；本地无成本用 Ollama）</li>
            <li>2. 填 API Key（只存在这台电脑的浏览器里，请求由后台直连服务商）</li>
            <li>3. 点下面的「测试连接」，通过后打开书签页（或浏览器侧边栏）就能开始整理</li>
          </ol>
        </div>
      )}

      {/* ── 健康检查 ──
          放第一位：用户会打开设置页，多半就是"感觉哪里不对"。
          先让他看到明确结论，再往下才是逐项配置。 */}
      <Section icon={ShieldCheck} title="健康检查" anchor="health">
        <div className="py-2">
          {/*
           * 体检要读 chrome.* 与 storage，任何一项抛错都会让整个设置页白屏——
           * 而设置页恰恰是用户"出问题时才来"的地方，白屏等于彻底失去自救入口。
           * 包一层边界：最坏情况是这一节显示失败原因，其余配置项照常可改。
           */}
          <ErrorBoundary area="健康检查">
            <HealthPanel />
          </ErrorBoundary>
        </div>
      </Section>

      {/* ── AI 服务 ── */}
      <Section icon={Plug} title="AI 服务" anchor="ai">
        <div className="space-y-3.5">
          <Field
            label="服务商"
            htmlFor="provider"
            hint={preset?.needsKey ? '该服务商需要 API Key。' : '本地服务（如 Ollama）无需 API Key。'}
          >
            <Select
              id="provider"
              value={config.providerId}
              onChange={(e) => {
                // 切换即作废全部在途请求（epoch 递增 + 复位按钮状态），
                // 防止旧服务商的测试结果/模型列表/上下文长度污染新配置
                testEpoch.current++;
                modelsEpoch.current++;
                setTesting(false);
                setFetchingModels(false);
                void applyPreset(e.target.value);
                setTestResult(null); // 切换服务商后清除旧测试结果
                setRemoteModels([]); // 旧服务商的模型列表不得残留（可能误选不存在的模型）
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Base URL" htmlFor="base-url" hint="兼容 OpenAI 协议；本地 Ollama 默认 http://localhost:11434/v1">
            <Input
              id="base-url"
              value={config.baseUrl}
              onChange={(e) => {
                void update({ baseUrl: e.target.value });
                setTestResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void runTest();
              }}
              placeholder={preset?.baseUrl || 'api.example.com/v1（可省略 https://）'}
              spellCheck={false}
            />
          </Field>

          {preset?.needsKey && (
            <Field label="API Key" htmlFor="api-key">
              <div className="relative">
                <Input
                  id="api-key"
                  type={showKey ? 'text' : 'password'}
                  value={config.apiKey}
                  onChange={(e) => {
                    void update({ apiKey: e.target.value });
                    setTestResult(null);
                  }}
                  placeholder="sk-…"
                  spellCheck={false}
                  autoComplete="off"
                  className="pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </Field>
          )}

          <Field
            label="模型"
            htmlFor="model"
            hint={
              remoteModels.length > 0
                ? `已拉取 ${remoteModels.length} 个模型，可在输入框下拉选择。`
                : undefined
            }
            action={
              <InlineAction
                onClick={() => void fetchModels()}
                disabled={fetchingModels}
                busy={fetchingModels}
                icon={RefreshCw}
                title="从服务商拉取最新模型列表（GET /models）"
              >
                获取列表
              </InlineAction>
            }
          >
            <Input
              id="model"
              list="model-suggestions"
              value={modelInput}
              onChange={(e) => {
                setModelInput(e.target.value);
                void update({ model: e.target.value });
                setTestResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void runTest();
              }}
              placeholder={preset?.defaultModel || '输入模型名称'}
              spellCheck={false}
            />
            <datalist id="model-suggestions">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
              {remoteModels.map((m) => (
                <option key={`r-${m}`} value={m} />
              ))}
            </datalist>
          </Field>

          <Field
            label="自定义请求头"
            htmlFor="custom-headers"
            hint={
              preset?.sessionHeader ? (
                <>
                  已自动带上 <code className="text-foreground">{preset.sessionHeader}</code>
                  （每个安装一个稳定 ID，不用手填；服务端靠它把同一会话路由到同一节点、让提示缓存生效）。
                  下面只填服务商**额外**要求的头，每行一条 <code className="text-foreground">Name: Value</code>。
                </>
              ) : (
                <>
                  有些网关在标准协议之外要求额外请求头（例如 OpenCode Go 的{' '}
                  <code className="text-foreground">x-opencode-session</code>，缺了直接 400）。
                  每行一条 <code className="text-foreground">Name: Value</code>；空行与 <code className="text-foreground">#</code> 开头的行忽略。
                </>
              )
            }
          >
            <Textarea
              id="custom-headers"
              rows={2}
              value={headersInput}
              spellCheck={false}
              placeholder={'# 例：X-Api-Key: abc123\n# 例：x-opencode-session: my-stable-id'}
              onChange={(e) => {
                const text = e.target.value;
                setHeadersInput(text);
                // 就地校验：非法行当场报出来，别等到请求 400 才让用户猜
                setHeaderErrors(parseCustomHeaders(text).errors);
                void update({ customHeaders: text });
              }}
              onBlur={() => setHeaderErrors(parseCustomHeaders(headersInput).errors)}
            />
            {headerErrors.length > 0 && (
              <ul role="alert" className="space-y-0.5 text-2xs leading-4 text-destructive">
                {headerErrors.map((err) => (
                  <li key={err} className="flex items-start gap-1">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                    <span className="min-w-0">{err}</span>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          {/* 测试连接：结果独占一行，失败时不会把按钮挤走 */}
          <div className="space-y-2 border-t border-border pt-3.5">
            <Button size="sm" variant="secondary" disabled={testing} onClick={() => void runTest()}>
              {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
              测试连接
            </Button>
            {testResult && (
              <p
                role="status"
                className={cn(
                  'flex items-start gap-1.5 text-2xs leading-4',
                  testResult.ok ? 'text-success' : 'text-destructive',
                )}
              >
                {testResult.ok && <CheckCircle2 className="mt-px h-3 w-3 shrink-0" />}
                <span className="min-w-0">{testResult.message}</span>
              </p>
            )}
          </div>
        </div>
      </Section>

      {/* ── 上下文与预算 ── */}
      <Section icon={SlidersHorizontal} title="上下文与预算" anchor="context">
        <div className="space-y-3.5">
          <Field
            label="模型上下文长度"
            htmlFor="context-window"
            action={
              !isAuto && (
                <InlineAction onClick={resetCtxToModel} icon={Sparkles} title={`清除手动值，改回跟随模型（${autoHint}）`}>
                  跟随模型
                </InlineAction>
              )
            }
            hint={
              isAuto ? (
                <>
                  当前<strong className="text-foreground">跟随模型</strong>：
                  {config.model || preset?.defaultModel || '未选模型'} → {autoHint}。不确定就别手动填。
                </>
              ) : (
                <>
                  已手动设为 {Math.round((config.contextWindow ?? 0) / 1000)}K，该模型已知 {autoHint}。填错会让请求超出真实窗口。
                </>
              )
            }
          >
            <div className="flex items-center gap-2">
              <Input
                id="context-window"
                type="number"
                min={8}
                max={2000}
                step={8}
                value={ctxInput}
                onChange={(e) => setCtxInput(e.target.value)}
                onBlur={commitCtx}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    commitCtx();
                  }
                }}
                className="h-8 w-24 text-xs"
                aria-label="模型上下文长度（千 token）"
              />
              <span className="text-2xs text-muted-foreground">K tokens</span>
            </div>
          </Field>

          <Field
            label="自动压缩阈值"
            htmlFor="compress-threshold"
            hint="用量达到「上下文长度 × 阈值」时，把早期消息压缩为摘要（需开启下方自动压缩）。"
          >
            <div className="flex items-center gap-3">
              <Slider
                id="compress-threshold"
                min={50}
                max={95}
                step={5}
                value={Math.round((config.compressThreshold ?? 0.8) * 100)}
                onChange={(v) => void update({ compressThreshold: v / 100 })}
                aria-label="自动压缩阈值"
                className="flex-1"
              />
              <span className="w-24 shrink-0 text-right text-2xs text-muted-foreground">
                {Math.round((config.compressThreshold ?? 0.8) * 100)}% · 预算{' '}
                {formatTokens(Math.round(effectiveWindow * (config.compressThreshold ?? 0.8)))}
              </span>
            </div>
          </Field>

          {/* 自动压缩：与上面那条阈值是配套的开关，紧贴在一起 */}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-sm border border-border bg-muted/40 px-3 py-2.5 transition-colors hover:border-border hover:bg-muted">
            <Checkbox
              checked={config.autoCompress ?? false}
              onCheckedChange={(v) => void update({ autoCompress: v })}
              aria-label="自动压缩上下文"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">自动压缩上下文</span>
              <span className="mt-0.5 block text-2xs leading-4 text-muted-foreground">
                {config.autoCompress ? '长对话会自动摘要早期消息' : '关闭（长会话可能超出模型窗口）'}
              </span>
            </span>
          </label>
        </div>
      </Section>

      {/* ── Agent 行为 ── */}
      <Section icon={Zap} title="Agent 行为" anchor="agent">
        <div className="space-y-3.5">
          <Field
            label="删除确认"
            htmlFor="delete-mode"
            hint={
              config.deleteMode === 'auto'
                ? '⚠ 删除提议与「删除全部」将立即执行，不再经过界面确认。'
                : 'Agent 只提交删除提议，你确认后才真正删除。'
            }
          >
            <Select
              id="delete-mode"
              value={config.deleteMode ?? 'confirm'}
              onChange={(e) => void update({ deleteMode: e.target.value as 'confirm' | 'auto' })}
            >
              <option value="confirm">始终需确认（推荐）</option>
              <option value="auto">无需确认（自动执行）</option>
            </Select>
          </Field>

          <Field
            label="执行前先看计划"
            htmlFor="plan-mode"
            hint={
              config.planMode
                ? 'Agent 改动书签前会先列计划等你确认；删除提议仍按上面的确认设置处理。'
                : 'Agent 直接执行移动/新建/重命名（可用「撤销本次操作」回退）。'
            }
          >
            <Select
              id="plan-mode"
              value={config.planMode ? 'on' : 'off'}
              onChange={(e) => void update({ planMode: e.target.value === 'on' })}
            >
              <option value="off">关闭（直接执行）</option>
              <option value="on">开启（先展示计划）</option>
            </Select>
          </Field>

          <label className="flex cursor-pointer items-center gap-2.5 rounded-sm border border-border bg-muted/40 px-3 py-2.5 transition-colors hover:border-border hover:bg-muted">
            <Checkbox
              checked={config.autoOrganizeNew ?? true}
              onCheckedChange={(v) => void update({ autoOrganizeNew: v })}
              aria-label="新书签自动整理"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">新书签自动整理</span>
              <span className="mt-0.5 block text-2xs leading-4 text-muted-foreground">
                {config.autoOrganizeNew ?? true
                  ? '收藏新页面后自动识别并归类：先认你已有的分类，认不出就问你（或留在原地，绝不替你新建按域名的文件夹）。每一步都能在「整理记录」里看见并撤销。'
                  : '关闭：新书签保持在你放的位置，需要手动整理（可随时在「整理记录」里补整理）'}
              </span>
            </span>
          </label>

          {/* 二级开关：只在上面的总开关打开时出现，避免调一个不生效的选项 */}
          {(config.autoOrganizeNew ?? true) && (
            <label className="ml-5 flex cursor-pointer items-center gap-2.5 rounded-sm border border-border bg-muted/20 px-3 py-2 transition-colors hover:bg-muted/40">
              <Checkbox
                checked={config.autoOrganizeAi ?? true}
                onCheckedChange={(v) => void update({ autoOrganizeAi: v })}
                aria-label="允许 AI 参与自动整理"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-foreground">允许 AI 参与自动整理</span>
                <span className="mt-0.5 block text-2xs leading-4 text-muted-foreground">
                  {config.autoOrganizeAi ?? true
                    ? '认不出归属时会问一次模型（每次收藏最多一次请求）。关闭后只用本地规则与域名，不发任何网址。'
                    : '已关闭：只用本地规则（站点名 / 类别匹配）与域名兜底，收藏动作不会向服务商发送网址。'}
                </span>
              </span>
            </label>
          )}

          {/* 设置页里能直接看到「它都干了什么」，而不是让用户自己找顶栏入口 */}
          <button
            type="button"
            onClick={() => void openUrl(chrome.runtime.getURL('page.html#organize'))}
            className="self-start text-2xs text-accent transition-colors hover:underline"
          >
            查看整理记录与补整理 →
          </button>
        </div>
      </Section>

      {/* ── 长期记忆 ── */}
      <Section
        icon={Brain}
        title="长期记忆"
        anchor="memory"
        badge={<Badge variant="outline">{memories.filter((m) => m.enabled).length} 条生效</Badge>}
      >
        <p className="mb-3 text-2xs leading-4 text-muted-foreground">
          记录你的整理偏好与规则（如「技术类按语言分类」「不要动工作文件夹」）。Agent 整理书签时会自动遵守，跨会话持续生效；对话中说「记住…」也会写入这里。
        </p>

        {/* 新增记忆 */}
        <div className="flex gap-1.5">
          <Input
            value={newMemContent}
            onChange={(e) => setNewMemContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleAddMemory();
            }}
            placeholder="例如：清理时保留最近 3 个月的链接"
            className="h-8 flex-1 text-xs"
            aria-label="新记忆内容"
          />
          <div className="w-20 shrink-0">
            <Select
              value={newMemCat}
              onChange={(e) => setNewMemCat(e.target.value as MemoryCategory)}
              className="h-8 text-xs"
              aria-label="记忆类型"
            >
              {(Object.keys(CATEGORY_LABELS) as MemoryCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" className="h-8 shrink-0" disabled={!newMemContent.trim()} onClick={() => void handleAddMemory()}>
            <Plus className="h-3.5 w-3.5" />
            添加
          </Button>
        </div>

        {/* 记忆列表 */}
        {memories.length === 0 ? (
          <p className="mt-3 rounded-sm border border-dashed border-border px-3 py-3 text-center text-2xs text-muted-foreground">
            还没有长期记忆。在对话里说「记住…」，或直接在上面添加。
          </p>
        ) : (
          <ul className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pr-0.5">
            {memories.map((m) => (
              <li
                key={m.id}
                className={cn(
                  'group flex items-start gap-2 rounded-sm border border-border px-2.5 py-2 transition-colors',
                  m.enabled ? 'bg-card' : 'bg-muted/40 opacity-70',
                )}
              >
                <Checkbox
                  checked={m.enabled}
                  aria-label={m.enabled ? '停用这条记忆' : '启用这条记忆'}
                  onCheckedChange={() => void toggleMemory(m.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-xs leading-4 break-words', m.enabled ? 'text-foreground' : 'text-muted-foreground line-through')}>
                    {m.content}
                  </p>
                  <p className="mt-0.5 text-2xs text-muted-foreground/70">
                    {CATEGORY_LABELS[m.category]} · 来源：Agent / 手动
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="删除这条记忆"
                  title="删除这条记忆"
                  onClick={() => void removeMemory(m.id)}
                  className="shrink-0 rounded-xs p-1 text-muted-foreground/50 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {memories.length > 0 && (
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="ghost" className="h-7 text-2xs text-muted-foreground hover:text-destructive" onClick={() => setConfirmClearMemories(true)}>
              <Trash2 className="h-3 w-3" />
              清空全部记忆
            </Button>
          </div>
        )}
      </Section>

      {/* ── 外观 ── */}
      <Section icon={Palette} title="外观" anchor="appearance">
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { value: 'light', label: '浅色', icon: Sun },
              { value: 'dark', label: '深色', icon: Moon },
              { value: 'system', label: '跟随系统', icon: Monitor },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => void useThemeStore.getState().setTheme(opt.value)}
              className={cn(
                'flex h-9 items-center justify-center gap-1.5 rounded-sm border text-xs transition-colors',
                theme === opt.value
                  ? 'border-accent/40 bg-accent-muted font-medium text-accent'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <opt.icon className="h-3.5 w-3.5" />
              {opt.label}
            </button>
          ))}
        </div>
      </Section>

      {/* ── 数据管理 ── */}
      <Section icon={Database} title="数据管理" anchor="data">
        {/*
         * 书签导出：浏览器通用的 Netscape HTML（可再导入 Chrome/Edge/Firefox/Safari）
         * 与 JSON（保留结构与时间戳）。
         *
         * 以前这里只能"清空"——用户说"帮我把书签备份一下"时没有任何入口，
         * 而 AI 的 export_bookmarks 只把清单交给模型分析、不产出文件。
         */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-foreground">书签导出</p>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {exportCounts
                ? `将导出 ${exportCounts.bookmarks} 条书签 · ${exportCounts.folders} 个文件夹`
                : '正在统计书签数量…'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={!exportCounts}
              onClick={() => void exportBookmarksNow('html')}
              data-testid="export-html"
              title="导出为浏览器通用的书签文件（可再导入）"
            >
              <Download className="h-3 w-3" />
              书签 HTML
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!exportCounts}
              onClick={() => void exportBookmarksNow('json')}
              data-testid="export-json"
              title="导出为 JSON（保留完整结构与时间戳）"
            >
              <Download className="h-3 w-3" />
              JSON
            </Button>
          </div>
        </div>
        {exportError && (
          <p className="mt-2 text-2xs text-destructive" data-testid="export-error">
            导出失败：{exportError}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-foreground">对话记录与待删除清单</p>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {dataCounts.messages} 条消息 · {dataCounts.pending} 项待删 · 清空后不可恢复
            </p>
          </div>
          <Button size="sm" variant="destructive" onClick={() => setConfirmClear(true)}>
            <Trash2 className="h-3 w-3" />
            清空
          </Button>
        </div>
      </Section>

      {/* ── 安全说明：次要信息，不占一张卡片 ── */}
      <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3.5">
        <h2 className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          安全机制
        </h2>
        <ul className="mt-2 space-y-1.5 text-2xs leading-4 text-muted-foreground">
          <li className="flex gap-2">
            <ChevronRight className="mt-1 h-2.5 w-2.5 shrink-0" />
            API Key 仅存于浏览器本地，不同步到云端；请求由后台直发所选服务商，无中间服务器。
          </li>
          <li className="flex gap-2">
            <ChevronRight className="mt-1 h-2.5 w-2.5 shrink-0" />
            删除默认需你确认；浏览器根文件夹（书签栏等）永远不可删除。
          </li>
        </ul>
      </div>

      {saveError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{saveError.message}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => {
              // 用返回值给出**真实**反馈：成功与失败不能显示同一句话
              void useConfigStore
                .getState()
                .update({})
                .then((r) =>
                  r.ok
                    ? pushToast('设置已保存', { variant: 'success' })
                    : pushToast('仍未保存成功', { variant: 'destructive', description: r.error }),
                );
            }}
          >
            重试保存
          </button>
        </div>
      )}

      {/* 清空确认 */}
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空本地数据"
        description="将删除全部聊天记录、待删清单与撤销记录（撤销记录里含被删书签的快照）。不影响书签本身，此操作不可撤销。"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)} autoFocus>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmClear(false);
                void clearLocalData();
              }}
            >
              清空
            </Button>
          </>
        }
      />

      {/* 清空记忆确认 */}
      <Dialog
        open={confirmClearMemories}
        onOpenChange={setConfirmClearMemories}
        title="清空全部长期记忆"
        description={`将删除全部 ${memories.length} 条长期记忆（偏好、规则与习惯）。Agent 此后将不再遵守这些约定，此操作不可撤销。`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmClearMemories(false)} autoFocus>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmClearMemories(false);
                void clearMemories();
                pushToast('长期记忆已清空', { variant: 'default' });
              }}
            >
              清空
            </Button>
          </>
        }
      />

      <footer className="flex flex-col items-center gap-1.5 pb-4 text-center text-2xs text-muted-foreground">
        <p>MarkAI v{appVersion()}</p>
        <p className="text-muted-foreground/70">
          支持 OpenAI / DeepSeek / Moonshot / Ollama 及任意 OpenAI 兼容服务
        </p>
        <button
          type="button"
          onClick={() => void openUrl('chrome://extensions/shortcuts')}
          className="text-accent transition-colors hover:underline"
        >
          自定义快捷键
        </button>
      </footer>
    </div>
  );
}

/** 页面顶部品牌条 */
export function OptionsHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur-sm">
      <div className="mx-auto flex max-w-2xl items-center justify-between">
        <BrandMark subtitle="设置" />
        <Badge variant="outline">书签管家 Agent</Badge>
      </div>
    </header>
  );
}
