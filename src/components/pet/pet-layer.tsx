/**
 * ── 宠物层：把「真实发生了什么」翻译成「它现在什么心情」 ──
 *
 * 这一层只做三件事，不含任何造型逻辑：
 *  1. **取信号**：流式阶段 / 待确认删除 / 出错 / 聚焦 / 成功失败 / 闲置时长；
 *  2. **裁决**：交给 `PetDirector`（带驻留锁定，见 mood.ts）；
 *  3. **挂载**：`PetAvatar` 只接收 `state + size + follow`，每帧姿态由它自己写 DOM。
 *
 * 三个刻意的取舍（都属于"优化到极致"的一部分）：
 *  · **订阅合并**：流式时 aiStore 每个 token 都变化，逐次重算会让宠物跟着 token 抖动。
 *    这里把所有 store 的 notify 合并到一次微任务里，最多每帧决策一次。
 *  · **零帧空闲**：心情没变就不重渲染；`PetAvatar` 的 rAF 判稳自停；呼吸/眨眼在 CSS 层。
 *  · **说话有闸门**：正在流式、弹着对话框、页面不可见时一律闭嘴——宠物可以活泼，
 *    但不能在用户读正文的时候插话。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { useToastStore } from '@/lib/toast';
import { usePetStore } from '@/stores/petStore';
import { PetAvatar } from '@/components/pet/pet-avatar';
import { PetDirector, expressionOf, type PetState, type PetSignals } from '@/lib/pet/mood';
import { DEFAULT_CHATTER_CONFIG, pickChatter } from '@/lib/pet/chatter';
import { flattenForFacts, petFacts } from '@/lib/pet/facts';
import { pickPokeLine } from '@/lib/pet/lines';
import { cn } from '@/lib/utils';

/** 气泡停留时长：短于 4s 读不完一句话，长于 7s 会挡视线 */
const BUBBLE_TTL_MS = 6_200;
/** 碎碎念的心跳：20s 一次足够，真正的频率闸门在 pickChatter（90s 最小间隔） */
const CHATTER_TICK_MS = 20_000;
/** 挂载后多久尝试第一次开口（别一打开就说话，那是弹窗不是宠物） */
const FIRST_SPEAK_DELAY_MS = 6_000;
/** 心情决策的心跳：闲置状态（好奇/打盹）没有 store 变化，必须靠定时器推进 */
const DIRECTOR_TICK_MS = 4_000;
/** 用户活动节流：每 5s 记一次就足够判定闲置，不必吃掉每个 pointermove */
const ACTIVITY_THROTTLE_MS = 5_000;

/** 焦点是否在一个输入控件里（搜索框 / 聊天输入框都算"在听它说话"） */
function inputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

export interface PetLayerProps {
  className?: string;
}

