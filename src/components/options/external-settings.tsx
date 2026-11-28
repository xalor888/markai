/**
 * 设置页「对外接口」分区。
 *
 * 这里的每个控件都必须真的做事：
 *  · 开关写配置并让 background 重启轮询（不重启 = 显示已开但永远没请求）；
 *  · token 只在本机生成，可复制、可轮换（轮换会让旧 token 立刻失效）；
 *  · 写操作默认关闭，删除永远只是"提议"——界面上说清楚，不留暗示；
 *  · 审计日志可查可清，只记"谁在什么时候做了什么"。
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plug, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { SettingsSection, SettingRow, ToggleRow } from '@/components/options/setting-primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  EXTERNAL_API_DEFAULT,
  EXTERNAL_STORAGE_KEY,
  type ExternalApiConfig,
  type ExternalAuditEntry,
} from '@/lib/features/external';
import { MIN_TOKEN_LENGTH, generateToken, toolManifest } from '@/lib/external/protocol';
import {
  appendAudit,
  clearAudit,
  readAudit,
  readExternalConfig,
  writeExternalConfig,
} from '@/lib/external/runtime';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** 审计时间格式：只到分钟，日志不需要秒级精度 */
function fmtTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ExternalSettingsSection() {
  const [config, setConfig] = useState<ExternalApiConfig>(EXTERNAL_API_DEFAULT);
  const [audit, setAudit] = useState<ExternalAuditEntry[]>([]);
  const [copied, setCopied] = useState<'token' | 'config' | 'mcp' | 'cli' | 'skill' | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const [c, a] = await Promise.all([readExternalConfig(), readAudit()]);
    if (c) setConfig(c);
    setAudit(a);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    // 另一个窗口改了配置：这里跟着变，避免"两边显示不一致"
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === 'local' && changes[EXTERNAL_STORAGE_KEY]) void refresh();
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    } catch {
      return;
    }
  }, [refresh]);

  const save = async (patch: Partial<ExternalApiConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    try {
      await writeExternalConfig(next);
    } catch (e) {
      pushToast('保存对外接口设置失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const rotateToken = async () => {
    try {
      const token = generateToken();
      await save({ token, enabled: config.enabled });
      pushToast('已生成新 token', {
        description: '旧 token 立即失效，请把新 token 填进本机桥的 --token。',
        variant: 'success',
      });
    } catch (e) {
      pushToast('无法生成 token', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const copy = async (kind: 'token' | 'config') => {
    const text =
      kind === 'token'
        ? config.token
        : `node tools/markai-bridge.mjs --token ${config.token || '<TOKEN>'} --port ${config.port}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_600);
    } catch {
      pushToast('复制失败', { description: '浏览器拒绝了剪贴板访问，请手动选中复制。', variant: 'destructive' });
    }
  };

  /*
   * 三种接入方式的命令各复制各的：MCP 客户端要 JSON 配置，CLI 用户要一条 export，
   * Skill 要的是安装脚本。合成一条"万能命令"只会让每种人都要自己再删一半。
   */
  const copyCommand = async (kind: 'mcp' | 'cli' | 'skill') => {
    const token = config.token || '<TOKEN>';
    const text =
      kind === 'mcp'
        ? `node tools/markai-bridge.mjs --print-mcp-config --token ${token} --port ${config.port}`
        : kind === 'cli'
          ? `export MARKAI_TOKEN=${token}`
          : 'node tools/install-skill.mjs';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_600);
    } catch {
      pushToast('复制失败', { description: '浏览器拒绝了剪贴板访问，请手动选中复制。', variant: 'destructive' });
    }
  };

  const tokenReady = config.token.length >= MIN_TOKEN_LENGTH;
  const tools = toolManifest();

  return (
    <SettingsSection
      id="external"
      icon={Plug}
      title="对外接口"
      description="让外部 Agent（MCP / CLI / Skills）在授权后读取与整理书签。只监听本机回环，删除永远需要你确认。"
      keywords="MCP CLI 接口 外部 agent 集成 external api 桥 bridge token"
      badge={
        <span className={cn('text-2xs', config.enabled && tokenReady ? 'text-accent' : 'text-muted-foreground')}>
          {config.enabled && tokenReady ? '已启用' : '未启用'}
        </span>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-2xs text-muted-foreground">
            桥需要和扩展同时运行；token 只存在本机 storage 里，不会上传。
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            data-testid="external-refresh"
            aria-label="刷新对外接口状态"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      }
    >
      <ToggleRow
        label="启用对外接口"
        keywords="启用 开关 mcp cli"
        checked={config.enabled}
        disabled={!loaded}
        onCheckedChange={(v) => {
          // 没 token 就打开 = 一个谁都能调的本机端口；先生成再开
          if (v && !tokenReady) {
            void rotateToken().then(() => save({ enabled: true }));
            return;
          }
          void save({ enabled: v });
        }}
        hint={
          config.enabled
            ? '扩展会连接 127.0.0.1 上的本机桥，等待外部调用。'
            : '关闭时不建立任何连接，外部 Agent 无法读取书签。'
        }
      />

      <SettingRow
        label="本机端口"
        keywords="端口 port 8787"
        hint="桥监听的端口。改完要重启桥，并在启动命令里用同一个 --port。"
      >
        <Input
          type="number"
          min={1024}
          max={65535}
          value={config.port}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 1024 && n <= 65535) void save({ port: n });
          }}
          className="w-24 text-right tabular-nums"
          aria-label="本机端口"
          data-testid="external-port"
        />
      </SettingRow>

      <SettingRow
        label="访问 token"
        keywords="token 密钥 授权"
        wide
        hint={
          tokenReady
            ? '外部调用必须带 Authorization: Bearer <token>。轮换会让旧 token 立刻失效。'
            : '还没有 token。点「生成」后再启用接口。'
        }
      >
        <div className="flex w-full items-center gap-1.5">
          <code
            className="min-w-0 flex-1 truncate rounded-sm border border-border bg-muted/40 px-2 py-1.5 font-mono text-2xs text-muted-foreground"
            data-testid="external-token"
          >
            {tokenReady ? config.token : '—'}
          </code>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => void copy('token')}
            disabled={!tokenReady}
            aria-label="复制 token"
            data-testid="external-copy-token"
          >
            {copied === 'token' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void rotateToken()}
            aria-label="生成新 token"
            data-testid="external-rotate-token"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {tokenReady ? '轮换' : '生成'}
          </Button>
        </div>
      </SettingRow>

      <ToggleRow
        label="允许写操作"
        keywords="写 权限 create move rename"
        checked={config.allowWrites}
        onCheckedChange={(v) => void save({ allowWrites: v })}
        hint="新建/移动/重命名。删除不在其中：外部只能提交提议，仍由你在界面确认。"
        nested
      />

      <SettingRow
        label="启动桥"
        keywords="启动 命令 bridge node mcp 配置"
        wide
        hint="在项目目录运行。MCP 客户端用同一条命令即可（stdio）。"
      >
        <div className="w-full space-y-1.5">
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-sm border border-border bg-muted/40 px-2 py-1.5 font-mono text-2xs text-muted-foreground">
              node tools/markai-bridge.mjs --token {config.token ? '••••' : '<TOKEN>'} --port {config.port}
            </code>
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => void copy('config')}
              aria-label="复制启动命令"
              data-testid="external-copy-command"
            >
              {copied === 'config' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <div className="grid gap-1 sm:grid-cols-3">
            {(
              [
                ['mcp', 'MCP', 'node tools/markai-bridge.mjs --print-mcp-config'],
                ['cli', 'CLI', 'export MARKAI_TOKEN=…'],
                ['skill', 'Skills', 'node tools/install-skill.mjs'],
              ] as const
            ).map(([kind, label, preview]) => (
              <button
                key={kind}
                type="button"
                onClick={() => void copyCommand(kind)}
                aria-label={`复制 ${label} 接入命令`}
                data-testid={`external-copy-${kind}`}
                className="flex min-w-0 items-center gap-1.5 rounded-sm border border-border bg-muted/30 px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                <span className="shrink-0 text-2xs font-medium">{label}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">{preview}</code>
                {copied === kind ? (
                  <Check className="h-3 w-3 shrink-0 text-accent" />
                ) : (
                  <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))}
          </div>
          <p className="text-2xs leading-4 text-muted-foreground">
            Skill 安装后，外部 Agent 会通过 <code className="font-mono">tools/markai.mjs</code> 操作书签；删除仍需你确认。
          </p>
        </div>
      </SettingRow>

      <SettingRow
        label="可调用的工具"
        keywords="工具 tools 列表 只读"
        wide
        hint={`${tools.filter((t) => t.readOnly).length} 个只读，${tools.filter((t) => !t.readOnly).length} 个写操作。`}
      >
        <div className="flex w-full flex-wrap gap-1">
          {tools.map((t) => (
            <span
              key={t.name}
              className={cn(
                'rounded-sm border px-1.5 py-0.5 font-mono text-2xs',
                t.readOnly
                  ? 'border-border text-muted-foreground'
                  : 'border-accent/25 bg-accent-muted text-accent',
              )}
            >
              {t.name}
            </span>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label="审计日志"
        keywords="审计 日志 audit 记录"
        wide
        hint={audit.length > 0 ? `最近 ${audit.length} 条（新的在上）。` : '还没有外部调用。'}
      >
        <div className="w-full space-y-1">
          {audit.length === 0 ? (
            <div className="rounded-sm border border-dashed border-border px-2 py-3 text-center text-2xs text-muted-foreground">
              外部 Agent 的每次调用都会记在这里：时间、来源、工具、结果。
            </div>
          ) : (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto" data-testid="external-audit">
              {audit.slice(0, 40).map((entry, i) => (
                <li
                  key={`${entry.at}-${i}`}
                  className="flex items-baseline gap-2 rounded-sm px-1.5 py-1 text-2xs odd:bg-muted/30"
                >
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(entry.at)}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">{entry.client}</span>
                  <span className={cn('shrink-0 font-mono', entry.ok ? 'text-accent' : 'text-destructive')}>
                    {entry.tool}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground" title={entry.summary}>
                    {entry.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {audit.length > 0 && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void clearAudit().then(() => setAudit([]));
                }}
                aria-label="清空审计日志"
                data-testid="external-clear-audit"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空
              </Button>
            </div>
          )}
        </div>
      </SettingRow>

      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <p className="text-2xs leading-4 text-muted-foreground">
          接口只监听 <code className="font-mono">127.0.0.1</code>，局域网与公网都连不到。删除永远只生成待确认提议；
          关闭开关后扩展立刻断开，不需要重启浏览器。
        </p>
      </div>
    </SettingsSection>
  );
}

/**
 * 给 UI 侧一个"手动补一条审计"的入口（例如用户在设置页测试桥）。
 * 导出而不内联，是为了让测试能直接验证日志形状。
 */
export async function recordExternalTest(client: string): Promise<void> {
  await appendAudit({ at: Date.now(), client, tool: 'ping', ok: true, summary: '连通性测试' });
}
