import {
  AlertTriangle,
  ArrowUpRight,
  Brain,
  CheckCircle2,
  Database,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { useAIStore, AI_STORAGE_KEY } from '@/stores/aiStore';
import { useMemoryStore, initMemorySync } from '@/stores/memoryStore';
import { CATEGORY_LABELS, type MemoryCategory } from '@/lib/ai/memory';
import { clearUndoPoints } from '@/lib/undo/recorder';
import { countTree, toJsonExport, toNetscapeHtml } from '@/lib/bookmarks/export-file';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import {
  PROVIDERS,
  getPreset,
  getModelContextWindow,
  MIN_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
} from '@/lib/providers';
import { parseCustomHeaders } from '@/lib/ai/request-headers';
import type { OneShotOutbound } from '@/lib/ai/types';
import { pushToast } from '@/lib/toast';
import { openUrl } from '@/lib/open-url';
import { appVersion } from '@/lib/version';
import { Badge } from '@/components/ui/badge';
import { HealthPanel } from '@/components/health/health-panel';
import { ErrorBoundary } from '@/components/common/error-boundary';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { InlineAction, SettingRow, SettingsSection, ToggleRow } from '@/components/options/setting-primitives';
import { useSettingsSearch } from '@/components/options/settings-search';
import { cn } from '@/lib/utils';
import { findModel } from '@/lib/models/catalog';
import { effortLabel, reasoningControl } from '@/lib/models/control';
import { describeEffortRequest, effortInputIssue, sanitizeEffort } from '@/lib/models/effort';
import type { ModelCatalog } from '@/lib/models/types';
import type { ReasoningEffort } from '@/lib/ai/types';

/** token 数友好显示：400000 → 400K，1047000 → 1.05M */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * 主题缩略图：用真实的浅/深底色画一个迷你窗口，而不是一块纯色。
 * 「跟随系统」左右各一半——它本来就是两套都可能用到，画成单色会误导。
 */
function ThemePreview({ value }: { value: Theme }) {
  const line = (w: string, dark: boolean) => (
    <span className={cn('h-1 shrink-0 rounded-full', w, dark ? 'bg-[#38414f]' : 'bg-[#e8ecf2]')} />
  );
  if (value === 'system') {
    return (
      <span className="flex h-7 w-12 overflow-hidden rounded-sm border border-border">
        <span className="flex w-1/2 flex-col justify-center gap-0.5 bg-[#ffffff] px-1">
          {line('w-4', false)}
          {line('w-3', false)}
        </span>
        <span className="flex w-1/2 flex-col justify-center gap-0.5 bg-[#151a21] px-1">
          {line('w-4', true)}
          {line('w-3', true)}
        </span>
      </span>
    );
  }
  const dark = value === 'dark';
  return (
    <span
      className={cn(
        'flex h-7 w-12 flex-col justify-center gap-0.5 overflow-hidden rounded-sm border px-1',
        dark ? 'border-[#262d38] bg-[#151a21]' : 'border-[#e4e8ee] bg-[#ffffff]',
      )}
    >
      {line('w-8', dark)}
      {line('w-9', dark)}
      {line('w-6', dark)}
    </span>
  );
}

/** 主题卡片：比一行三个按钮更像"选择"，也能一眼看出当前用的是哪套 */
function ThemeCards() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const options: Array<{ value: Theme; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: Monitor },
  ];
  return (
    <div role="radiogroup" aria-label="界面主题" className="grid grid-cols-3 gap-2">
      {options.map((opt) => {
        const selected = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => void setTheme(opt.value)}
            className={cn(
              'flex h-[72px] flex-col items-center justify-center gap-1.5 rounded-lg border text-2xs transition-colors',
              selected
                ? 'border-accent/50 bg-accent-muted font-medium text-accent'
                : 'border-border text-muted-foreground hover:border-input hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <ThemePreview value={opt.value} />
            <span className="flex items-center gap-1">
              <opt.icon className="h-3 w-3" />
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** AI 配置表单：Provider 预设 / API Key / Base URL / 模型 + 连接测试 + 外观 + 数据管理 */
export function ConfigForm() {
  const { query: settingsQuery } = useSettingsSearch();
  const config = useConfigStore((s) => s.config);
  const loaded = useConfigStore((s) => s.loaded);
  const update = useConfigStore((s) => s.update);
  const applyPreset = useConfigStore((s) => s.applyPreset);

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
  // models.dev 目录：思考能力/上下文/价格的唯一来源（断网时 store 会退到内置快照并如实标注）
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClearMemories, setConfirmClearMemories] = useState(false);
  const [dataCounts, setDataCounts] = useState<{ messages: number; pending: number }>({ messages: 0, pending: 0 });

  /** 自定义思考强度：输入框草稿 / 是否展开 / 就地校验错误 */
  const [effortDraft, setEffortDraft] = useState('');
  const [effortCustomOpen, setEffortCustomOpen] = useState(false);
  const [effortError, setEffortError] = useState<string | null>(null);

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

  /**
   * 读取模型目录（缓存 24h；force = 强制刷新）。
   *
   * 走 background 代理：上游 api.json 有 5.7 MB，每个页面各拉一遍既费流量又各存一份缓存。
   * 失败不等于"没有目录"——store 会退到旧缓存或内置快照，并把来源写进 error 文案，
   * 这里原样显示，让用户知道眼前的能力数据到底新不新。
   */
  const reloadCatalog = async (force?: boolean) => {
    setCatalogLoading(true);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'ai:catalog', force: Boolean(force) })) as
        | OneShotOutbound
        | undefined;
      if (res?.type === 'ai:catalog:result') {
        setCatalog(res.catalog);
        setCatalogNotice(
          res.error ??
            (res.refreshed
              ? `目录已更新（${res.catalog.providers.length} 个服务商）。`
              : `目录来自 ${new Date(res.catalog.fetchedAt).toLocaleString('zh-CN')} 的缓存。`),
        );
      } else {
        setCatalogNotice('读取模型目录没有得到响应（后台可能已被回收），稍后点「刷新目录」重试。');
      }
    } catch (e) {
      setCatalogNotice(`读取模型目录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCatalogLoading(false);
    }
  };

  useEffect(() => {
    void reloadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 请求竞态纪元（测试连接 / 模型列表各自独立，避免并发时互相卡死对方状态）
  const testEpoch = useRef(0);
  const modelsEpoch = useRef(0);

  const preset = getPreset(config.providerId);
  const models = preset?.models ?? [];

  /*
   * 思考强度控件：目录给出的是**建议**（该上游声称支持哪些档位），
   * 用户还可以填任意合法自定义值（网关/中转/新档位）。是否可调由 control 决定，
   * 自定义入口始终可用——"目录没写"不等于"端点一定不认"。
   */
  const activeModel = config.model || preset?.defaultModel || '';
  const catalogPolicy = catalog ? (findModel(catalog, activeModel, config.providerId)?.reasoning ?? null) : null;
  const control = reasoningControl(catalogPolicy, activeModel);
  const chosenEffort = config.reasoningEffort ?? 'auto';
  const isPresetEffort = control.options.some((o) => o.value === chosenEffort);
  /** 已保存的值是目录外的自定义值（和"打开了编辑器但还没提交"是两回事） */
  const isCustomValue = chosenEffort !== 'auto' && !isPresetEffort;
  const showCustomEffort = effortCustomOpen || isCustomValue;
  /*
   * 「实际发送」预览：默认展示**已保存**的值；当用户正在自定义框里输入一个
   * 尚未提交的合法 token 时，改成「应用后将发送」，让他先看到结果再决定。
   * 这里不做乐观更新——预览说的是"会发什么"，不能替保存兜底。
   */
  const draftToken = sanitizeEffort(effortDraft);
  const pendingEffort = showCustomEffort && draftToken && draftToken !== chosenEffort ? draftToken : null;
  const previewEffort = pendingEffort ?? chosenEffort;
  const payloadPreview = describeEffortRequest(
    config.providerId,
    pendingEffort ? draftToken : chosenEffort,
  );
  const effortAdvisory =
    previewEffort !== 'auto' && catalogPolicy
      ? !catalogPolicy.supported
        ? '目录显示该模型不支持思考：这档仍会按你的选择发送，上游可能忽略或直接报错。'
        : catalogPolicy.efforts.length > 0 && !catalogPolicy.efforts.includes(previewEffort)
          ? `目录里该模型的档位是 ${catalogPolicy.efforts.map(effortLabel).join(' · ')}；你发的是「${effortLabel(previewEffort)}」，上游可能忽略。`
          : null
      : previewEffort !== 'auto' && !catalogPolicy
        ? '目录里查不到该模型：这档会按你的选择发送，是否能被识别由端点决定。'
        : null;

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

  // 思考强度：外部值变化时同步自定义输入框（用户正在编辑时不覆盖）
  useEffect(() => {
    if (effortCustomOpen) return;
    setEffortDraft(chosenEffort === 'auto' ? '' : chosenEffort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenEffort]);

  // 点「自定义」就直接把光标放进输入框：用户点它就是为了改值，别让他再点一次
  useEffect(() => {
    if (!effortCustomOpen) return;
    const t = setTimeout(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="自定义思考强度"]')?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [effortCustomOpen]);

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

  if (!loaded) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl border border-border bg-card" />
        ))}
        <p className="text-center text-2xs text-muted-foreground">正在读取设置…</p>
      </div>
    );
  }

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
          /*
           * 服务商返回了当前模型上下文长度 → 自动填入设置。
           *
           * 必须按 effectiveContextWindow 的同一组边界收窄：以前这里只校验了下限，
           * 服务商报个 1000 万就原样存进去，随后被静默钳回 200 万——
           * toast 说「上下文 10000000」、实际生效 2000000，用户被两个数字耍。
           */
          if (typeof res.contextWindow === 'number' && res.contextWindow >= MIN_CONTEXT_WINDOW) {
            void update({
              contextWindow: Math.min(Math.round(res.contextWindow), MAX_CONTEXT_WINDOW),
            });
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

  /** 选目录里的档位（含「默认」）：离开自定义编辑态 */
  const selectEffortValue = (value: string) => {
    setEffortCustomOpen(false);
    setEffortError(null);
    void update({ reasoningEffort: value as ReasoningEffort });
  };

  /** 提交自定义档位：净化 → 校验 → 写回；空值视为"不发送" */
  const commitCustomEffort = () => {
    const issue = effortInputIssue(effortDraft);
    if (issue) {
      setEffortError(issue);
      return;
    }
    const v = sanitizeEffort(effortDraft);
    setEffortError(null);
    if (!v) {
      setEffortCustomOpen(false);
      void update({ reasoningEffort: 'auto' });
      return;
    }
    void update({ reasoningEffort: v as ReasoningEffort });
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
      {needsSetup && !settingsQuery && (
        <div className="animate-fade-in rounded-xl border border-accent/25 bg-accent-muted/50 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">三步开始用</p>
              <ol className="mt-1.5 space-y-1 text-2xs leading-4 text-muted-foreground">
                {[
                  '选服务商：国内网络建议 DeepSeek 或 Moonshot Kimi；本地无成本用 Ollama',
                  '填 API Key：只存在这台电脑的浏览器里，请求由后台直连服务商',
                  '点下面的「测试连接」，通过后打开书签页（或浏览器侧边栏）就能开始整理',
                ].map((text, i) => (
                  <li key={text} className="flex gap-2">
                    <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-card text-2xs font-medium text-accent">
                      {i + 1}
                    </span>
                    <span className="min-w-0">{text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* ── 健康检查 ──
          放第一位：用户会打开设置页，多半就是"感觉哪里不对"。
          先让他看到明确结论，再往下才是逐项配置。 */}
      <ErrorBoundary area="健康检查"><SettingsSection
        id="health"
        icon={ShieldCheck}
        title="健康检查"
        description="一眼看清扩展、权限、存储与 AI 连接有没有问题；能修的就地修，不能修的给你一份可复制的诊断。"
        keywords="健康 体检 诊断 health diagnostics 修复"
      >
        {/*
         * 体检要读 chrome.* 与 storage，任何一项抛错都会让整个设置页白屏——
         * 而设置页恰恰是用户"出问题时才来"的地方，白屏等于彻底失去自救入口。
         * 包一层边界：最坏情况是这一节显示失败原因，其余配置项照常可改。
         */}
        <div className="px-5 py-4">
          <ErrorBoundary area="健康检查"><HealthPanel /></ErrorBoundary>
        </div>
      </SettingsSection></ErrorBoundary>

      {/* ── AI 服务 ── */}
      <ErrorBoundary area="AI 服务">
        <SettingsSection
          id="ai"
          icon={Plug}
          title="AI 服务"
          description="决定这个 Agent 用谁的大脑。兼容 OpenAI 协议的官方端点、中转站与本地 Ollama 都可以。"
          keywords="AI 服务 模型 provider 提供商 api key base url 密钥 端点 连接 测试"
          badge={
            <Badge variant="outline">
              {preset?.name ?? '自定义端点'} · {config.model || preset?.defaultModel || '未选模型'}
            </Badge>
          }
          footer={
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Button size="sm" variant="secondary" disabled={testing} onClick={() => void runTest()}>
                {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
                测试连接
              </Button>
              {testResult ? (
                <span
                  role="status"
                  className={cn(
                    'flex min-w-0 items-start gap-1.5 text-2xs leading-4',
                    testResult.ok ? 'text-success' : 'text-destructive',
                  )}
                >
                  {testResult.ok && <CheckCircle2 className="mt-px h-3 w-3 shrink-0" />}
                  <span className="min-w-0">{testResult.message}</span>
                </span>
              ) : (
                <span className="text-2xs text-muted-foreground">保存即生效；测试使用表单里当前的配置。</span>
              )}
            </div>
          }
        >
          <SettingRow
            label="服务商"
            htmlFor="provider"
            keywords="服务商 供应商 provider 预设 preset"
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
          </SettingRow>

          <SettingRow
            label="Base URL"
            htmlFor="base-url"
            keywords="base url 地址 端点 endpoint 网关 中转 ollama"
            hint="兼容 OpenAI 协议；本地 Ollama 默认 http://localhost:11434/v1"
            controlClassName="sm:w-80"
          >
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
          </SettingRow>

          {preset?.needsKey && (
            <SettingRow
              label="API Key"
              htmlFor="api-key"
              keywords="api key 密钥 令牌 token apikey"
              hint="只写进这台电脑的浏览器本地存储；不会同步到云端。"
              controlClassName="sm:w-80"
            >
              <div className="relative w-full">
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
            </SettingRow>
          )}

          <SettingRow
            label="模型"
            htmlFor="model"
            keywords="模型 model 名称 拉取 列表 models"
            controlClassName="sm:w-80"
            hint={
              remoteModels.length > 0
                ? `已拉取 ${remoteModels.length} 个模型，可在输入框下拉选择。`
                : '可以直接输入模型名；也可以从服务商拉取列表。'
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
          </SettingRow>

          <SettingRow
            label="思考强度"
            keywords="思考 思考强度 推理 reasoning effort thinking 档位"
            hint={
              catalogLoading && !catalog ? (
                '正在读取模型目录…'
              ) : (
                <>
                  {control.hint}
                  {catalogNotice && (
                    <span className="mt-0.5 block text-2xs text-muted-foreground/80">{catalogNotice}</span>
                  )}
                </>
              )
            }
            wide
            action={
              <InlineAction
                onClick={() => void reloadCatalog(true)}
                disabled={catalogLoading}
                busy={catalogLoading}
                icon={RefreshCw}
                title="强制刷新 models.dev 模型目录（忽略 24 小时缓存）"
              >
                刷新目录
              </InlineAction>
            }
          >
            <div className="space-y-2">
              <div
                role="radiogroup"
                aria-label="思考强度"
                className="flex flex-wrap items-center gap-1.5"
                data-testid="reasoning-effort"
              >
                {control.options.map((opt) => {
                  const selected = chosenEffort === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!control.interactive}
                      onClick={() => selectEffortValue(opt.value)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-2xs transition-colors',
                        selected
                          ? 'border-accent/50 bg-accent-muted font-medium text-accent'
                          : 'border-border text-muted-foreground',
                        control.interactive
                          ? 'hover:border-input hover:text-foreground'
                          : 'cursor-not-allowed opacity-50',
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                {/* 自定义入口不受目录能力限制：目录只是建议，端点才说了算 */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={isCustomValue}
                  onClick={() => {
                    setEffortCustomOpen(true);
                    setEffortError(null);
                  }}
                  className={cn(
                    'rounded-full border border-dashed px-2.5 py-1 text-2xs transition-colors',
                    isCustomValue
                      ? 'border-accent/50 bg-accent-muted font-medium text-accent'
                      : showCustomEffort
                        ? 'border-accent/40 text-accent'
                        : 'border-border text-muted-foreground hover:border-input hover:text-foreground',
                  )}
                >
                  自定义
                </button>
              </div>

              {showCustomEffort && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={effortDraft}
                    onChange={(e) => {
                      setEffortDraft(e.target.value);
                      setEffortError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        commitCustomEffort();
                      }
                    }}
                    onBlur={commitCustomEffort}
                    placeholder="例如 ultra / adaptive / 3"
                    spellCheck={false}
                    aria-label="自定义思考强度"
                    className="h-7 w-44 font-mono text-2xs"
                  />
                  <Button size="sm" variant="secondary" className="h-7" onClick={commitCustomEffort}>
                    应用
                  </Button>
                  <span className="text-2xs text-muted-foreground">
                    会原样写入请求体；先看下面的预览再确认。
                  </span>
                </div>
              )}

              {effortError && (
                <p role="alert" className="text-2xs leading-4 text-destructive">
                  {effortError}
                </p>
              )}

              {/* 诚实预览：选了档位就该看见它到底以什么字段发出去 */}
              <p className="text-2xs leading-4 text-muted-foreground">
                {pendingEffort ? '应用后将发送：' : '实际发送：'}{' '}
                <code className="rounded-xs bg-muted px-1.5 py-0.5 font-mono text-foreground">
                  {payloadPreview}
                </code>
              </p>
              {effortAdvisory && (
                <p className="flex items-start gap-1 text-2xs leading-4 text-muted-foreground">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">{effortAdvisory}</span>
                </p>
              )}
            </div>
          </SettingRow>

          <SettingRow
            label="自定义请求头"
            htmlFor="custom-headers"
            keywords="请求头 header headers 网关 会话 session"
            wide
            hint={
              preset?.sessionHeader ? (
                <>
                  已自动带上 <code className="text-foreground">{preset.sessionHeader}</code>
                  （每个安装一个稳定 ID，不用手填；服务端靠它把同一会话路由到同一节点、让提示缓存生效）。 下面只填服务商额外要求的头，每行一条{' '}
                  <code className="text-foreground">Name: Value</code>。
                </>
              ) : (
                <>
                  有些网关在标准协议之外要求额外请求头（例如 OpenCode Go 的{' '}
                  <code className="text-foreground">x-opencode-session</code>，缺了直接 400）。 每行一条{' '}
                  <code className="text-foreground">Name: Value</code>；空行与 <code className="text-foreground">#</code> 开头的行忽略。
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
              <ul role="alert" className="mt-1.5 space-y-0.5 text-2xs leading-4 text-destructive">
                {headerErrors.map((err) => (
                  <li key={err} className="flex items-start gap-1">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                    <span className="min-w-0">{err}</span>
                  </li>
                ))}
              </ul>
            )}
          </SettingRow>
        </SettingsSection>
      </ErrorBoundary>

      {/* ── 上下文与预算 ── */}
      <ErrorBoundary area="上下文与预算">
        <SettingsSection
          id="context"
          icon={SlidersHorizontal}
          title="上下文与预算"
          description="一次对话能带多少历史、什么时候开始压缩。数字来自模型本身，不确定就跟随模型。"
          keywords="上下文 窗口 context window token 预算 压缩 threshold"
        >
          <SettingRow
            label="模型上下文长度"
            htmlFor="context-window"
            keywords="上下文 窗口 context window token 长度"
            action={
              !isAuto && (
                <button
                  type="button"
                  onClick={resetCtxToModel}
                  title={`清除手动值，改回跟随模型（${autoHint}）`}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-2xs whitespace-nowrap text-accent transition-colors hover:bg-accent-muted"
                >
                  <Sparkles className="h-3 w-3" />
                  跟随模型
                </button>
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
            controlClassName="sm:w-48"
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
          </SettingRow>

          <SettingRow
            label="自动压缩阈值"
            htmlFor="compress-threshold"
            keywords="压缩 阈值 compress threshold 摘要 预算"
            wide
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
              <span className="w-32 shrink-0 text-right text-2xs text-muted-foreground">
                {Math.round((config.compressThreshold ?? 0.8) * 100)}% · 预算{' '}
                {formatTokens(Math.round(effectiveWindow * (config.compressThreshold ?? 0.8)))}
              </span>
            </div>
          </SettingRow>

          {/* 自动压缩：与上面那条阈值是配套的开关，紧贴在一起 */}
          <ToggleRow
            label="自动压缩上下文"
            keywords="自动压缩 compress 摘要"
            checked={config.autoCompress ?? false}
            onCheckedChange={(v) => void update({ autoCompress: v })}
            hint={config.autoCompress ? '长对话会自动摘要早期消息' : '关闭（长会话可能超出模型窗口）'}
          />
        </SettingsSection>
      </ErrorBoundary>

      {/* ── Agent 行为 ── */}
      <ErrorBoundary area="Agent 行为">
        <SettingsSection
          id="agent"
          icon={Zap}
          title="Agent 行为"
          description="它动手之前要不要问、删除怎么确认、新书签怎么整理。默认值都偏保守。"
          keywords="agent 行为 删除 确认 计划 plan 整理 自动 organize"
          footer={
            <button
              type="button"
              onClick={() => void openUrl(chrome.runtime.getURL('page.html#organize'))}
              className="flex items-center gap-1 text-2xs text-accent transition-colors hover:underline"
            >
              查看整理记录与补整理
              <ArrowUpRight className="h-3 w-3" />
            </button>
          }
        >
          <SettingRow
            label="删除确认"
            htmlFor="delete-mode"
            keywords="删除 确认 delete confirm 危险"
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
          </SettingRow>

          <ToggleRow
            label="执行前先看计划"
            keywords="计划 plan mode 预览 确认"
            checked={Boolean(config.planMode)}
            onCheckedChange={(v) => void update({ planMode: v })}
            hint={
              config.planMode
                ? 'Agent 改动书签前会先列计划等你确认；删除提议仍按上面的确认设置处理。'
                : 'Agent 直接执行移动/新建/重命名（可用「撤销本次操作」回退）。'
            }
          />

          <ToggleRow
            label="新书签自动整理"
            keywords="自动整理 organize 新书签 收藏"
            checked={config.autoOrganizeNew ?? true}
            onCheckedChange={(v) => void update({ autoOrganizeNew: v })}
            hint={
              config.autoOrganizeNew ?? true
                ? '收藏新页面后自动识别并归类：先认你已有的分类，认不出就问你（或留在原地，绝不替你新建按域名的文件夹）。每一步都能在「整理记录」里看见并撤销。'
                : '关闭：新书签保持在你放的位置，需要手动整理（可随时在「整理记录」里补整理）'
            }
          />

          {/* 二级开关：只在上面的总开关打开时出现，避免调一个不生效的选项 */}
          {(config.autoOrganizeNew ?? true) && (
            <ToggleRow
              nested
              label="允许 AI 参与自动整理"
              keywords="AI 整理 自动 请求 隐私"
              checked={config.autoOrganizeAi ?? true}
              onCheckedChange={(v) => void update({ autoOrganizeAi: v })}
              hint={
                config.autoOrganizeAi ?? true
                  ? '认不出归属时会问一次模型（每次收藏最多一次请求）。关闭后只用本地规则与域名，不发任何网址。'
                  : '已关闭：只用本地规则（站点名 / 类别匹配）与域名兜底，收藏动作不会向服务商发送网址。'
              }
            />
          )}
        </SettingsSection>
      </ErrorBoundary>

      {/* ── 长期记忆 ── */}
      <ErrorBoundary area="长期记忆">
        <SettingsSection
          id="memory"
          icon={Brain}
          title="长期记忆"
          description="记录你的整理偏好与规则（如「技术类按语言分类」「不要动工作文件夹」）。整理书签时自动遵守，跨会话持续生效。"
          keywords="记忆 memory 偏好 规则 习惯 长期"
          badge={<Badge variant="outline">{memories.filter((m) => m.enabled).length} 条生效</Badge>}
        >
          <SettingRow label="新增记忆" keywords="新增 添加 记忆 memory" wide hint="对话里说「记住…」也会写入这里。">
            <div className="flex flex-col gap-1.5 sm:flex-row">
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
              <div className="flex gap-1.5">
                <div className="w-24 shrink-0">
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
            </div>
          </SettingRow>

          <SettingRow
            label="记忆列表"
            keywords="记忆 memory 列表 启用 停用 删除"
            wide
            hint={memories.length > 0 ? '停用的记忆仍然保留，只是不参与整理决策。' : undefined}
          >
            {memories.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-2xs text-muted-foreground">
                还没有长期记忆。在对话里说「记住…」，或直接在上面添加。
              </p>
            ) : (
              <>
                <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
                  {memories.map((m) => (
                    <li
                      key={m.id}
                      className={cn(
                        'group flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 transition-colors',
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
                        <p
                          className={cn(
                            'text-xs leading-4 break-words',
                            m.enabled ? 'text-foreground' : 'text-muted-foreground line-through',
                          )}
                        >
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
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-2xs text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmClearMemories(true)}
                  >
                    <Trash2 className="h-3 w-3" />
                    清空全部记忆
                  </Button>
                </div>
              </>
            )}
          </SettingRow>
        </SettingsSection>
      </ErrorBoundary>

      {/* ── 个性化 ── */}
      <ErrorBoundary area="个性化">
        <SettingsSection
          id="personalize"
          icon={Sparkles}
          title="个性化"
          description="只影响它怎么说话，不影响它做什么。三个值都真的会被带进提示词。"
          keywords="个性化 称呼 名字 详略 verbosity 主动 proactivity persona"
        >
          <SettingRow
            label="称呼"
            htmlFor="address-name"
            keywords="称呼 名字 昵称 address name"
            hint="留空 = 不称呼（不会自作主张叫「主人」）"
          >
            <Input
              id="address-name"
              value={config.addressName ?? ''}
              onChange={(e) => void update({ addressName: e.target.value })}
              placeholder="例如：小明"
              maxLength={16}
              spellCheck={false}
            />
          </SettingRow>

          <SettingRow label="回答详略" htmlFor="verbosity" keywords="详略 长度 verbosity concise detailed" hint="只影响回答长度，不影响它做什么。">
            <Select
              id="verbosity"
              value={config.verbosity ?? 'normal'}
              onChange={(e) => void update({ verbosity: e.target.value as 'concise' | 'normal' | 'detailed' })}
            >
              <option value="concise">简短（先给结论）</option>
              <option value="normal">正常（默认）</option>
              <option value="detailed">详细（说明原因与回退方式）</option>
            </Select>
          </SettingRow>

          <SettingRow label="主动程度" htmlFor="proactivity" keywords="主动 proactivity 建议 安静" hint="「主动」时它会提一条具体建议；「安静」时只在你问的时候说。">
            <Select
              id="proactivity"
              value={config.proactivity ?? 'normal'}
              onChange={(e) => void update({ proactivity: e.target.value as 'quiet' | 'normal' | 'active' })}
            >
              <option value="quiet">安静（只在被问时说）</option>
              <option value="normal">正常（默认）</option>
              <option value="active">主动（会提一条建议）</option>
            </Select>
          </SettingRow>
        </SettingsSection>
      </ErrorBoundary>

      {/* ── 外观 ── */}
      <ErrorBoundary area="外观">
        <SettingsSection
          id="appearance"
          icon={Palette}
          title="外观"
          description="设置页、侧边栏与弹窗共用同一套主题；切换立即生效并记住。"
          keywords="外观 主题 浅色 深色 系统 theme dark light"
        >
          <SettingRow label="界面主题" keywords="主题 外观 theme dark light 系统" wide hint="跟随系统会随 macOS / Windows 的深浅模式自动切换。">
            <ThemeCards />
          </SettingRow>
        </SettingsSection>
      </ErrorBoundary>

      {/* ── 数据管理 ── */}
      <ErrorBoundary area="数据管理">
        <SettingsSection
          id="data"
          icon={Database}
          title="数据管理"
          description="把书签带走，或把本地对话与撤销记录清干净。清空动作都不会动你的书签。"
          keywords="数据 导出 备份 清空 export json html 隐私"
        >
          {/*
           * 书签导出：浏览器通用的 Netscape HTML（可再导入 Chrome/Edge/Firefox/Safari）
           * 与 JSON（保留结构与时间戳）。
           *
           * 以前这里只能"清空"——用户说"帮我把书签备份一下"时没有任何入口，
           * 而 AI 的 export_bookmarks 只把清单交给模型分析、不产出文件。
           */}
          <SettingRow label="书签导出" keywords="导出 备份 export html json 书签" wide>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-2xs text-muted-foreground">
                {exportCounts
                  ? `将导出 ${exportCounts.bookmarks} 条书签 · ${exportCounts.folders} 个文件夹`
                  : '正在统计书签数量…'}
              </p>
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
          </SettingRow>

          <SettingRow label="对话记录与待删除清单" keywords="清空 删除 对话 记录 本地数据 隐私" wide>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-2xs text-muted-foreground">
                {dataCounts.messages} 条消息 · {dataCounts.pending} 项待删 · 清空后不可恢复
              </p>
              <Button size="sm" variant="destructive" className="shrink-0" onClick={() => setConfirmClear(true)}>
                <Trash2 className="h-3 w-3" />
                清空
              </Button>
            </div>
          </SettingRow>
        </SettingsSection>
      </ErrorBoundary>

      {/* ── 安全说明：次要信息，不占一张卡片 ── */}
      <SettingsSection
        id="security"
        icon={ShieldCheck}
        title="安全机制"
        description={'三条边界，避免“以为它不会做”和“以为它做不到”。'}
        keywords="安全 隐私 key 权限 删除 privacy security"
      >
        <ul className="space-y-2.5 px-5 py-4 text-2xs leading-4 text-muted-foreground">
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            API Key 仅存于浏览器本地，不同步到云端；请求由后台直接发向你填的 Base URL。
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            内置预设（OpenAI / DeepSeek / Moonshot / 智谱 / Ollama / OpenCode）都是服务商官方地址。 若你选了「自定义」并填了自己的
            Base URL，请求就会经过「那个」地址—— 它是不是中转、由谁运营，只有你自己知道，请只填你信任的端点。
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            删除默认需你确认；浏览器根文件夹（书签栏等）永远不可删除。
          </li>
        </ul>
      </SettingsSection>

      {saveError && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{saveError.message}</span>
          <button
            type="button"
            className="shrink-0 font-medium underline"
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

      <footer className="flex flex-col items-center gap-1.5 pt-2 pb-2 text-center text-2xs text-muted-foreground">
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
