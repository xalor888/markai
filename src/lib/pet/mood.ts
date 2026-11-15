/**
 * ── 宠物的状态机与表情表 ──
 *
 * 两个问题分开解：
 *  1. **现在是什么心情**（本文件 `PetDirector`）——只看真实信号（流式阶段、待确认删除、
 *     出错、聚焦、成功/失败事件、闲置时长），不看"随机心情"。宠物可以假装好奇，
 *     但不能假装你刚整理完。
 *  2. **这个心情长什么样**（`EXPRESSIONS`）——纯数据表。新增一种心情 = 加一行，
 *     不动渲染代码；反过来渲染代码里也不许出现任何 `if (state === ...)` 的表情分支。
 *
 * 表情表的每个字段都是**有物理含义的连续量**（眼皮开合、身体缩放、倾斜角……），
 * 这样状态切换时弹簧才能"从当前姿态接着走"，而不是先归位再出新表情。
 */

/** 心情 */
export type PetState =
  | 'sleeping'
  | 'idle'
  | 'curious'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'talking'
  | 'happy'
  | 'proud'
  | 'worried'
  | 'error';

/** 嘴形：渲染侧只按 id 取对应 path，不做插值 */
export type MouthShape = 'smile' | 'grin' | 'flat' | 'oh' | 'wavy' | 'frown' | 'cat' | 'sleep';

/** 头顶/四周的小特效 */
export type PetFx = 'none' | 'sparkle' | 'sweat' | 'zzz' | 'question' | 'ring' | 'bang' | 'dots';

/** 呼吸节奏（交给 CSS，不占 JS 帧） */
export type Breath = 'calm' | 'fast' | 'slow' | 'still';

export interface PetExpression {
  /** 读屏/悬停用的一句心情说明 */
  aria: string;
  /** 眼皮开合：0 = 完全合上，1 = 全开（超过 1 表示撑大一点） */
  lidOpen: number;
  /** 眼睛横向张度：>1 瞪大，<1 眯起 */
  eyeWidth: number;
  /** 瞳孔缩放（0.75 惊讶/专注，1 正常） */
  pupil: number;
  /** 基准视线偏移（瞳孔在眼睛里挪动，viewBox 单位；负值 = 看左/看上） */
  gazeX: number;
  gazeY: number;
  /**
   * 眉毛倾角（度）。
   * **正值 = 眉头下压**（生气/不耐烦/专注），**负值 = 眉头抬起**（担心/好奇/开心）。
   */
  browTilt: number;
  /** 眉毛整体升降（viewBox 单位，正值向上） */
  browRaise: number;
  /** 眉毛不透明度：平时几乎看不见，情绪需要时才显形 */
  browAlpha: number;
  mouth: MouthShape;
  /** 腮红强度 0..1 */
  blush: number;
  /** 身体竖向缩放（<1 被压扁、>1 被拉长） */
  squash: number;
  /** 身体横向缩放（与 squash 互补，保持体积感） */
  stretch: number;
  /** 整体倾斜（度，正值向右倒） */
  tilt: number;
  fx: PetFx;
  breath: Breath;
  /** 该心情下是否眨眼（睡觉/冥思不眨） */
  blink: boolean;
  /** 眨眼周期的 CSS 值（`--pet-blink`）：紧张时眨得勤，开心时眨得像在偷笑 */
  blinkPeriod: string;
}

/**
 * 十一种心情的完整姿态。
 *
 * 排版约定：`squash`/`stretch` 永远是 1 附近的小偏移（±0.06），因为角色的可信度来自
 * **体积守恒**——压扁时同时变宽，否则看起来像被整体缩放了。
 */
