/**
 * ── 流式草稿（后台侧落盘） ──
 *
 * 为什么必须在 background 落盘，而不是 UI：
 *
 * 用户实测：**只是把标签页放到后台**，回复就没了。
 * 链路是这样的——切到后台后页面的定时器被 Chrome 节流到约 1 次/分钟，
 * 而保活心跳是 20s 一次，于是 Service Worker 在 30s 空闲后被回收、port 断开；
 * UI 的 `onDisconnect` 把 `streaming` 置为 false 并落了一次盘（此时可能还没收到多少字），
 * 用户切回来时 `visibilitychange` 触发 `load()`，`if (streaming) return` 的守卫已经失效，
 * **storage 里的旧内容就把内存里更完整的回复覆盖掉了**。
 *
 * 只要 UI 的定时器还负责落盘，这个洞就堵不住——因为坏掉的正是"UI 还活着"这个前提。
 *
 * 所以改由 background 在收到每个增量时就累积并节流写入一个草稿槽位
 * （`markai.ai.draft`）。SW 被回收前它至少已经落过若干次；UI 恢复时先读草稿、再合并，
 * 只会在内容更完整时覆盖，绝不会把长的换成短的。
 */

export const STREAM_DRAFT_KEY = 'markai.ai.draft';

export interface StreamDraft {
  messageId: string;
  /** 累积到的完整文本（不是增量） */
  text: string;
  /** 最后一次写入的时间 */
  at: number;
}

/** 节流窗口：够短，SW 猝死时丢的字有限；够长，不至于把 storage 写爆 */
const FLUSH_MS = 300;

let buffer: StreamDraft | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let writing = false;

async function writeNow(): Promise<void> {
  if (!buffer) return;
  if (writing) return; // 上一次还没写完：latest-wins，直接放弃这次（下次会带全量）
  writing = true;
  const snapshot: StreamDraft = { ...buffer };
  try {
    await chrome.storage.local.set({ [STREAM_DRAFT_KEY]: snapshot });
  } catch {
    // 写不进去（配额/权限）时不阻塞生成：草稿只是兜底，不是主路径
  } finally {
    writing = false;
  }
}

/** 收到一段增量：累积并节流落盘 */
export function appendDraft(messageId: string, text: string): void {
  if (!buffer || buffer.messageId !== messageId) {
    buffer = { messageId, text, at: Date.now() };
  } else {
    buffer.text += text;
    buffer.at = Date.now();
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void writeNow();
  }, FLUSH_MS);
}

/** 一轮结束（成功/失败/取消）：清掉草稿，避免下次误合并 */
export async function clearDraft(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  buffer = null;
  try {
    await chrome.storage.local.remove(STREAM_DRAFT_KEY);
  } catch {
    /* 清不掉也不影响：读的时候会按 messageId 校验 */
  }
}

/** 读当前草稿（UI 恢复时用） */
export async function readDraft(): Promise<StreamDraft | null> {
  try {
    const data = await chrome.storage.local.get(STREAM_DRAFT_KEY);
    const raw = data[STREAM_DRAFT_KEY] as Partial<StreamDraft> | undefined;
    if (!raw || typeof raw.messageId !== 'string' || typeof raw.text !== 'string') return null;
    return { messageId: raw.messageId, text: raw.text, at: typeof raw.at === 'number' ? raw.at : 0 };
  } catch {
    return null;
  }
}

/** 仅供测试：丢弃内存态，避免用例之间互相污染 */
export function resetDraftForTest(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  buffer = null;
  writing = false;
}

/**
 * 合并草稿与已有消息文本。
 *
 * 规则只有一条：**只往更完整的方向合**。
 * 草稿更短就原样返回已有内容——绝不能因为一次晚到的读把用户眼前的字变少。
 */
export function mergeDraft(existing: string, draft: StreamDraft | null, messageId: string): string {
  if (!draft || draft.messageId !== messageId) return existing;
  if (draft.text.length <= existing.length) return existing;
  // 已有内容是新草稿的前缀 → 直接用草稿（正常情况）
  if (draft.text.startsWith(existing)) return draft.text;
  // 不是前缀（重试导致分叉）：保留更长的那个，别拼出两段怪回复
  return draft.text;
}


/**
 * 把草稿的最终内容写回会话消息，然后清掉草稿。
 *
 * 为什么必须做这一步：port 断开后 UI 可能一直没回来，草稿是唯一还在长的副本。
 * 如果只是「结束就删草稿」，那段内容就真的没了——用户切回来只会看到半截。
 * 所以收尾时必须落到**会话消息**里（那是 UI 下次 load 真正读的地方）。
 *
 * @param aiStorageKey 会话存储的 key（由调用方传入，避免这里反向依赖 store）
 */
export async function finalizeDraft(aiStorageKey: string): Promise<boolean> {
  const draft = await readDraft();
  if (!draft) return false;

  try {
    const data = await chrome.storage.local.get(aiStorageKey);
    const payload = data[aiStorageKey] as { conversations?: unknown[] } | undefined;
    const conversations = Array.isArray(payload?.conversations) ? payload!.conversations : null;
    if (!conversations) {
      await clearDraft();
      return false;
    }

    let touched = false;
    const next = conversations.map((c) => {
      const conv = c as { messages?: unknown[] };
      if (!Array.isArray(conv.messages)) return c;
      const messages = conv.messages.map((m) => {
        const msg = m as { id?: string; role?: string; blocks?: { kind?: string; text?: string }[]; streaming?: boolean };
        if (msg.id !== draft.messageId || !Array.isArray(msg.blocks)) return m;
        const onlyText = msg.blocks.every((b) => b?.kind === 'text');
        if (!onlyText) return m;
        const existing = msg.blocks.map((b) => b.text ?? '').join('');
        if (draft.text.length <= existing.length) {
          // 内容已经足够完整：只把 streaming 收尾，不动文本
          touched = true;
          return { ...msg, streaming: false };
        }
        touched = true;
        return { ...msg, streaming: false, blocks: [{ kind: 'text', text: draft.text }] };
      });
      return touched ? { ...conv, messages } : c;
    });

    if (touched) await chrome.storage.local.set({ [aiStorageKey]: { ...payload, conversations: next } });
    await clearDraft();
    return touched;
  } catch {
    // 写不进去时保留草稿（下次 load 还能补），不删
    return false;
  }
}
