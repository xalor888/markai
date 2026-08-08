import {
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  BookmarkPlus,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitMerge,
  Link2,
  ListTree,
  Loader2,
  Pencil,
  Route,
  RotateCcw,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  Upload,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatRelativeTime, safeJsonParse, truncate } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { TOOL_META } from '@/lib/ai/tools';
import { useBookmarkStore, findNode, resolveTitlePath } from '@/stores/bookmarkStore';
import type { ChatMessage, ToolCallRecord } from '@/lib/ai/types';
import { cn } from '@/lib/utils';
import { DeletionCard } from './deletion-card';

/** 工具名 → 图标映射 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  list_bookmarks: ListTree,
  search_bookmarks: Search,
  get_recent_bookmarks: Clock,
  get_folder_path: Route,
  list_all_folders: Folder,
  list_empty_folders: FolderOpen,
  get_folder_content: FolderOpen,
  export_bookmarks: Upload,
  merge_folders: GitMerge,
  create_folder: FolderPlus,
  create_bookmark: BookmarkPlus,
  create_bookmarks: BookmarkPlus,
  move_bookmark: FolderInput,
  move_bookmarks: FolderInput,
  copy_bookmark: Copy,
  open_bookmark: ExternalLink,
  open_bookmarks: ExternalLink,
  rename_bookmark: Pencil,
  update_bookmark_url: Link2,
  check_urls: ShieldCheck,
  classify_urls: Tag,
  stats: BarChart3,
  find_duplicates: Copy,
  sort_folder: ArrowUpDown,
  propose_deletions: Trash2,
  delete_all_bookmarks: Trash2,
};

/** 从工具结果 JSON 提取一行摘要 */
function summarize(record: ToolCallRecord): string {
  const j = safeJsonParse<Record<string, unknown>>(record.result ?? '');
  if (j) {
    if (record.name === 'move_bookmark') return `已移至 ${String(j.toPath ?? '')}`;
    if (record.name === 'check_urls' && Array.isArray(j)) {
      const list = j as { status?: string }[];
      const ok = list.filter((x) => x.status === 'ok').length;
      const dead = list.filter((x) => x.status === 'dead').length;
      return dead > 0 ? `存活 ${ok} · 死链 ${dead}` : `全部存活（${ok}）`;
    }
    if (record.name === 'check_urls_bulk') {
      return `检测 ${String(j.total ?? 0)} 条：存活 ${String(j.ok ?? 0)} · 不可访问 ${String(j.dead ?? 0)}`;
    }
    if (record.name === 'auto_categorize') {
      return `已创建 ${String(j.created ?? 0)} 个分类，移动 ${String(j.moved ?? 0)} 条`;
    }
    if (record.name === 'propose_deletions') return `已提交 ${String(j.submitted ?? 0)} 项删除提议`;
    if (typeof j.title === 'string' && record.name !== 'create_folder') return j.title;
  }
  return truncate(record.result ?? '', 60);
}

/** 工具调用 chip：状态 + 摘要，点击展开详情（memo 化避免流式重渲染） */
const ToolChip = memo(function ToolChip({ record }: { record: ToolCallRecord }) {
  // 错误时自动展开详情，问题立即可见
  const [expanded, setExpanded] = useState(record.status === 'error');
  const Icon = TOOL_ICONS[record.name] ?? Wrench;
  const meta = TOOL_META[record.name];

  return (
    <div className="mt-1 overflow-hidden rounded-sm border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        {record.status === 'running' ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : record.status === 'done' ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
        ) : (
          <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
        )}
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs text-foreground">{meta?.label ?? record.name}</span>
        {record.status === 'running' && record.result && (
          // 长任务（check_urls_bulk / auto_categorize）实时进度
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{record.result}</span>
        )}
        {record.status === 'done' && record.result && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{summarize(record)}</span>
        )}
        {record.status === 'error' && (
          <span className="min-w-0 truncate text-[11px] text-destructive">{record.error}</span>
        )}
      </button>
      {expanded && (record.result || record.error) && (
        <div className="border-t border-border">
          <div className="flex items-center justify-end px-1.5 pt-1">
            <button
              type="button"
              onClick={() => void copyText(record.result ?? record.error ?? '', '工具结果已复制')}
              className="flex items-center gap-1 rounded-sm p-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="复制结果"
              aria-label="复制结果"
            >
              <Copy className="h-3 w-3" />
              复制
            </button>
          </div>
          <pre className="max-h-40 overflow-auto px-2 pb-1.5 text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
            {record.result ?? record.error}
          </pre>
        </div>
      )}
    </div>
  );
});

