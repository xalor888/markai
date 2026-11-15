/**
 * ── 静态渲染器：把"某个心情的姿态"画成一段 SVG 字符串 ──
 *
 * 实时组件用 springs 驱动 DOM；这里用**同一份几何**一次性写死姿态，
 * 供表情总览图（README / 发版说明 / 商店素材）使用。
 *
 * 为什么值得单独写：配图必须与页面同源——改造型时总览图跟着变，
 * 不可能出现"文档里的脸和产品不一样"这种最伤信任的分裂。
 * 本文件只依赖 geometry + mood（纯数据），可被 Node 直接调用。
 */
import {
  PET_BLUSH,
  PET_BODY_PATH,
  PET_BROWS,
  PET_EYES,
  PET_FX,
  PET_LASH,
  PET_MOUTHS,
  PET_PALETTES,
  PET_SHADOW,
  PET_SHEEN,
  PET_VIEWBOX,
  closedEyeArc,
  type PetPalette,
} from './geometry';
import { EXPRESSIONS, expressionOf, type PetState } from './mood';

export { PET_PALETTES };

const FILLED = new Set(['grin', 'oh']);

function fxMarkup(fx: string, p: PetPalette): string {
  switch (fx) {
    case 'sparkle':
      return PET_FX.sparkles
        .map(
          ({ x, y }) =>
            `<path d="M ${x} ${y - 4} Q ${x} ${y} ${x + 4} ${y} Q ${x} ${y} ${x} ${y + 4} Q ${x} ${y} ${x - 4} ${y} Q ${x} ${y} ${x} ${y - 4} Z" fill="${p.fx}" opacity="0.9"/>`,
        )
        .join('');
    case 'sweat':
      return `<path d="${PET_FX.sweat}" fill="${p.fx}" opacity="0.9"/>`;
    case 'zzz':
      return PET_FX.zzz
        .map(
          ({ x, y, s }) =>
            `<path d="M ${x} ${y} H ${x + s} L ${x} ${y + s} H ${x + s}" fill="none" stroke="${p.fx}" stroke-width="2" stroke-linecap="round" opacity="${
              s >= 8 ? 0.92 : s >= 6 ? 0.7 : 0.5
            }"/>`,
        )
        .join('');
    case 'question': {
      const q = PET_FX.question;
      return `<path d="${q.path}" fill="none" stroke="${p.fx}" stroke-width="2.4" stroke-linecap="round"/><circle cx="${q.dot.cx}" cy="${q.dot.cy}" r="${q.dot.r}" fill="${p.fx}"/>`;
    }
    case 'ring':
      return `<circle cx="${PET_FX.ring.cx}" cy="${PET_FX.ring.cy}" r="${PET_FX.ring.r}" fill="none" stroke="${p.ring}" stroke-width="1.8" stroke-dasharray="5 9"/>`;
    case 'bang': {
      const b = PET_FX.bang;
      return `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.w}" height="${b.rect.h}" rx="${b.rect.rx}" fill="${p.alert}"/><circle cx="${b.dot.cx}" cy="${b.dot.cy}" r="${b.dot.r}" fill="${p.alert}"/>`;
    }
    case 'dots':
      return PET_FX.dots
        .map(({ x, y }, i) => `<circle cx="${x}" cy="${y}" r="2.4" fill="${p.fx}" opacity="${0.9 - i * 0.22}"/>`)
        .join('');
    default:
      return '';
  }
}

