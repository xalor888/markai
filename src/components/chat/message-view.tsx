import { openUrl } from '@/lib/open-url';
import {
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  BookmarkPlus,
  Brain,
  CheckCircle2,
  ChevronRight,
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
  CircleStop,
  type LucideIcon,
} from 'lucide-react';
import { memo, useCallback, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatRelativeTime, safeJsonParse, truncate } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { TOOL_META } from '@/lib/ai/tools';
import { useBookmarkStore, findNode, resolveTitlePath } from '@/stores/bookmarkStore';
import type { ChatMessage, ToolCallRecord } from '@/lib/ai/types';
import { mutatedEmptyReplyNote, retrySafety } from '@/lib/chat/retry-safety';
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
/**
 * 思考区（可折叠）。
 *
 * 用原生 <details> 而不是自管 state：
 *  - 键盘、读屏、展开/收起语义都是浏览器自带的，不用再写一遍 ARIA；
 *  - 流式时自动展开（用户能看见模型正在想什么），结束后自动收起成一行摘要；
 *  - 思考很长时不会把答案挤到屏幕外——这正是「显示思考」最容易做坏的地方。
 */
function ReasoningBlock({
  text,
  streaming,
  defaultOpen = false,
}: {
  text: string;
  streaming: boolean;
  /** 最新一条回复默认展开：思考过程不该藏在一次点击后面（历史消息仍折叠，避免刷屏） */
  defaultOpen?: boolean;
}) {
  const chars = text.length;
  const [expanded, setExpanded] = useState(defaultOpen || streaming);
  /*
   * 流式期间强制展开：用户能看见模型正在想什么；此时点 summary 不生效，
   * 免得「刚收起又被下一段增量顶开」的拉扯感。流结束后的开合由用户自己决定。
   */
  const open = streaming || expanded;
  return (
    <details
      open={open}
      onToggle={(e) => {
        if (!streaming) setExpanded(e.currentTarget.open);
      }}
      data-testid="reasoning-block"
      data-open={open ? 'true' : 'false'}
      className="group/reason select-text rounded-md border border-border bg-background px-3 py-2.5 text-xs text-muted-foreground"
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-2"
        onClick={(e) => {
          if (streaming) e.preventDefault();
        }}
      >
        <span className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground">
          <Brain className="h-3 w-3 shrink-0" />
          <span>{streaming ? '正在思考…' : `思考过程 · ${chars} 字`}</span>
          {!streaming && (
            <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open/reason:rotate-90" />
          )}
        </span>
        {!streaming && (
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{open ? '收起' : '展开'}</span>
        )}
      </summary>
      <div className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap leading-[1.7] text-muted-foreground/90">{text}</div>
    </details>
  );
}

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
  const [expanded, setExpanded] = useState(record.status === 'error'); // canceled 不自动展开
  const Icon = TOOL_ICONS[record.name] ?? Wrench;
  const meta = TOOL_META[record.name];

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted"
      >
        {record.status === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : record.status === 'done' ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : record.status === 'canceled' ? (
          <CircleStop className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-foreground">{meta?.label ?? record.name}</span>
        {record.status === 'running' && record.result && (
          // 长任务（check_urls_bulk / auto_categorize）实时进度
          <span className="min-w-0 truncate text-2xs text-muted-foreground">{record.result}</span>
        )}
        {record.status === 'done' && record.result && (
          <span className="min-w-0 truncate text-2xs text-muted-foreground">{summarize(record)}</span>
        )}
        {record.status === 'error' && (
          <span className="min-w-0 truncate text-2xs text-destructive">{record.error}</span>
        )}
        {record.status === 'canceled' && (
          <span className="min-w-0 truncate text-2xs text-muted-foreground">已停止</span>
        )}
      </button>
      {expanded && (record.result || record.error) && (
        <div className="border-t border-border bg-muted/30">
          <div className="flex items-center justify-end px-2 pt-1.5">
            <button
              type="button"
              onClick={() => void copyText(record.result ?? record.error ?? (record.status === 'canceled' ? '已停止生成' : ''), '工具结果已复制')}
              className="flex items-center gap-1 rounded-md p-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="复制结果"
              aria-label="复制结果"
            >
              <Copy className="h-3 w-3" />
              复制
            </button>
          </div>
          <pre className="max-h-40 overflow-auto px-2.5 pt-0.5 pb-2 text-2xs leading-4 whitespace-pre-wrap text-muted-foreground">
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
  /**
   * 上下文文件夹路径：**只订阅这一条消息自己那条路径的字符串**，不订阅整棵树。
   *
   * 原先订阅的是 `s.roots` 整个数组：每次 `loadTree()` 都是新引用，于是任何一次书签刷新
   * 都会让**全部历史消息**重渲染——组件上的 `memo` 直接白付（它比的是 props，不是 store）。
   * 改成 selector 返回字符串后，路径没变的消息拿到同一个值，memo 才真正生效。
   */
  const contextPath = useBookmarkStore(
    useCallback(
      (s) => {
        const id = message.contextFolderId;
        if (!id) return '';
        return findNode(s.roots, id) ? resolveTitlePath(s.roots, id) : '';
      },
      [message.contextFolderId],
    ),
  );

  if (message.role === 'user') {
    const text = message.blocks
      .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
      .map((b) => b.text)
      .join('');
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          {contextPath && (
            <button
              type="button"
              onClick={() => useBookmarkStore.getState().revealInTree(message.contextFolderId!)}
              className="mb-1 ml-auto flex max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-accent"
              title={`上下文：${contextPath}（点击在树中定位）`}
            >
              <Folder className="h-3 w-3 shrink-0" />
              <span className="truncate">{contextPath}</span>
            </button>
          )}
          <div className="select-text rounded-lg rounded-br-sm border border-accent/25 bg-accent-muted px-3 py-2 text-md whitespace-pre-wrap text-foreground">
            {text}
          </div>
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

  /*
   * 这一轮有没有成功执行过**写类**操作。
   * 有的话，"重新生成"（= 删掉回复并重发同一句指令）会让工具**再跑一遍**，
   * 移动类幂等看不出来，但 create/copy 会造出重复书签，所以必须拦掉。
   */
  const safety = retrySafety(message.blocks);
  /*
   * 有"实质文字"才算模型回复过。空白块（例如只有换行）不算。
   * 工具记录单独算一类：它证明"执行过东西"，但用户没读到任何说明。
   */
  const hasText = message.blocks.some((b) => b.kind === 'text' && b.text.trim().length > 0);
  const hasToolBlocks = message.blocks.some((b) => b.kind === 'tool');
  /*
   * 这一轮**失败了**（请求报错 / 被打断 / 模型什么都没返回）。
   *
   * 这种情况下"重新生成"是用户唯一能做的事，而操作条平时是 hover 才出现的
   * （`opacity-0 group-hover:opacity-100`）——键盘用户没有 hover，触屏也没有，
   * 于是失败时那条重试按钮**看不见也点不到**，用户只看到一条 toast 说"请求失败"。
   * 所以：失败时把操作条设为常亮。
   */
  const isFailure = isLast && !streaming && safety.safeToRegenerate && !!message.failed;

  return (
    <div
      className="group"
      data-testid="assistant-message"
      data-failed={message.failed ? '1' : '0'}
      title={formatRelativeTime(message.createdAt)}
    >
      <div className="space-y-1.5">
        {/*
         * 三种"没有内容"必须分开说，它们的含义完全不同：
         *  - 生成中被强制打断（关侧边栏 / 进程被回收）：不是模型的错，重试即可，已收到的部分也保留着；
         *  - 真正的空回复：模型确实什么都没说，重试有意义；
         *  - 其它（已被过滤/被清空）：不吓唬用户。
         * 早先一律写成"Agent 未返回内容"，把第一种伪装成第二种，
         * 于是用户会以为"一退出就废了"——虽然内容确实丢了，但说法也是错的。
         */}
        {/*
         * 判据是「有没有**文字**」，不是「有没有块」。
         *
         * 早先写的是 `blocks.length === 0`：只要 Agent 调过工具，blocks 里就有 tool 记录、
         * 长度不为 0，于是这段话**永远不会显示**。用户看到几个工具卡片之后就没有下文了，
         * 既不知道发生了什么，也（因为 0.2.48 的安全拦截）没有重新生成按钮可点。
         * e2e 在真实浏览器里跑这条路径时才暴露出来。
         */}
        {!hasText && !streaming && (
          <p className={hasToolBlocks ? 'text-2xs text-muted-foreground/80' : 'text-md text-muted-foreground'}>
            {message.interrupted
              ? '（生成被打断了，还没收到内容。可点击 ↻ 重新生成）'
              : safety.safeToRegenerate
                ? '（Agent 未返回内容，可点击 ↻ 重新生成）'
                : mutatedEmptyReplyNote(safety.mutations)}
          </p>
        )}
        {message.interrupted && message.blocks.length > 0 && (
          <p className="text-2xs text-muted-foreground/80">
            （生成被打断，以上是已收到的部分；可点击 ↻ 重新生成完整回复）
          </p>
        )}
        {message.blocks.map((block, i) => {
          const isLastBlock = i === message.blocks.length - 1;
          return block.kind === 'text' ? (
            <div
              key={i}
              className={cn(
                // 助手气泡要与面板底色（bg-card）区分开：用 muted 底色而不是 card 半透明，
                // 后者在 card 上几乎看不出差别，等于「有背景但没效果」
                'select-text rounded-md rounded-tl-xs border border-border bg-card px-3 py-2.5 text-foreground',
                !streaming && 'hover:border-border',
              )}
            >
              <MarkdownText text={block.text} />
              {streaming && isLastBlock && block.text && <span className="stream-cursor ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-accent" />}
            </div>
          ) : block.kind === 'reasoning' ? (
            <ReasoningBlock
              key={`reasoning-${i}`}
              text={block.text}
              streaming={streaming && isLastBlock}
              defaultOpen={isLast}
            />
          ) : block.record.deletions && block.record.deletions.length > 0 ? (
            <DeletionCard key={block.record.id} proposals={block.record.deletions} />
          ) : (
            <ToolChip key={block.record.id} record={block.record} />
          );
        })}
        {/* 底部操作条（hover 显示）：复制整条回复（纯文本 / Markdown）/ 重试（仅最后一条） */}
        <div
          data-testid="message-actions"
          className={cn(
            '-ml-1 flex items-center gap-1 transition-opacity',
            isFailure ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
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
          {isLast && onRetry && !streaming && safety.safeToRegenerate && (
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
        if (href) void openUrl(href);
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