export function PetLayer({ className }: PetLayerProps) {
  const enabled = usePetStore((s) => s.enabled);
  const size = usePetStore((s) => s.size);
  const follow = usePetStore((s) => s.follow);
  const chatterEnabled = usePetStore((s) => s.chatter);
  const design = usePetStore((s) => s.design);

  const [state, setState] = useState<PetState>('idle');
  const [bubble, setBubble] = useState<{ key: string; text: string } | null>(null);

  const director = useRef<PetDirector | null>(null);
  const hideTimer = useRef<number | null>(null);
  const clickTimer = useRef<number | null>(null);
  const pokeSeed = useRef(0);

  if (director.current === null) director.current = new PetDirector();

  // ── 设置：从 storage 读一次（多窗口下另一窗口改了也会同步过来） ──
  useEffect(() => {
    void usePetStore.getState().load();
  }, []);

  const showBubble = useCallback((text: string) => {
    setBubble({ key: `${Date.now()}`, text });
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setBubble(null);
    }, BUBBLE_TTL_MS);
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    },
    [],
  );

  // ── 心情裁决：合并订阅 + 定时心跳（闲置推进靠它） ──
  useEffect(() => {
    let queued = false;
    const decide = () => {
      const now = Date.now();
      const ai = useAIStore.getState();
      const bookmarks = useBookmarkStore.getState();
      const ui = useUIStore.getState();
      const pet = usePetStore.getState();
      const lastAssistant = [...ai.messages].reverse().find((m) => m.role === 'assistant');
      const signals: PetSignals = {
        phase: ai.activity?.phase ?? null,
        pendingDeletions: ai.pendingDeletions.filter((p) => p.status === 'pending').length,
        awaitingUser:
          Boolean(ui.confirmRequest) ||
          ui.dialog?.kind === 'delete' ||
          ui.dialog?.kind === 'delete-many',
        loadError: Boolean(bookmarks.loadError),
        // failed 是显式字段（不是从文案里猜）；流式中的"上一次失败"不算数
        chatError: Boolean(lastAssistant?.failed) && !ai.streaming,
        focused: inputFocused(),
        lastSuccessAt: pet.lastSuccessAt,
        lastFailureAt: pet.lastFailureAt,
        lastPrideAt: pet.lastPrideAt,
        lastActiveAt: pet.lastActiveAt || now,
      };
      const next = director.current!.update(signals, now);
      setState((prev) => (prev === next ? prev : next));
    };
    // 一帧最多决策一次：streaming 时 aiStore 每个 token 都 notify
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        decide();
      });
    };

    decide();
    const unsubs = [
      useAIStore.subscribe(schedule),
      useBookmarkStore.subscribe(schedule),
      useUIStore.subscribe(schedule),
      usePetStore.subscribe(schedule),
    ];
    const heartbeat = window.setInterval(schedule, DIRECTOR_TICK_MS);
    return () => {
      for (const unsub of unsubs) unsub();
      window.clearInterval(heartbeat);
    };
  }, []);

  // ── 用户活动：节流写时间戳（闲置 → 好奇 → 打盹 全靠它） ──
  useEffect(() => {
    let lastWrite = 0;
    const note = () => {
      const now = Date.now();
      if (now - lastWrite < ACTIVITY_THROTTLE_MS) return;
      lastWrite = now;
      usePetStore.getState().touch(now);
    };
    window.addEventListener('pointermove', note, { passive: true });
    window.addEventListener('keydown', note, { passive: true });
    note();
    return () => {
      window.removeEventListener('pointermove', note);
      window.removeEventListener('keydown', note);
    };
  }, []);

  // ── Toast 即情绪：成功让它开心，报错让它摔一下（这是"真实发生的事"最直接的来源） ──
  useEffect(() => {
    let seen: string | undefined;
    const unsub = useToastStore.subscribe((s) => {
      const top = s.toasts[s.toasts.length - 1];
      if (!top || top.id === seen) return;
      seen = top.id;
      if (top.variant === 'success') usePetStore.getState().markSuccess();
      else if (top.variant === 'destructive') usePetStore.getState().markFailure();
    });
    return unsub;
  }, []);

  // ── 碎碎念：有事实才说，冷却由 pickChatter 保证 ──
  useEffect(() => {
    if (!enabled || !chatterEnabled) return;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const now = Date.now();
      if (document.visibilityState !== 'visible') return;
      const ai = useAIStore.getState();
      const ui = useUIStore.getState();
      const pet = usePetStore.getState();
      // 用户正在读回复 / 正在拍板时闭嘴
      if (ai.streaming || ui.confirmRequest || ui.dialog) return;
      if (now < pet.chatterState.mutedUntil) return;
      const roots = useBookmarkStore.getState().roots;
      if (!roots.length) return;
      const facts = petFacts(flattenForFacts(roots));
      const picked = pickChatter(facts, pet.chatterState, now, DEFAULT_CHATTER_CONFIG);
      if (!picked) return;
      pet.spoken(picked.id, now);
      showBubble(picked.text);
    };
    const timer = window.setInterval(tick, CHATTER_TICK_MS);
    const first = window.setTimeout(tick, FIRST_SPEAK_DELAY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [enabled, chatterEnabled, showBubble]);

  // ── 被戳：单击回应当前心情，双击撸一把（得意） ──
  const onPress = useCallback(
    (kind: 'click' | 'double') => {
      const pet = usePetStore.getState();
      pet.touch();
      if (kind === 'double') {
        pet.markPride();
        // 用户写了自己的口头禅：双击就是"说那句话"的入口，比内置台词更有归属感
        showBubble(pet.design.catchphrase || pickPokeLine('proud', pokeSeed.current++));
        return;
      }
      showBubble(pickPokeLine(state, pokeSeed.current++));
    },
    [state, showBubble],
  );

  /**
   * 单击 vs 双击。
   *
   * 不用原生 `onDoubleClick`：浏览器在 dblclick 之前**必然**先派发两次 click，
   * 那一版会先冒一句"单击"的台词再切到"得意"，看起来像自言自语了两句。
   * 待决定时器把第一下压住 240ms，第二下到来就升级成双击。
   * 键盘（Enter/Space）只会派发 click，于是 240ms 后照常得到单击回应。
   */
  const handleClick = useCallback(() => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
      onPress('double');
      return;
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      onPress('click');
    }, 240);
  }, [onPress]);

  if (!enabled) return null;

  const expr = expressionOf(state);

  return (
    <div className={cn('pet-shell pointer-events-none absolute z-10 select-none', className)} data-testid="pet">
      {/* 气泡：在位宠物的上方展开；aria-live 让读屏用户也能听到它说话 */}
      {bubble && (
        <div
          key={bubble.key}
          className="pet-bubble markai-glass markai-glass-liquid pointer-events-none absolute bottom-full left-0 mb-2 w-max max-w-[190px] rounded-lg px-2.5 py-1.5 text-2xs leading-4 text-foreground shadow-lg"
          role="status"
          aria-live="polite"
          data-testid="pet-bubble"
        >
          {/* 小尖角：把气泡指回宠物，否则它像块飘着的标签 */}
          <span className="pet-bubble-caret" aria-hidden="true" />
          {bubble.text}
        </div>
      )}
      <button
        type="button"
        onClick={handleClick}
        className="pointer-events-auto block cursor-pointer rounded-full p-0 transition-transform duration-150 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        aria-label={`${design.name}：${expr.aria}（点一下听它说话）`}
        title={`${design.name}：${expr.aria}`}
        data-pet-state={state}
      >
        <PetAvatar state={state} size={size} follow={follow} decorative design={design} />
      </button>
    </div>
  );
}