export const EXPRESSIONS: Record<PetState, PetExpression> = {
  sleeping: {
    aria: '睡着了，轻轻打着呼',
    lidOpen: 0,
    eyeWidth: 1,
    pupil: 0.7,
    gazeX: 0,
    gazeY: 1.2,
    browTilt: 0,
    browRaise: -1,
    browAlpha: 0.25,
    mouth: 'sleep',
    blush: 0.1,
    squash: 1.02,
    stretch: 0.99,
    tilt: -5,
    fx: 'zzz',
    breath: 'slow',
    blink: false,
    blinkPeriod: '7s',
  },
  idle: {
    aria: '闲着呢，等你把书签丢过来',
    lidOpen: 0.96,
    eyeWidth: 1,
    pupil: 1,
    gazeX: 0,
    gazeY: 0,
    browTilt: 0,
    browRaise: 0,
    browAlpha: 0.12,
    mouth: 'smile',
    blush: 0,
    squash: 1,
    stretch: 1,
    tilt: 0,
    fx: 'none',
    breath: 'calm',
    blink: true,
    blinkPeriod: '5.6s',
  },
  curious: {
    aria: '有点好奇，歪着头看你',
    lidOpen: 1.05,
    eyeWidth: 1.05,
    pupil: 1.05,
    gazeX: 1.6,
    gazeY: -0.4,
    browTilt: -8,
    browRaise: 1.5,
    browAlpha: 0.55,
    mouth: 'oh',
    blush: 0.15,
    squash: 1.03,
    stretch: 0.98,
    tilt: 7,
    fx: 'question',
    breath: 'calm',
    blink: true,
    blinkPeriod: '6.4s',
  },
  listening: {
    aria: '在听你说话',
    lidOpen: 1,
    eyeWidth: 1.08,
    pupil: 0.92,
    gazeX: 0,
    gazeY: 0,
    browTilt: -4,
    browRaise: 0.8,
    browAlpha: 0.35,
    mouth: 'flat',
    blush: 0.2,
    squash: 1,
    stretch: 1,
    tilt: -2,
    fx: 'none',
    breath: 'calm',
    blink: true,
    blinkPeriod: '5.2s',
  },
  thinking: {
    aria: '正在想',
    lidOpen: 0.62,
    eyeWidth: 1,
    pupil: 0.85,
    gazeX: 0,
    gazeY: -1.8,
    browTilt: 6,
    browRaise: 1,
    browAlpha: 0.5,
    mouth: 'wavy',
    blush: 0,
    squash: 0.99,
    stretch: 1.01,
    tilt: 3,
    fx: 'dots',
    breath: 'fast',
    blink: true,
    blinkPeriod: '4.4s',
  },
  working: {
    aria: '正在动手整理',
    lidOpen: 0.82,
    eyeWidth: 0.95,
    pupil: 0.9,
    gazeX: 0,
    gazeY: 1.6,
    browTilt: 5,
    browRaise: -0.5,
    browAlpha: 0.45,
    mouth: 'flat',
    blush: 0,
    squash: 1,
    stretch: 1,
    tilt: 1,
    fx: 'ring',
    breath: 'fast',
    blink: true,
    blinkPeriod: '3s',
  },
  talking: {
    aria: '在跟你说话',
    lidOpen: 0.92,
    eyeWidth: 1,
    pupil: 1,
    gazeX: 0,
    gazeY: 0,
    browTilt: -2,
    browRaise: 1,
    browAlpha: 0.3,
    mouth: 'grin',
    blush: 0.1,
    squash: 1.01,
    stretch: 1,
    tilt: 0,
    fx: 'none',
    breath: 'fast',
    blink: true,
    blinkPeriod: '4.8s',
  },
  happy: {
    aria: '开心得眯起眼睛',
    lidOpen: 0.42,
    eyeWidth: 1.02,
    pupil: 1,
    gazeX: 0,
    gazeY: 0,
    browTilt: -12,
    browRaise: 3,
    browAlpha: 0.7,
    mouth: 'grin',
    blush: 0.9,
    squash: 0.93,
    stretch: 1.06,
    tilt: 0,
    fx: 'sparkle',
    breath: 'fast',
    blink: true,
    blinkPeriod: '1.8s',
  },
  proud: {
    aria: '很得意，下巴抬起来了',
    lidOpen: 0.3,
    eyeWidth: 1,
    pupil: 0.95,
    gazeX: 0,
    gazeY: -0.8,
    browTilt: -6,
    browRaise: 2.5,
    browAlpha: 0.7,
    mouth: 'cat',
    blush: 0.6,
    squash: 1.04,
    stretch: 0.98,
    tilt: -7,
    fx: 'sparkle',
    breath: 'calm',
    blink: false,
    blinkPeriod: '9s',
  },
  worried: {
    aria: '有点担心，等你确认删哪些',
    lidOpen: 1,
    eyeWidth: 1.06,
    pupil: 0.85,
    gazeX: 0,
    gazeY: 0.6,
    browTilt: -14,
    browRaise: 2,
    browAlpha: 0.9,
    mouth: 'wavy',
    blush: 0,
    squash: 0.99,
    stretch: 1.01,
    tilt: -4,
    fx: 'sweat',
    breath: 'calm',
    blink: true,
    blinkPeriod: '3.4s',
  },
  error: {
    aria: '摔了一跤，出错了',
    lidOpen: 0.7,
    eyeWidth: 1,
    pupil: 0.78,
    gazeX: 0,
    gazeY: 0.8,
    browTilt: 12,
    browRaise: -1,
    browAlpha: 0.95,
    mouth: 'frown',
    blush: 0,
    squash: 0.95,
    stretch: 1.04,
    tilt: -6,
    fx: 'bang',
    breath: 'still',
    blink: false,
    blinkPeriod: '6s',
  },
};

