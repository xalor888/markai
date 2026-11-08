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
  /** 累积到的完整正文（不是增量） */
  text: string;
  /**
   * 累积到的思考内容。
   *
   * 与正文分开存的理由同 ChatBlock：思考不是回复。
   * 旧草稿没有这个字段（= 没有思考），读的时候按空串处理，不做版本迁移。
   */
  reasoning?: string;
  /** 最后一次写入的时间 */
  at: number;
}

/** 节流窗口：够短，SW 猝死时丢的字有限；够长，不至于把 storage 写爆 */
const FLUSH_MS = 300;

let buffer: StreamDraft | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 正在进行的那次写入（用来串行化，避免并发写互相覆盖） */
let inflight: Promise<void> | null = null;

/**
 * 把内存里的草稿写下去。
 *
 * 早先遇到"正在写"就直接 return（latest-wins）。看起来省事，实际有洞：
 * 那次被放弃的写入**不会再排期**，要等下一个增量才补上；
 * 而收尾时 `finalizeDraft` 是**从 storage 读**的，
 * 于是最后不到 300ms 的字会永远留在内存里，跟着 clearDraft 一起蒸发。
 * 现在改成"等上一次写完再写"，保证调用返回时 storage 一定是最新的。
 */
async function writeNow(): Promise<void> {
  if (!buffer) return;
  if (inflight) {
    await inflight.catch(() => {});
    if (!buffer) return;
  }
  const snapshot: StreamDraft = { ...buffer };
  const run = chrome.storage.local
    .set({ [STREAM_DRAFT_KEY]: snapshot })
    .then(
      () => undefined,
      // 写不进去（配额/权限）时不阻塞生成：草稿只是兜底，不是主路径
      () => undefined,
    );
  inflight = run;
  try {
    await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

/**
 * 收尾前强制把内存内容写下去（不经节流）。
 * `finalizeDraft` 必须先调它，否则读到的是旧值。
 */
export async function flushDraftNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await writeNow();
}

/**
 * 收到一段增量：累积并节流落盘。
 *
 * `kind` 决定落到哪个字段——思考与正文分开累积，因为恢复时要按块重建
 * `[reasoning][text]`，混在一起就再也拆不开了。
 */
export function appendDraft(messageId: string, text: string, kind: 'text' | 'reasoning' = 'text'): void {
  if (!buffer || buffer.messageId !== messageId) {
    buffer = kind === 'reasoning'
      ? { messageId, text: '', reasoning: text, at: Date.now() }
      : { messageId, text, at: Date.now() };
  } else {
    if (kind === 'reasoning') buffer.reasoning = (buffer.reasoning ?? '') + text;
    else buffer.text += text;
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
    return {
      messageId: raw.messageId,
      text: raw.text,
      ...(typeof raw.reasoning === 'string' ? { reasoning: raw.reasoning } : {}),
      at: typeof raw.at === 'number' ? raw.at : 0,
    };
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
 * 合并思考内容，规则与 mergeDraft 同一条：**只往更完整的方向合**。
 * 草稿里的思考更短就原样返回已有内容，绝不让用户眼前的思考变少。
 */
export function mergeDraftReasoning(existing: string, draft: StreamDraft | null, messageId: string): string {
  const next = draft?.messageId === messageId ? (draft.reasoning ?? '') : '';
  if (next.length <= existing.length) return existing;
  return next;
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
  // 先把内存里还没落盘的那一段写下去，再从 storage 读——
  // 否则最后不到 300ms 的文本会丢（它只在 buffer 里，没进 storage）
  await flushDraftNow();
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
        // 只处理「纯文本 + 纯思考」的回复：含工具卡片的消息结构复杂，不在这里重排。
        // （思考块也必须是可处理类型，否则带思考的回复会被整条跳过——那正是"切标签页丢内容"的复现条件）
        const onlyChat = msg.blocks.every((b) => b?.kind === 'text' || b?.kind === 'reasoning');
        if (!onlyChat) return m;
        const existingText = msg.blocks.filter((b) => b?.kind === 'text').map((b) => b.text ?? '').join('');
        const existingReasoning = msg.blocks.filter((b) => b?.kind === 'reasoning').map((b) => b.text ?? '').join('');
        const nextText = draft.text.length > existingText.length ? draft.text : existingText;
        const nextReasoning = mergeDraftReasoning(existingReasoning, draft, msg.id ?? '');
        const changed = nextText !== existingText || nextReasoning !== existingReasoning;
        touched = true;
        if (!changed) return { ...msg, streaming: false };
        const blocks: { kind: string; text: string }[] = [];
        if (nextReasoning) blocks.push({ kind: 'reasoning', text: nextReasoning });
        if (nextText) blocks.push({ kind: 'text', text: nextText });
        return { ...msg, streaming: false, blocks };
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
