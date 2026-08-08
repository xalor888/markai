import { CheckCircle2, Database, Eye, EyeOff, Loader2, Monitor, Moon, Palette, Plug, RefreshCw, ShieldCheck, SlidersHorizontal, Sun, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { useAIStore, AI_STORAGE_KEY } from '@/stores/aiStore';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { PROVIDERS, getPreset } from '@/lib/providers';
import type { OneShotOutbound } from '@/lib/ai/types';
import { pushToast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

/** token 数友好显示：400000 → 400K，1047000 → 1.05M */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
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
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [dataCounts, setDataCounts] = useState<{ messages: number; pending: number }>({ messages: 0, pending: 0 });
  // 模型上下文输入：本地字符串 state（受控 value 派生 + onChange 过滤会拦截 64K/100K 等合法输入）
  // 默认 1024K：绝大多数大模型可直接用，无需手动填写
  const [ctxInput, setCtxInput] = useState(() => String(Math.round((config.contextWindow ?? 1_048_576) / 1000)));
  // 请求竞态纪元（测试连接 / 模型列表各自独立，避免并发时互相卡死对方状态）
  const testEpoch = useRef(0);
  const modelsEpoch = useRef(0);

  const preset = getPreset(config.providerId);
  const models = preset?.models ?? [];

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
  useEffect(() => {
    setCtxInput(String(Math.round((config.contextWindow ?? 1_048_576) / 1000)));
  }, [config.contextWindow]);

  if (!loaded) return <p className="text-xs text-muted-foreground">加载中…</p>;

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
      const clamped = Math.min(Math.max(Math.round(k), 8), 4000);
      void update({ contextWindow: clamped * 1000 });
      setCtxInput(String(clamped));
    } else {
      setCtxInput(String(Math.round((config.contextWindow ?? 1_048_576) / 1000)));
    }
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

  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      {/* ── AI 服务 ── */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Plug className="h-3.5 w-3.5 text-accent" />
          AI 服务
        </h2>

        <div className="space-y-1.5">
          <Label htmlFor="provider">服务商</Label>
          <select
            id="provider"
            className="h-8 w-full appearance-none rounded-sm border border-input bg-card px-2 text-xs text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
          </select>
          <p className="text-[11px] text-muted-foreground">
            {preset?.needsKey ? '该服务商需要 API Key。' : '本地服务（如 Ollama）无需 API Key。'}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="base-url">Base URL</Label>
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
          <p className="text-[11px] text-muted-foreground">
            兼容 OpenAI 协议；本地 Ollama 默认 http://localhost:11434/v1
          </p>
        </div>

        {preset?.needsKey && (
          <div className="space-y-1.5">
            <Label htmlFor="api-key">API Key</Label>
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
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="model">模型</Label>
            <button
              type="button"
              disabled={fetchingModels}
              onClick={() => void fetchModels()}
              className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent-muted disabled:pointer-events-none disabled:opacity-40"
              title="从服务商拉取最新模型列表（GET /models）"
            >
              {fetchingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              获取模型列表
            </button>
          </div>
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
          {remoteModels.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              已从服务商拉取 {remoteModels.length} 个模型，可在输入框下拉选择。
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" variant="secondary" disabled={testing} onClick={() => void runTest()}>
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
            测试连接
          </Button>
          {testResult && (
            <span
              role="status"
              className={
                testResult.ok
                  ? 'flex items-center gap-1 text-[11px] text-success'
                  : 'text-[11px] text-destructive'
              }
            >
              {testResult.ok && <CheckCircle2 className="h-3 w-3" />}
              {testResult.message}
            </span>
          )}
        </div>
      </section>

      {/* ── 删除与上下文 ── */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5 text-accent" />
          删除与上下文
        </h2>

        {/* 删除确认模式 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="delete-mode">删除确认</Label>
            <span className="text-[11px] text-muted-foreground">
              {config.deleteMode === 'auto' ? '无需确认（自动执行）' : '始终需确认（推荐）'}
            </span>
          </div>
          <select
            id="delete-mode"
            className="h-8 w-full appearance-none rounded-sm border border-input bg-card px-2 text-xs text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={config.deleteMode ?? 'confirm'}
            onChange={(e) => void update({ deleteMode: e.target.value as 'confirm' | 'auto' })}
          >
            <option value="confirm">始终需确认（推荐）</option>
            <option value="auto">无需确认（AI 提议自动执行）</option>
          </select>
          <p className="text-[11px] leading-4 text-muted-foreground">
            {config.deleteMode === 'auto'
              ? '⚠ Agent 的删除提议与「删除全部」将立即执行，不再经过界面确认。'
              : 'Agent 只能提交删除提议，你在聊天卡片或待删清单确认后才真正删除。'}
          </p>
        </div>

        {/* 上下文：模型上下文长度（默认 1024K）+ 压缩阈值 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="context-window">模型上下文长度</Label>
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={fetchingModels}
              className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent-muted disabled:pointer-events-none disabled:opacity-40"
              title="从服务商拉取模型信息（若返回 context_window 会自动填入）"
            >
              {fetchingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              从服务商获取
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              id="context-window"
              type="number"
              min={8}
              max={4000}
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
            <span className="text-[11px] text-muted-foreground">K tokens（千 token）</span>
          </div>
          <p className="text-[11px] leading-4 text-muted-foreground">
            填写你所用模型的实际上下文长度（例如 128K、256K、1M）。拉取模型列表时若服务商返回 context_window 会自动填入。
          </p>
        </div>

        {/* 压缩阈值 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="compress-threshold">自动压缩阈值</Label>
            <span className="text-[11px] text-muted-foreground">
              {Math.round((config.compressThreshold ?? 0.8) * 100)}%
              · 预算 {formatTokens(Math.round((config.contextWindow ?? 1_048_576) * (config.compressThreshold ?? 0.8)))}
            </span>
          </div>
          <input
            id="compress-threshold"
            type="range"
            min={50}
            max={95}
            step={5}
            value={Math.round((config.compressThreshold ?? 0.8) * 100)}
            onChange={(e) => void update({ compressThreshold: Number(e.target.value) / 100 })}
            className="w-full accent-[--color-accent]"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            对话历史用量达到「上下文长度 × 阈值」时，自动把早期消息压缩为摘要（需开启下面的自动压缩），保证不超出模型上下文。
          </p>
        </div>

        {/* 上下文自动压缩 */}
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={config.autoCompress ?? false}
            onChange={(e) => void update({ autoCompress: e.target.checked })}
            className="h-3.5 w-3.5 accent-[--color-accent]"
          />
          <span className="text-xs text-foreground">自动压缩上下文</span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {config.autoCompress ? '长对话自动摘要早期消息' : '关闭'}
          </span>
        </label>
        <p className="text-[11px] leading-4 text-muted-foreground">
          开启后，历史消息超过上限时会先把早期消息压缩为摘要，再继续对话（避免长会话丢失记忆）。
        </p>
      </section>

      {/* ── 安全说明 ── */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-accent" />
          安全机制
        </h2>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-4 text-muted-foreground">
          <li>· API Key 仅存储在浏览器本地（chrome.storage.local），不会同步到云端。</li>
          <li>· AI 请求由浏览器后台直接发给所选服务商，扩展不经过任何中间服务器。</li>
          <li>· Agent 可以执行移动/新建/重命名；删除默认需你确认，可切换为「无需确认」模式。</li>
          <li>· 浏览器根文件夹（书签栏等）永远不可删除。</li>
        </ul>
      </section>

      <Separator />

      {/* ── 外观 ── */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Palette className="h-3.5 w-3.5 text-accent" />
          外观
        </h2>
        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
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
                  ? 'border-accent/40 bg-accent-muted text-accent'
                  : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <opt.icon className="h-3.5 w-3.5" />
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* ── 数据管理 ── */}
      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Database className="h-3.5 w-3.5 text-accent" />
          数据管理
        </h2>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-foreground">
              对话记录与待删除清单
              <span className="ml-1.5 text-[11px] text-muted-foreground">
                {dataCounts.messages} 条消息 · {dataCounts.pending} 项待删
              </span>
            </p>
            <p className="text-[11px] text-muted-foreground">清空后不可恢复</p>
          </div>
          <Button size="sm" variant="destructive" onClick={() => setConfirmClear(true)}>
            <Trash2 className="h-3 w-3" />
            清空
          </Button>
        </div>
      </section>

      {/* 清空确认 */}
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空本地数据"
        description="将删除全部聊天记录与待删除清单（不影响书签本身）。此操作不可撤销。"
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

      <p className="pb-4 text-center text-[11px] text-muted-foreground">
        MarkAI v0.2.0 · 支持 OpenAI / DeepSeek / Moonshot / Ollama 及任意 OpenAI 兼容服务
        {' · '}
        <button
          type="button"
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {})}
          className="text-accent transition-colors hover:underline"
        >
          自定义快捷键
        </button>
      </p>
    </div>
  );
}

/** 页面顶部品牌条 */
export function OptionsHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-3">
      <div className="mx-auto flex max-w-md items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-sm border border-accent/30 bg-accent-muted text-accent text-xs font-medium">
            M
          </span>
          <span className="text-sm font-medium text-foreground">
            Mark<span className="text-accent">AI</span> 设置
          </span>
        </div>
        <Badge variant="outline">浏览器书签管家 Agent</Badge>
      </div>
    </header>
  );
}