/** 一次成功/失败的高亮持续多久（太短看不见，太长会赖着不走） */
export const SUCCESS_LATCH_MS = 2_600;
export const FAILURE_LATCH_MS = 1_500;
/** 被撸得意：比"成功"更长的驻留，因为它是对用户直接动作的回应 */
export const PROUD_LATCH_MS = 2_200;
/** 闲置多久开始歪头好奇（"你是不是走了"） */
export const CURIOUS_AFTER_MS = 45_000;
/** 闲置多久打盹 */
export const SLEEP_AFTER_MS = 8 * 60_000;

/** 组织一次决策需要的全部输入（全部来自真实 store，不含随机数） */
export interface PetSignals {
  /** 流式阶段：connecting / thinking / streaming / tool / retrying（无活动为 null） */
  phase: 'connecting' | 'thinking' | 'streaming' | 'tool' | 'retrying' | null;
  /** 是否有待用户确认的删除提议 */
  pendingDeletions: number;
  /** 正在等用户拍板（确认框 / 待删面板开着） */
  awaitingUser: boolean;
  /** 书签树加载失败 */
  loadError: boolean;
  /** 最近一条回复带错误块 */
  chatError: boolean;
  /** 输入框有焦点（或用户正在打字） */
  focused: boolean;
  /** 最近一次成功事件的时间戳（0 = 没有） */
  lastSuccessAt: number;
  /** 最近一次失败事件的时间戳（0 = 没有） */
  lastFailureAt: number;
  /** 最近一次被撸（双击）的时间戳（0 = 没有） */
  lastPrideAt?: number;
  /** 最近一次与宠物/页面互动的时间戳（用于闲置判定） */
  lastActiveAt: number;
}

/**
 * 心情裁决器（可复用、可单测的纯状态机）。
 *
 * 为什么要有"闸门"而不是每次 `update` 直接算出终态：
 *  - **转场锁定**：happy/proud 这类奖励性表情必须有最短驻留时间，否则被下一个
 *    信号瞬间覆盖，用户永远看不到"它为你高兴"。
 *  - **同类不重排**：thinking → working → thinking 在工具链里一秒能来回三次，
 *    每次切换都会重启呆毛与呼吸；锁定窗口让它在同一族内保持稳定姿态。
 */
export class PetDirector {
  private current: PetState = 'idle';
  private changedAt = 0;
  private holdUntil = 0;

  /** 当前心情 */
  get state(): PetState {
    return this.current;
  }

  /** 进入当前心情的时刻（渲染层用它算"这个表情已经摆了多久"） */
  get since(): number {
    return this.changedAt;
  }

