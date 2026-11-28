/**
 * 设置页「搜索」分区。
 *
 * 显示的是**真实**索引状态：条数、占用、最后更新时间、降级条数。
 * 这些数字来自装配层的 manifest，不是估算——用户需要知道"语义搜索到底有没有生效"，
 * 而不是只在搜索框里猜。
 */
import { useEffect, useState } from 'react';
import { Database, RefreshCw, Search, X } from 'lucide-react';
import {
  cancelSemanticBuild,
  getSemanticStatus,
  rebuildSemanticIndex,
  subscribeSemanticStatus,
  type SemanticStatus,
} from '@/lib/search/semantic/register';
import {
  readSemanticSettings,
  writeSemanticSettings,
  SEMANTIC_SETTINGS_KEY,
} from '@/lib/search/semantic/settings';
import { SettingRow, SettingsSection, ToggleRow } from '@/components/options/setting-primitives';
import { Button } from '@/components/ui/button';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KiB';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

function formatTime(ms: number): string {
  if (!ms) return '尚未建立';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '未知';
  }
}

function modelLabel(model: string): string {
  if (model.startsWith('remote:')) return `远端 · ${model.slice('remote:'.length)}`;
  return `本地 · ${model}`;
}

export function SearchSettingsSection() {
  const [status, setStatus] = useState<SemanticStatus>(() => getSemanticStatus());
  const [remoteEmbed, setRemoteEmbed] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => subscribeSemanticStatus(setStatus), []);

  useEffect(() => {
    void readSemanticSettings().then((settings) => {
      setRemoteEmbed(settings.remoteEmbed);
      setSettingsLoaded(true);
    });
  }, []);

  // 远端 401/403 会由装配层把开关写回 false；设置页要跟着变，不能停在"已开启"的假象
  useEffect(() => {
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'local') return;
      const change = changes[SEMANTIC_SETTINGS_KEY];
      if (!change) return;
      const next = change.newValue as { remoteEmbed?: boolean } | undefined;
      setRemoteEmbed(next?.remoteEmbed === true);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const progressPercent = Math.round(Math.max(0, Math.min(1, status.progress)) * 100);

  return (
    <SettingsSection
      id="search"
      icon={Search}
      title="搜索"
      description="本地向量索引让「搜意思」也能找到书签；默认完全离线，只有显式开启时才使用远端向量。"
      keywords="搜索 search 语义 向量 索引 embedding 混合检索 远端"
    >
      <SettingRow
        label="索引状态"
        keywords="索引 状态 条数 占用 更新 重建 rebuild"
        wide
        hint={
          status.building
            ? `正在建立索引：${progressPercent}%`
            : status.ready
              ? `覆盖 ${status.count} 条书签 · ${formatBytes(status.bytes)} · 更新于 ${formatTime(status.updatedAt)}`
              : status.note ?? '索引尚未建立，搜索仍可用（关键词兜底）。'
        }
        action={
          <div className="flex items-center gap-1.5">
            {status.building && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => cancelSemanticBuild()}
                aria-label="取消建立索引"
                data-testid="search-cancel-build"
              >
                <X className="h-3 w-3" />
                取消
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={status.building}
              onClick={() => void rebuildSemanticIndex()}
              aria-label="重建搜索索引"
              data-testid="search-rebuild"
            >
              <RefreshCw className="h-3 w-3" />
              重建索引
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          {status.building && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="索引建立进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
              data-testid="search-progress"
            >
              <div className="h-full bg-accent transition-[width]" style={{ width: `${progressPercent}%` }} />
            </div>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-muted-foreground sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground/70">书签条数</dt>
              <dd className="tabular-nums text-foreground" data-testid="search-index-count">
                {status.count}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground/70">占用</dt>
              <dd className="tabular-nums text-foreground">{formatBytes(status.bytes)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground/70">最后更新</dt>
              <dd className="text-foreground">{formatTime(status.updatedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground/70">向量实现</dt>
              <dd className="truncate text-foreground" title={status.model}>
                {modelLabel(status.model)}
              </dd>
            </div>
          </dl>
          {status.note && !status.building && (
            <p className="text-2xs text-muted-foreground" data-testid="search-index-note">
              {status.note}
            </p>
          )}
        </div>
      </SettingRow>

      {status.degradedCount > 0 && (
        <SettingRow
          label="容量降级"
          keywords="降级 容量 预算 配额 degraded"
          wide
          hint="语义索引有 8 MiB 预算；超出时按「最近使用 → 最近收藏」保留向量，其余仍可被关键词搜到。"
        >
          <p className="flex items-start gap-2 text-2xs text-muted-foreground" data-testid="search-degraded">
            <Database className="mt-0.5 h-3 w-3 shrink-0" />
            {status.degradedCount} 条已降级为「仅关键词」——它们不会因语义检索而丢失，
            只是不再参与向量排序。
          </p>
        </SettingRow>
      )}

      <ToggleRow
        label="允许远端向量"
        keywords="远端 向量 embedding OpenAI API 隐私"
        checked={remoteEmbed}
        disabled={!settingsLoaded}
        testId="search-remote-toggle"
        onCheckedChange={(checked) => {
          setRemoteEmbed(checked);
          void writeSemanticSettings({ remoteEmbed: checked })
            .then((next) => setRemoteEmbed(next.remoteEmbed))
            .catch(() => setRemoteEmbed(!checked));
        }}
        hint={
          remoteEmbed
            ? '书签标题、路径与 URL 会发往你在「AI 服务」里配置的 OpenAI 兼容 /embeddings 端点；切换实现会整库重建。'
            : '关闭（默认）：索引与查询完全在本机完成，不发送任何书签内容。'
        }
      />
    </SettingsSection>
  );
}
