/**
 * ── 单行「忙碌」守卫（防同一 tick 内重复提交） ──
 *
 * 背景（T10）：`removeOne` 原先读的是 `busyIds` 这个 useState 快照。
 * React 的状态更新要等下一次渲染才生效，所以同一 tick 里连点 5 次，
 * 5 次读到的都是**同一个旧 Set** → 守卫全部放行 → 5 次 `confirmDeletions`。
 * 当时靠 store 的 `items.length === 0` 兜住（第二次起会命中"没有可执行的删除项"），
 * 但那是下游补救：请求仍然发出去了，用户还会吃一条无意义的 toast。
 *
 * 这里改成**同步可变**的 Set：`begin()` 先占用再返回，天然原子，
 * 与 React 渲染时机无关。UI 需要的那份 Set 由 `snapshot()` 拷贝出去喂给 useState。
 */

export interface BusyGuard {
  /** 该行是否正在请求中 */
  has(id: string): boolean;
  /** 当前忙碌集合的拷贝（给 useState 用；外部改它不影响守卫） */
  snapshot(): Set<string>;
  /** 占用该行；已在忙则返回 false（同一个 tick 内第二次调用必然 false） */
  begin(id: string): boolean;
  /** 释放该行（失败路径也必须调用，避免按钮永久卡死） */
  end(id: string): void;
}

export function createBusyGuard(): BusyGuard {
  const busy = new Set<string>();
  return {
    has: (id) => busy.has(id),
    snapshot: () => new Set(busy),
    begin: (id) => {
      if (busy.has(id)) return false;
      busy.add(id);
      return true;
    },
    end: (id) => {
      busy.delete(id);
    },
  };
}

/**
 * 执行一次「同一行只允许一个在飞请求」的动作。
 *
 * @returns 是否真正开始了这次动作（false = 该行已在处理中，调用方应直接 return）
 *
 * 失败不会抛出：调用方（卡片按钮）只关心按钮能解锁，错误提示由 store 统一 toast。
 * 这条对**两种**失败都成立 —— 异步 reject，以及 task 在返回 promise 之前就同步 throw
 * （后者若不管，`begin()` 已占用而 `.finally` 从未挂上，该行会永久卡死）。
 * `onChange` 在开始时、以及 settle 后各回调一次，用来同步 UI 的 busy 集合。
 */
export function runExclusive(
  guard: BusyGuard,
  id: string,
  task: () => Promise<unknown>,
  onChange?: (busy: Set<string>) => void,
): boolean {
  if (!guard.begin(id)) return false;
  onChange?.(guard.snapshot());
  let pending: Promise<unknown>;
  try {
    pending = task();
  } catch {
    // task 在生成 promise 之前就抛了（同步 throw）：此时 .finally 根本没机会挂上，
    // 必须在这里释放，否则该行永久卡死。与异步失败一致，不向调用方抛出。
    guard.end(id);
    onChange?.(guard.snapshot());
    return true;
  }
  void pending
    .catch(() => {})
    .finally(() => {
      guard.end(id);
      onChange?.(guard.snapshot());
    });
  return true;
}
