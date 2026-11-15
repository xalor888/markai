/**
 * ── 弹簧（spring）运动内核 ──
 *
 * 为什么不用 CSS 过渡：过渡的时长与曲线是写死的，中途改目标会「跳一下」或从当前值
 * 重新计时；角色动效里最常见的两个动作——**指针跟随**和**状态切换打断上一次未完成的动作**——
 * 恰恰都需要「以当前速度接着走」。弹簧天然满足：改 target 只改平衡点，速度是连续的。
 *
 * 三个设计约束（都是为了「优化到极致」而不是「能跑就行」）：
 *  1. **半隐式欧拉 + 固定子步**：帧率抖动（120Hz 屏 / 掉到 30fps）都不改变手感，
 *     也不会在大 dt 下发散。子步 1/240s，单帧最多 0.1s（切标签页回来的长 dt 直接截断）。
 *  2. **可判稳**：`settled` 用「离目标足够近 + 速度足够小」判定，只要全体判稳，
 *     驱动它的 rAF 就应当停 —— 空闲时**零帧**是这只角色能常驻的前提。
 *  3. **纯数据**：不碰 DOM、不碰时间源（dt 由调用方给），于是手感可以被单测钉住。
 */

/** 弹簧参数：刚度 + 阻尼比（临界阻尼 = 1.0；< 1 有回弹，> 1 偏黏） */
export interface SpringSpec {
  /** 刚度 k（越大越快） */
  stiffness: number;
  /** 阻尼比 ζ：0.6 弹、0.8 舒服、1.0 不超调 */
  dampingRatio?: number;
  /** 直接给阻尼系数（给了就不再用 dampingRatio） */
  damping?: number;
  /** 质量 m（默认 1） */
  mass?: number;
}

/** 单帧 dt 上限：切标签页回来时的 3s 长 dt 必须截断，否则会把弹簧一次冲过头 */
export const MAX_DT = 0.1;
/** 子步：1/240s 足够让 k 到 400 依然稳定，同时对 60/120Hz 都无感 */
const SUB_STEP = 1 / 240;

export class Spring {
  value: number;
  velocity: number;
  target: number;
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
  /** 判稳阈值（按量纲给：缩放用 1e-3，角度用 0.02 度） */
  readonly epsilon: number;

  constructor(initial: number, spec: SpringSpec, epsilon = 1e-3) {
    this.value = initial;
    this.velocity = 0;
    this.target = initial;
    this.mass = spec.mass ?? 1;
    this.stiffness = Math.max(0, spec.stiffness);
    this.damping = Math.max(
      0,
      spec.damping ?? 2 * (spec.dampingRatio ?? 0.8) * Math.sqrt(this.stiffness * this.mass),
    );
    this.epsilon = epsilon;
  }

  /** 改平衡点（不改速度：这就是"接着走"而不是"重新开始"） */
  to(next: number): this {
    this.target = next;
    return this;
  }

  /** 直接落到目标（首帧/降级用；速度清零） */
  snap(next: number): this {
    this.value = next;
    this.target = next;
    this.velocity = 0;
    return this;
  }

  get settled(): boolean {
    return Math.abs(this.value - this.target) <= this.epsilon && Math.abs(this.velocity) <= this.epsilon;
  }

  /**
   * 推进 dt 秒；返回**是否还在动**（false = 已判稳，调用方可以停 rAF）。
   */
  step(dt: number): boolean {
    if (this.settled) {
      // 已判稳：把残差抹平，避免长期停在 epsilon 边缘反复启停
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    let remaining = Math.min(Math.max(dt, 0), MAX_DT);
    while (remaining > 0) {
      const h = remaining > SUB_STEP ? SUB_STEP : remaining;
      remaining -= h;
      // 半隐式欧拉：先积分速度再积分位置（比显式欧拉稳定得多，且不需要解解析式）
      const accel = (-this.stiffness * (this.value - this.target) - this.damping * this.velocity) / this.mass;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    return true;
  }
}

/** 一组弹簧：一起推进，任一还在动就返回 true */
export function stepAll(springs: Iterable<Spring>, dt: number): boolean {
  let moving = false;
  for (const s of springs) if (s.step(dt)) moving = true;
  return moving;
}

/**
 * 单 rAF 循环驱动器。
 *
 * 语义刻意做成「onFrame 返回 false 就自动停」：调用方不需要记得在哪个分支里 stop，
 * 也就不可能出现"状态切换后忘了续帧/忘了停帧"的经典泄漏。
 */
export interface Ticker {
  start: () => void;
  stop: () => void;
  readonly running: boolean;
}

export function createTicker(
  onFrame: (dt: number, elapsed: number) => boolean,
  raf: (cb: (t: number) => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): Ticker {
  let id: number | null = null;
  let last = 0;
  let elapsed = 0;
  const api: Ticker = {
    get running() {
      return id !== null;
    },
    start() {
      if (id !== null) return;
      last = 0;
      id = raf(function loop(t) {
        id = raf(loop);
        if (!last) {
          last = t;
          return;
        }
        const dt = (t - last) / 1000;
        last = t;
        elapsed += dt;
        if (!onFrame(dt, elapsed)) api.stop();
      });
    },
    stop() {
      if (id === null) return;
      cancel(id);
      id = null;
    },
  };
  return api;
}

/** 系统的"减少动态"偏好：有就一律不做弹簧（直接到位），只在必要时保留表情切换 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 缓动：指数衰减到目标，用于不该有回弹的量（透明度等） */
export function approach(current: number, target: number, dt: number, halfLife: number): number {
  if (halfLife <= 0) return target;
  const k = 1 - Math.pow(0.5, dt / halfLife);
  return current + (target - current) * k;
}
