import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * 渲染错误边界。
 *
 * 为什么需要：React 19 里任何组件抛错都会让整棵树卸载——用户看到的是**纯白窗口**，
 * 没有报错、没有退出路径，只能关掉侧边栏重开（而且不知道为什么会这样）。
 * 书签树、列表、Agent 面板都依赖 chrome API 的返回形状；一次意外的丢字段就足够触发。
 *
 * 这里做三件事：
 *  1. 捕获子树异常，显示一句人话 + 具体错误；
 *  2. 提供「重试」——重置错误状态重新挂载，多数瞬时问题（比如 storage 抖动）能自愈；
 *  3. 把错误留在控制台（附组件栈），方便事后定位；不静默吞掉。
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    /** 出错区域的名称，用于文案（如「书签面板」） */
    area?: string;
    /**
     * 错误态容器类名（可选）。
     * **正常渲染时不产生任何盒子**（用 `display: contents`）——错误边界绝不能改变原有布局：
     * 加一层 flex 容器会破坏子元素的高度约束，实测让时间线在 1200 条时直接卡死。
     */
    className?: string;
  },
  { error: Error | null; info: string }
> {
  override state: { error: Error | null; info: string } = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台保留完整上下文：用户报告「白屏」时，这里才有可查的东西
    console.error('[MarkAI] 界面渲染失败', error, info.componentStack);
    this.setState({ info: info.componentStack ?? '' });
  }

  private retry = (): void => {
    this.setState({ error: null, info: '' });
  };

  override render(): ReactNode {
    const { error, info } = this.state;
    const wrap = this.props.className;
    // 零布局影响：contents 让 wrapper 不生成盒子，子元素直接参与父级布局
    if (!error) {
      return (
        <div className="contents" data-error-boundary={this.props.area ?? 'unknown'}>
          {this.props.children}
        </div>
      );
    }
    const area = this.props.area ? `「${this.props.area}」` : '';
    return (
      // role="alert"：渲染崩溃属于需要立刻告知的状态，不能让屏幕阅读器等用户自己发现
      <div
        role="alert"
        className={wrap ? `${wrap} overflow-auto` : 'flex h-full min-h-0 w-full flex-col overflow-auto'}
      >
        <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2.5 px-5 py-6 text-center">
        <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
        <p className="text-xs font-medium text-foreground">{area}出了点问题</p>
        <p className="max-w-[320px] text-2xs leading-4 text-muted-foreground">
          界面没能渲染出来。可以先点下面的「重试」；如果反复出现，请把下面这行错误信息反馈出来。
        </p>
        <code className="max-h-16 max-w-[320px] overflow-auto rounded-sm border border-border bg-muted px-2 py-1 text-left text-2xs text-muted-foreground">
          {error.message || String(error)}
        </code>
        <button
          type="button"
          onClick={this.retry}
          className="mt-1 flex items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 py-1.5 text-2xs text-foreground transition-colors hover:bg-muted"
        >
          <RotateCcw className="h-3 w-3" />
          重试
        </button>
        {info && (
          <details className="max-w-[320px] text-left">
            <summary className="cursor-pointer text-2xs text-muted-foreground/70">查看组件栈</summary>
            <pre className="mt-1 max-h-24 overflow-auto text-2xs whitespace-pre-wrap text-muted-foreground/70">{info}</pre>
          </details>
        )}
        </div>
      </div>
    );
  }
}