  /**
   * 推进一帧决策。
   *
   * @param now 真实时间戳（注入以便测试；不要用 Date.now() 内部取，否则测试要 sleep）
   */
  update(signals: PetSignals, now: number): PetState {
    const desired = resolvePetState(signals, now);
    const holding = now < this.holdUntil;
    const reward = desired === 'happy' || desired === 'proud' || desired === 'error';
    const busyDesired = desired === 'thinking' || desired === 'working' || desired === 'talking';
    const latched = this.current === 'happy' || this.current === 'proud' || this.current === 'error';

    // 奖励/负反馈：命中即锁定（error 锁定更长 —— 出错的余韵比开心更久）
    if (reward && desired !== this.current) {
      const hold = desired === 'error' ? FAILURE_LATCH_MS : SUCCESS_LATCH_MS;
      this.holdUntil = now + hold;
      return this.commit(desired, now, this.holdUntil);
    }

    // 锁定期间：只有"新任务"能打断庆祝/摔跤；其它（闲置、好奇、担心）一律不抢
    if (latched && holding && !busyDesired) return this.current;

    if (desired === this.current) return this.current;

    // 新任务打断庆祝：用户已经发了下一句，宠物还在为上一轮欢呼就是错位
    if (latched && busyDesired) return this.commit(desired, now);

    /*
     * 同一族（想 / 干活 / 说话）内部切换：**允许，但不延长驻留**。
     *
     * 这两件事必须分开：驻留防的是"非承诺性信号把表情吹得乱抖"，
     * 而工具链里 thinking→tool→streaming 是**真实推进**，拦下来等于表情跟不上进度。
     * 所以族内切换立即生效，但 holdUntil 保持原值——既不抖，也不会因为切得勤而永远锁死。
     */
    if (this.isVolatileFamily(desired, this.current)) {
      this.current = desired;
      this.changedAt = now;
      return desired;
    }

    // 非奖励类的最小驻留：防止 worried/listening/idle 之间一秒来回
    if (holding && !reward) return this.current;

    return this.commit(desired, now);
  }

  /** 同一"族"的状态：thinking/working/talking 都属于"在忙"，互相切换不重启驻留 */
  private isVolatileFamily(a: PetState, b: PetState): boolean {
    const busy = new Set<PetState>(['thinking', 'working', 'talking']);
    return busy.has(a) && busy.has(b);
  }

  private commit(next: PetState, now: number, holdUntil?: number): PetState {
    this.current = next;
    this.changedAt = now;
    // 非奖励类给 400ms 的稳定窗：足够滤掉一次相位抖动，又不至于让表情迟滞
    this.holdUntil = holdUntil ?? now + 400;
    return next;
  }
}

/** 纯函数：输入信号 → 此刻应有的心情（不含驻留逻辑，便于测试优先级） */
export function resolvePetState(signals: PetSignals, now: number): PetState {
  // 1) 负反馈最高：出错是"必须先说的事"，任何别的信号都不该盖住它
  if (signals.lastFailureAt > 0 && now - signals.lastFailureAt < FAILURE_LATCH_MS) return 'error';
  if (signals.chatError || signals.loadError) return 'error';
  if (signals.lastPrideAt && now - signals.lastPrideAt < PROUD_LATCH_MS) return 'proud';

  /*
   * 2) 正在发生的事排在"刚刚成功"之前。
   *
   * 反过来的顺序看着更自然（"完成 → 开心 2.6 秒"），但会造出一个明显的错位：
   * 用户整理完立刻发下一句，宠物还在庆祝上一轮，而屏幕上的 Agent 已经在跑工具了。
   * 正在发生的事永远比刚结束的事更该被表达，所以 phase 优先，success 只在
   * 空闲时才表现得出来。
   */
  switch (signals.phase) {
    case 'tool':
      return 'working';
    case 'thinking':
    case 'connecting':
    case 'retrying':
      return 'thinking';
    case 'streaming':
      return 'talking';
    default:
      break;
  }

  // 3) 刚成功 / 刚被撸：空闲时的奖励表情
  if (signals.lastSuccessAt > 0 && now - signals.lastSuccessAt < SUCCESS_LATCH_MS) return 'happy';

  // 4) 等用户拍板：不安（有待删清单）或专注（确认框开着）
  if (signals.pendingDeletions > 0) return 'worried';
  if (signals.awaitingUser) return 'listening';

  // 5) 用户在场：输入框有焦点就是"在听"
  if (signals.focused) return 'listening';

  // 6) 闲置：先好奇，再打盹
  const idleFor = signals.lastActiveAt > 0 ? now - signals.lastActiveAt : 0;
  if (idleFor >= SLEEP_AFTER_MS) return 'sleeping';
  if (idleFor >= CURIOUS_AFTER_MS) return 'curious';

  return 'idle';
}

/** 便捷：取表情（未知状态回落到 idle，渲染侧永不因缺项而崩） */
export function expressionOf(state: PetState): PetExpression {
  return EXPRESSIONS[state] ?? EXPRESSIONS.idle;
}
