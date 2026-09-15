/**
 * 计划确认登记表：把"发计划 → 等用户决定"这段往返抽成可单测的纯登记逻辑。
 *
 * 为什么不直接写在 background 里：background 只注册监听器，几乎无法单测；而这段逻辑有
 * 两条必须钉死的安全语义：
 * 1. **决定必须匹配 messageId**——迟到的/伪造的决定绝不能批准另一个轮次的计划；
 * 2. **端口断开必须把未决请求按"未批准"结算**——绝不能挂死一轮（用户关了面板，那一轮
 *    应当以"未执行"结束，而不是永远等待）。
 */

export interface PlanApprovalStep {
  name: string;
  label: string;
  count: number;
  summary: string;
  preview: boolean;
}

export interface PlanApprovalRegistry {
  /** 发出 chat:plan 并挂起，直到 resolve 或 cancelAll */
  request(
    messageId: string,
    steps: PlanApprovalStep[],
    post: (msg: { type: 'chat:plan'; messageId: string; steps: PlanApprovalStep[] }) => void,
  ): Promise<boolean>;
  /** 结算某个 messageId 的决定；命中返回 true，未知 messageId 返回 false（无副作用） */
  resolve(messageId: string, approved: boolean): boolean;
  /** 把所有未决请求按"未批准"结算（端口断开/轮次结束时调用） */
  cancelAll(): void;
  /** 当前未决请求数（诊断用） */
  pendingCount(): number;
}

export function createPlanApprovalRegistry(): PlanApprovalRegistry {
  const pending = new Map<string, (approved: boolean) => void>();

  return {
    request(messageId, steps, post) {
      // 同一个 messageId 重复请求时，先按"未批准"结算旧的，避免泄漏一个永不结算的 promise
      const stale = pending.get(messageId);
      if (stale) {
        pending.delete(messageId);
        stale(false);
      }
      return new Promise<boolean>((resolve) => {
        pending.set(messageId, resolve);
        try {
          post({ type: 'chat:plan', messageId, steps });
        } catch {
          // 端口已死：没有人能回答，按"未批准"结算（绝不挂死）
          pending.delete(messageId);
          resolve(false);
        }
      });
    },

    resolve(messageId, approved) {
      const settle = pending.get(messageId);
      if (!settle) return false;
      pending.delete(messageId);
      settle(approved);
      return true;
    },

    cancelAll() {
      const all = [...pending.values()];
      pending.clear();
      for (const settle of all) settle(false);
    },

    pendingCount() {
      return pending.size;
    },
  };
}
