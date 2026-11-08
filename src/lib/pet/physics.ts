/**
 * ── 宠物手感：阻尼弹簧 + 边界反弹 + 挤压（纯函数） ──
 *
 * 借的是 dsh-pet 的**手感**，不是它的素材：甩出去有惯性、撞边回弹、按下有挤压回弹。
 * 那些全都能用两个数算出来（stiffness / damping），不需要物理引擎库。
 *
 * 单独成文件的原因：手感参数调起来是"凭感觉"的活，但**收敛性、稳定性、守恒**必须能被测试钉住——
 * 否则调参时很容易做出"甩一下就飞出去再也不回来"的动画。
 */

export interface SpringState {
  /** 当前位置（像素或归一化单位都行，只要 target 同单位） */
  pos: number;
  /** 当前速度（单位/秒） */
  vel: number;
}

/** 子步上限：一帧内最多推进 1/120 秒，避免 dt 过大时数值发散 */
const MAX_STEP_S = 1 / 120;

/**
 * 推进一步阻尼弹簧（半隐式欧拉）。
 *
 * 为什么 clamp dt：浏览器切回来时 `requestAnimationFrame` 的 timestamp 可能一次跳几百毫秒，
 * 直接拿它积分会让速度瞬间爆掉——表现是"宠物一回来就飞出面板"。
 *
 * @param stiffness 刚度：越大回弹越快（180 ≈ 200ms 内到位）
 * @param damping   阻尼：越大越"黏"，14 左右有轻微过冲的手感
 */
export function springStep(
  state: SpringState,
  target: number,
  dtMs: number,
  stiffness = 180,
  damping = 14,
): SpringState {
  let remaining = Math.max(0, Math.min(dtMs, 1000)) / 1000;
  let pos = state.pos;
  let vel = state.vel;
  while (remaining > 1e-9) {
    const dt = Math.min(remaining, MAX_STEP_S);
    const accel = -stiffness * (pos - target) - damping * vel;
    vel += accel * dt;
    pos += vel * dt;
    remaining -= dt;
  }
  return { pos, vel };
}

/**
 * 边界反弹：越界时把位置钳回并把法向速度反向（带损耗）。
 *
 * `restitution = 1` 是理想弹球（永不停止），现实里取 0.55–0.7：
 * 甩出去撞墙后还会再弹一下，然后停下。
 */
export function bounceOff(
  pos: number,
  vel: number,
  min: number,
  max: number,
  restitution = 0.6,
): SpringState {
  if (pos < min) return { pos: min, vel: Math.abs(vel) * restitution };
  if (pos > max) return { pos: max, vel: -Math.abs(vel) * restitution };
  return { pos, vel };
}

/**
 * 挤压比例（Q 弹）：按下时横向撑开、纵向压扁。
 *
 * 用近似体积守恒（sx * sy ≈ 1 的量级），而不是"两个方向都缩小"——
 * 后者看起来像缩小，不像被按。
 *
 * @param depth 按压深度 0（松）–1（按到底）
 */
export function squash(depth: number): { sx: number; sy: number } {
  const d = Math.min(Math.max(depth, 0), 1);
  const k = 0.16 * d;
  return { sx: 1 + k, sy: 1 - k };
}

/**
 * 拖拽时的倾斜角（度）。
 *
 * 限幅到 ±12°：再大就像"要摔倒"，而不是"被拎起来"。
 * 只按水平位移算——纵向倾斜在小小的头部图标上会读不出来，只会显得乱。
 */
export function tiltDeg(dx: number, maxDeg = 12): number {
  const raw = dx * 0.9;
  return Math.max(-maxDeg, Math.min(maxDeg, raw));
}

/**
 * 是否可以停止动画：位置已经贴住目标、速度也小到看不见。
 *
 * 两个条件都要，只看速度会在"高速穿过目标的那一帧"误判为静止。
 */
export function isResting(
  state: SpringState,
  target: number,
  posEps = 0.5,
  frameMs = 16,
): boolean {
  // 判据是"下一帧位移已经看不出"，而不是"速度小于某个绝对值"——
  // 后者依赖单位尺度：对 100 单位的位移，0.08/s 的速度要一千多秒才走完，但那叫静止。
  const stepDist = Math.abs(state.vel) * (frameMs / 1000);
  return Math.abs(state.pos - target) < posEps && stepDist < posEps;
}