/** 单条聊天消息（memo 化：流式 delta 只更新最后一条，其余消息跳过重渲染） */
export const MessageView = memo(function MessageView({
  message,
  streaming = false,
  isLast = false,
  onRetry,
}: {
  message: ChatMessage;
  streaming?: boolean;
  /** 是否为最后一条消息（决定是否显示重试按钮） */
  isLast?: boolean;
  onRetry?: () => void;
}) {
  // 超长消息折叠（hooks 必须在提前 return 之前声明）
  const [longExpanded, setLongExpanded] = useState(false);
  const LONG_LIMIT = 800;
  // 订阅书签树：文件夹重命名/移动后，历史消息的上下文路径实时更新（不能读 getState 一次性快照）
  const roots = useBookmarkStore((s) => s.roots);

  if (message.role === 'user') {
    const text = message.blocks
      .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
      .map((b) => b.text)
      .join('');
    // 上下文文件夹（发送时附带）：展示 Agent 视野，可点击在树中定位；文件夹已删则不显示
    const contextPath = message.contextFolderId
      ? findNode(roots, message.contextFolderId)
        ? resolveTitlePath(roots, message.contextFolderId)
        : ''
      : '';
    const showText =
      text.length > LONG_LIMIT && !longExpanded
        ? Array.from(text).slice(0, LONG_LIMIT).join('') + '…'
        : text;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          {contextPath && (
            <button
              type="button"
              onClick={() => useBookmarkStore.getState().revealInTree(message.contextFolderId!)}
              className="mb-1 ml-auto flex max-w-full items-center gap-1 rounded-sm px-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-accent"
              title={`上下文：${contextPath}（点击在树中定位）`}
            >
              <Folder className="h-3 w-3 shrink-0" />
              <span className="truncate">{contextPath}</span>
            </button>
          )}
          <div className="select-text rounded-lg rounded-br-sm bg-accent px-3 py-2 text-[13px] leading-5 whitespace-pre-wrap text-white">
            {showText}
          </div>
          {text.length > LONG_LIMIT && (
            <button
              type="button"
              onClick={() => setLongExpanded((v) => !v)}
              className="mt-0.5 ml-auto block text-[11px] text-accent transition-colors hover:underline"
            >
              {longExpanded ? '收起' : '展开全文'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // 整条消息全文（复制用，清理 Markdown 标记）
  const fullText = message.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('');
  const cleanCopy = fullText
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-•]\s+/gm, '')
    .replace(/^\d+[.、]\s+/gm, '')
    .trim();

  return (
    <div className="group" title={formatRelativeTime(message.createdAt)}>
      <div className="space-y-1.5">
        {message.blocks.length === 0 && !streaming && (
          <p className="text-[13px] leading-5 text-muted-foreground">（Agent 未返回内容，可点击 ↻ 重新生成）</p>
        )}
        {fullText.length > LONG_LIMIT && !longExpanded ? (
          // 超长回复折叠：先显示截断文本，展开后渲染完整富文本；工具块始终可见（删除卡片需可交互）
          <>
            <div className="select-text text-[13px] leading-5 text-foreground">
              <MarkdownText text={Array.from(fullText).slice(0, LONG_LIMIT).join('') + '…'} />
              {streaming && <span className="stream-cursor ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-accent" />}
            </div>
            <button
              type="button"
              onClick={() => setLongExpanded(true)}
              className="text-[11px] text-accent transition-colors hover:underline"
            >
              展开全文
            </button>
            {message.blocks
              .filter((b): b is { kind: 'tool'; record: ToolCallRecord } => b.kind === 'tool')
              .map((b) =>
                b.record.deletions && b.record.deletions.length > 0 ? (
                  <DeletionCard key={b.record.id} proposals={b.record.deletions} />
                ) : (
                  <ToolChip key={b.record.id} record={b.record} />
                ),
              )}
          </>
        ) : (
          <>
            {message.blocks.map((block, i) => {
              const isLast = i === message.blocks.length - 1;
              return block.kind === 'text' ? (
                <div
                  key={i}
                  className={cn(
                    'select-text rounded-md border border-border/60 bg-card/60 px-2.5 py-2 text-foreground',
                    !streaming && 'hover:border-border',
                  )}
                >
                  <MarkdownText text={block.text} />
                  {streaming && isLast && block.text && <span className="stream-cursor ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-accent" />}
                </div>
              ) : block.record.deletions && block.record.deletions.length > 0 ? (
                <DeletionCard key={block.record.id} proposals={block.record.deletions} />
              ) : (
                <ToolChip key={block.record.id} record={block.record} />
              );
            })}
            {fullText.length > LONG_LIMIT && (
              <button
                type="button"
                onClick={() => setLongExpanded(false)}
                className="text-[11px] text-accent transition-colors hover:underline"
              >
                收起
              </button>
            )}
          </>
        )}
        {/* 底部操作条（hover 显示）：复制整条回复（纯文本 / Markdown）/ 重试（仅最后一条） */}
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {cleanCopy && (
            <button
              type="button"
              onClick={() => void copyText(cleanCopy, '回复已复制')}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="复制回复（纯文本）"
              aria-label="复制回复"
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
          {fullText && (
            <button
              type="button"
              onClick={() => void copyText(fullText, 'Markdown 已复制')}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="复制为 Markdown（保留格式）"
              aria-label="复制为 Markdown"
            >
              <FileText className="h-3 w-3" />
            </button>
          )}
          {isLast && onRetry && !streaming && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="重新生成回复"
              aria-label="重新生成回复"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

/** 提取 React 节点中的纯文本（代码块复制用） */
function codeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(codeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return codeText((node as { props: { children?: ReactNode } }).props.children ?? '');
  }
  return '';
}

/** Markdown 渲染组件：GFM 全语法（表格/任务列表/删除线/代码块），样式见 main.css .markdown */
function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 自定义组件：链接新标签页打开（扩展内不导航）+ 代码块复制按钮 */
const mdComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href ?? '#'}
      onClick={(e) => {
        e.preventDefault();
        if (href) void chrome.tabs.create({ url: href }).catch(() => {});
      }}
      className="break-all text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => {
    const text = codeText(children);
    return (
      <div className="group/code relative">
        <pre>{children}</pre>
        {text && (
          <button
            type="button"
            onClick={() => void copyText(text, '代码已复制')}
            className="absolute top-1.5 right-1.5 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-card hover:text-foreground"
            title="复制代码"
            aria-label="复制代码"
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  },
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  del: ({ children }) => <del className="text-muted-foreground/70">{children}</del>,
};