/** 把某个心情画成 SVG 字符串（同一页里多只时用 uid 区分渐变/裁切 id） */
export function renderPetSvg(
  state: PetState,
  size: number,
  palette: PetPalette = PET_PALETTES.light,
  uid: string = state,
): string {
  const e = expressionOf(state);
  const grad = `g-${uid}`;
  const bodyT = `translate(50 ${PET_PIVOT_TOP}) scale(${e.stretch} ${e.squash}) translate(-50 -${PET_PIVOT_TOP})`;
  const rootT = `translate(50 51) rotate(${e.tilt}) translate(-50 -51)`;
  const lid = Math.max(0, Math.min(1, e.lidOpen));
  const cover = 2 * PET_EYES.ry * (1 - lid);
  const arcOpacity = Math.max(0, Math.min(1, (0.22 - lid) / 0.22));
  const browTilt = e.browTilt;
  const browRaise = e.browRaise;

  const eye = (c: { x: number; y: number }, clip: string) => `
      <g>
        <g clip-path="url(#${clip})">
          <g transform="translate(${c.x} ${c.y}) scale(${e.eyeWidth} 1) translate(${-c.x} ${-c.y})">
            <ellipse cx="${c.x}" cy="${c.y}" rx="${PET_EYES.rx}" ry="${PET_EYES.ry}" fill="${palette.eye}"/>
            <rect x="${c.x - PET_EYES.rx}" y="${c.y - PET_EYES.ry}" width="${PET_EYES.rx * 2}" height="${PET_LASH.height}" fill="#000" opacity="${PET_LASH.opacity}"/>
            <g transform="translate(${e.gazeX} ${e.gazeY})">
              <circle cx="${c.x}" cy="${c.y}" r="${PET_EYES.pupil * e.pupil}" fill="${palette.pupil}"/>
              <circle cx="${c.x + PET_EYES.catchOffset.x}" cy="${c.y + PET_EYES.catchOffset.y}" r="${PET_EYES.catch}" fill="${palette.catch}"/>
            </g>
          </g>
          <rect x="${c.x - PET_EYES.rx}" y="${c.y - PET_EYES.ry}" width="${PET_EYES.rx * 2}" height="${cover}" fill="url(#${grad})"/>
        </g>
        <path d="${closedEyeArc(c.x, c.y)}" fill="none" stroke="${palette.mouth}" stroke-width="2.6" stroke-linecap="round" opacity="${arcOpacity.toFixed(3)}"/>
      </g>`;

  const brow = (b: { x: number; y: number }, inner: number, sign: number) =>
    `<path d="M ${b.x - PET_BROWS.halfWidth} ${b.y} Q ${b.x} ${b.y - PET_BROWS.arch * 2} ${b.x + PET_BROWS.halfWidth} ${b.y}" fill="none" stroke="${palette.brow}" stroke-width="${PET_BROWS.width}" stroke-linecap="round" opacity="${e.browAlpha}" transform="translate(0 ${-browRaise}) rotate(${(sign * browTilt).toFixed(2)} ${inner} ${b.y})"/>`;

  const mouth = PET_MOUTHS[e.mouth];
  const filled = FILLED.has(e.mouth);

  return `<svg viewBox="0 0 ${PET_VIEWBOX} ${PET_VIEWBOX}" width="${size}" height="${size}" role="img" aria-label="书签精灵：${e.aria}" data-pet-state="${state}">
  <defs>
    <linearGradient id="${grad}" gradientUnits="userSpaceOnUse" x1="30" y1="8" x2="62" y2="88">
      <stop offset="0" stop-color="${palette.bodyTop}"/>
      <stop offset="1" stop-color="${palette.bodyBottom}"/>
    </linearGradient>
    <clipPath id="c-l-${uid}"><ellipse cx="${PET_EYES.left.x}" cy="${PET_EYES.left.y}" rx="${PET_EYES.rx}" ry="${PET_EYES.ry}"/></clipPath>
    <clipPath id="c-r-${uid}"><ellipse cx="${PET_EYES.right.x}" cy="${PET_EYES.right.y}" rx="${PET_EYES.rx}" ry="${PET_EYES.ry}"/></clipPath>
  </defs>
  <ellipse cx="${PET_SHADOW.cx}" cy="${PET_SHADOW.cy}" rx="${PET_SHADOW.rx}" ry="${PET_SHADOW.ry}" fill="${palette.shadow}"/>
  <g transform="${rootT}">
    <g transform="${bodyT}">
      <path d="${PET_BODY_PATH}" fill="url(#${grad})"/>
      <path d="${PET_BODY_PATH}" fill="none" stroke="${palette.rim}" stroke-width="1"/>
      <ellipse cx="${PET_SHEEN.cx}" cy="${PET_SHEEN.cy}" rx="${PET_SHEEN.rx}" ry="${PET_SHEEN.ry}" fill="${palette.sheen}" transform="rotate(${PET_SHEEN.rotate} ${PET_SHEEN.cx} ${PET_SHEEN.cy})"/>
      ${eye(PET_EYES.left, `c-l-${uid}`)}
      ${eye(PET_EYES.right, `c-r-${uid}`)}
      ${brow(PET_BROWS.left, PET_BROWS.left.x + PET_BROWS.halfWidth, -1)}
      ${brow(PET_BROWS.right, PET_BROWS.right.x - PET_BROWS.halfWidth, 1)}
      ${PET_BLUSH.map(
        (b) => `<ellipse cx="${b.cx}" cy="${b.cy}" rx="${b.rx}" ry="${b.ry}" fill="${palette.blush}" opacity="${e.blush}"/>`,
      ).join('')}
      <path d="${mouth}" fill="${filled ? palette.mouth : 'none'}" stroke="${palette.mouth}" stroke-width="${
        filled ? 1.6 : 3
      }" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    ${fxMarkup(e.fx, palette)}
  </g>
</svg>`;
}

