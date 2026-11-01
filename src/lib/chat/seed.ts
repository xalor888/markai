/**
 * ── 右键菜单「种子指令」的消费端 ──
 *
 * background 把右键菜单产生的指令写进 `chrome.storage.local['markai.seed']`，
 * 再广播一条 `markai:seed` 让已打开的界面来取。消费方有两个（侧边栏、完整页），
 * 这段逻辑曾经在两个入口文件里**逐字重复约 60 行**——改一处忘一处就会变成
 * 「主入口修好了、另一个入口还在丢指令」，而这类不一致在 code review 里很难看出来。
 *
 * 两件事被刻意保留在这里（而不是放回入口）：
 * 1. **流式中到达的指令必须排队**：种子在后台已被移除，直接丢掉等于用户点了右键什么都没发生；
 * 2. **排队只订阅一次**：`useAIStore.subscribe` 是全局的，重复订阅会重复发送同一条指令。
 */
import { useAIStore } from '@/stores/aiStore';
import { pushToast } from '@/lib/toast';

/** 流式中到达的待发指令（先进先出） */
let seedQueue: { text: string; folderId?: string }[] = [];
/** store 订阅（惰性建立，只建一次） */
let seedListener: (() => void) | null = null;

/**
 * 消费一条种子指令并交给 Agent。
 *
 * 后台不可达（如 SW 刚启动/已回收）时**静默失败**：种子仍在 storage 里，
 * 下次挂载会再消费一次。这里不 toast，避免"扩展刚开就报错"的噪音。
 */
export async function consumeSeed(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'seed:consume' })) as
      | { type: string; text?: string; folderId?: string; notice?: string }
      | undefined;
    if (res?.type !== 'seed:value') return;
    if (res.text) {
      // 流式中消费（Agent 正忙）：入队等流式结束串行发送，避免静默丢失
      if (useAIStore.getState().streaming) queueSeed(res.text, res.folderId);
      else await useAIStore.getState().send(res.text, res.folderId ? { folderId: res.folderId } : undefined);
    }
    if (res.notice) pushToast(res.notice);
  } catch {
    // 后台暂不可达：种子仍在 storage 中，下次挂载会再消费
  }
}

/**
 * 排队一条指令，等当前流式结束再发。
 *
 * 订阅只在第一次排队时建立：`useAIStore.subscribe` 没有去重，重复订阅会让
 * 同一条队首指令被发送多次。
 */
export function queueSeed(text: string, folderId?: string): void {
  seedQueue.push({ text, folderId });
  if (seedListener) return;
  seedListener = useAIStore.subscribe((s) => {
    if (!s.streaming && seedQueue.length > 0) {
      const next = seedQueue.shift()!;
      void useAIStore.getState().send(next.text, next.folderId ? { folderId: next.folderId } : undefined);
    }
  });
}

/** 队列长度（测试与诊断用） */
export function seedQueueLength(): number {
  return seedQueue.length;
}

/** 仅测试用：清空队列与订阅 */
export function resetSeedForTest(): void {
  seedQueue = [];
  if (seedListener) {
    seedListener();
    seedListener = null;
  }
}
