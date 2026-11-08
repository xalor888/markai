/**
 * ── 小宠物的眼睛：多边形眼型 + 眨眼队列 + 视线（纯数据层，无 DOM） ──
 *
 * 移植自 grok-icon-study 的角色引擎（`replica/src/eyes.js` + `math.js` + `tables.js`），
 * 只保留"让它像活的"那部分：眼型是**多边形顶点插值**，不是图片、不是 Lottie、不是视频。
 *
 * 为什么不用图片/视频（dsh-pet 用 100+ 段透明视频）：
 * 扩展包体现在 1.07 MB，一段视频就几百 KB；而程序化眼睛整套逻辑不到 5 KB，
 * 还能随状态（思考中/工作中/待机）连续变形，视频只能离散切换。
 *
 * 这一层刻意只有纯函数：渲染（SVG）在 B2 做，于是这里的每条规则都能单测。
 */

export type Point = readonly [number, number];

/** 眼型：归一化到 [-1, 1] 的多边形（8 点，从正上方顺时针），y 向下为正 */
export interface EyeShape {
  name: string;
  poly: Point[];
}

/** 五套基础眼型（手写数值，不需要 25 套也够表达情绪） */
export const EYE_SHAPES: Record<string, EyeShape> = {
  /** 平常：接近圆 */
  normal: {
    name: 'normal',
    poly: [[0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7]],
  },
  /** 开心：上缘抬高、下缘收窄（笑起来眼睛变弯） */
  happy: {
    name: 'happy',
    poly: [[0, -0.6], [0.75, -0.45], [1, 0.1], [0.7, 0.55], [0, 0.75], [-0.7, 0.55], [-1, 0.1], [-0.75, -0.45]],
  },
  /** 专注/眯眼：纵向压扁 */
  squint: {
    name: 'squint',
    poly: [[0, -0.45], [0.8, -0.3], [1, 0], [0.8, 0.3], [0, 0.45], [-0.8, 0.3], [-1, 0], [-0.8, -0.3]],
  },
  /** 累了：下缘下坠 */
  tired: {
    name: 'tired',
    poly: [[0, -0.7], [0.7, -0.5], [1, 0.05], [0.75, 0.75], [0, 0.9], [-0.75, 0.75], [-1, 0.05], [-0.7, -0.5]],
  },
  /** 喜欢：接近心形的 8 点近似 */
  heart: {
    name: 'heart',
    poly: [[0, -0.9], [0.8, -0.55], [1, 0.05], [0.6, 0.8], [0, 1], [-0.6, 0.8], [-1, 0.05], [-0.8, -0.55]],
  },
};

/**
 * 多边形插值。
 *
 * 点数不等时**抛错**而不是"自己截断"：截断出来的形状会静默变形，
 * 那种 bug 在动画里表现为"眼睛突然抽搐"，极难归因。
 */
export function lerpPoly(a: Point[], b: Point[], t: number): Point[] {
  if (a.length !== b.length) throw new Error(`眼型点数不一致：${a.length} vs ${b.length}`);
  const k = Math.min(Math.max(t, 0), 1);
  return a.map((p, i) => {
    const q = b[i]!;
    return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k] as Point;
  });
}

/** 眼睑闭合下限：完全闭合时仍留一丝缝，否则看起来像"眼睛消失了"而不是"闭上了" */
export const LID_MIN = 0.04;
/** 眨眼过冲上限：1.08 的轻微过冲让闭合有"弹一下"的手感 */
export const LID_MAX = 1.08;

/**
 * 按眼睑开合度纵压眼型（lid=0 闭、1 全开、>1 过冲）。
 * 只压缩 y：横向尺寸保持不变，否则眨眼时眼睛会左右抽动。
 */
export function applyLid(poly: Point[], lid: number): Point[] {
  const l = Math.min(Math.max(lid, LID_MIN), LID_MAX);
  return poly.map(([x, y]) => [x, y * l] as Point);
}

export interface BlinkEvent {
  /** 相对时间（ms） */
  at: number;
  /** 目标开合度 */
  v: number;
}

/**
 * 排一次眨眼：快速闭（70ms 保持）→ 过冲睁（1.08）→ 回落 1.0。
 * 14% 概率追加第二次（双眨），这是"活物感"的关键细节——每次都单眨反而机械。
 *
 * `random` 注入是为了可测：测试里给 0.1 就会走双眨分支。
 */
export function queueBlink(queue: BlinkEvent[], now: number, random: () => number = Math.random): void {
  queue.push(
    { at: now, v: LID_MIN },
    { at: now + 70, v: LID_MIN },
    { at: now + 150, v: 1.08 },
    { at: now + 300, v: 1 },
  );
  if (random() < 0.14) {
    queue.push({ at: now + 370, v: LID_MIN }, { at: now + 480, v: 1 });
  }
}

/**
 * 取出到期的开合度；没有到期事件返回 null（调用方保留上一次的值）。
 * 循环消费而不是只看队首：一帧跳过大间隔时（掉帧），中间事件不能积压。
 */
export function consumeBlink(queue: BlinkEvent[], now: number): number | null {
  let v: number | null = null;
  while (queue.length > 0 && now >= queue[0]!.at) v = queue.shift()!.v;
  return v;
}

/**
 * 视线偏移：指针相对眼睛中心的方向 + 限幅。
 *
 * 近处按比例（0.28 倍距离），远处饱和到 maxRadius——完全按距离线性会把瞳孔甩到眼眶外，
 * 完全固定又变成"死盯"。饱和值就是"眼睛能转到的极限"。
 */
export function gazeOffset(
  pointer: Point,
  center: Point,
  maxRadius: number,
): { x: number; y: number } {
  const dx = pointer[0] - center[0];
  const dy = pointer[1] - center[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const pull = Math.min(d * 0.28, maxRadius);
  return { x: (dx / d) * pull, y: (dy / d) * pull };
}

/** 眼型名 → 多边形；未知名字回落到 normal（不抛错：宠物不该因为一个拼错的状态名崩溃） */
export function shapeOf(name: string): Point[] {
  return (EYE_SHAPES[name] ?? EYE_SHAPES['normal']!).poly;
}
