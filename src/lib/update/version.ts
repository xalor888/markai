/**
 * ── 语义化版本比较（自己写，不引依赖）──
 *
 * GitHub Releases 的 tag 形态并不统一（`v0.2.175` / `0.2.175` / `1.0.0-beta.2`），
 * 这里只实现 semver 里真正影响"要不要提示更新"的三条规则：
 *  - 前导 `v` 允许，构建元数据（`+sha`）不参与比较；
 *  - 预发布低于同版本正式版——beta 用户不该被告知"已是最新"；
 *  - 预发布标识逐段比较，纯数字按数值比，数字段低于字母段。
 *
 * 解析失败返回 null 而不是抛错：调用方要把畸形 tag 归类成"解析失败"，
 * 一个坏 tag 不该让顶栏按钮崩掉。
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw: string): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = VERSION_RE.exec(trimmed);
  if (!m) return null;
  const nums = [m[1]!, m[2]!, m[3]!].map((part) => Number(part));
  if (nums.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return {
    major: nums[0]!,
    minor: nums[1]!,
    patch: nums[2]!,
    prerelease: m[4] ? m[4].split('.') : [],
    raw: trimmed,
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // 正式版高于任何同版本预发布
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    // 前缀相同则段数多者更高（alpha.1 > alpha）
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    // 数字标识符的优先级低于字母标识符
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 返回 -1 / 0 / 1；任一版本非法时返回 null（调用方负责归类为解析失败） */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** 语义糖：candidate 是否比 current 新（非法输入一律 false，不误报更新） */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}
