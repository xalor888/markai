/** ── 域名工具（Agent 分类工具与「新书签自动整理」共用） ── */

/** 常见两段式国家/地区域名后缀（注册域需取三段，如 co.uk / com.cn） */
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'com.tw', 'com.jp', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.sg', 'com.au',
  'com.br', 'com.mx', 'co.in', 'com.tr', 'co.za', 'com.ar', 'com.ua', 'com.ru',
]);


/**
 * IP 字面量判断（IPv4 四段点分 / IPv6 带方括号）。
 * 为什么需要：URL 规范化后 IPv6 主机是 `[::1]` 形态，IPv4 是纯数字四段，
 * 两者都不适用"取最后两段"的注册域规则。
 */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * 从 URL 提取注册域（registrable domain）：`https://docs.github.com/x` → `github.com`。
 * 解析失败返回 null（调用方据此决定「无法识别」而不是硬塞一个假分类）。
 *
 * IP 直连（NAS / 内网面板）返回主机本身：按"最后两段"截断会把 192.168.1.10 变成 `1.10`，
 * 既不是域名，还会把 192.168.1.10 与 172.16.1.10 折进同一个分类（T77 回归）。
 */
export function registrableDomain(raw: string): string | null {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (isIpLiteral(host)) return host.replace(/^\[|\]$/g, '');
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return host || null;
    // 常见 ccTLD 组合（co.uk 等）：注册域 = 最后三段
    const lastTwo = parts.slice(-2).join('.');
    if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  } catch {
    return null;
  }
}