/** 身体的压扁支点（与实时组件一致：底边中点） */
const PET_PIVOT_TOP = 87;

/** 表情总览页：11 种心情 × 名称 + 一句话说明 */
export function renderPetSheet(options?: { dark?: boolean; cell?: number }): string {
  const cell = options?.cell ?? 148;
  const dark = options?.dark ?? false;
  const palette = PET_PALETTES[dark ? 'dark' : 'light'];
  const bg = dark ? '#0e1116' : '#ffffff';
  const card = dark ? '#151a21' : '#f7f8fa';
  const border = dark ? '#262d38' : '#e4e8ee';
  const ink = dark ? '#e3e8ef' : '#101828';
  const muted = dark ? '#98a3b2' : '#5a6572';

  const cells = (Object.keys(EXPRESSIONS) as PetState[])
    .map(
      (state) => `
      <figure class="cell">
        <div class="art">${renderPetSvg(state, cell, palette, `s-${state}`)}</div>
        <figcaption>
          <strong>${state}</strong>
          <span>${EXPRESSIONS[state].aria}</span>
        </figcaption>
      </figure>`,
    )
    .join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>MarkAI 书签精灵 · 心情总览</title>
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: ${bg}; color: ${ink}; font-family: -apple-system, "PingFang SC", system-ui, sans-serif; padding: 32px 36px; }
  h1 { font-size: 21px; letter-spacing: -0.01em; }
  h1 span { color: ${muted}; font-weight: 400; font-size: 13px; margin-left: 10px; }
  .grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 14px; margin-top: 22px; }
  .cell { background: ${card}; border: 1px solid ${border}; border-radius: 14px; padding: 12px 8px 10px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .art { width: ${cell}px; height: ${cell}px; display: flex; align-items: center; justify-content: center; }
  figcaption { text-align: center; display: flex; flex-direction: column; gap: 2px; }
  figcaption strong { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
  figcaption span { font-size: 10px; color: ${muted}; line-height: 1.35; }
  .foot { margin-top: 16px; font-size: 11px; color: ${muted}; }
</style></head>
<body>
  <h1>MarkAI 书签精灵<span>11 种心情 · 内联 SVG · 零图片资源</span></h1>
  <div class="grid">${cells}</div>
  <p class="foot">生命层（呼吸 / 摇摆 / 跳 / 眨眼 / 视线游移）跑在合成器上；反应层（压扁 / 眼皮 / 瞳孔 / 眉毛）由弹簧驱动，判稳即停——静止时主线程零帧。</p>
</body></html>`;
}
