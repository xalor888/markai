/**
 * ── 个性化指令（称呼 / 详略 / 主动程度） ──
 *
 * 三件事刻意做成**能改行为**的开关，而不是装饰性设置：
 *  - 称呼：影响它怎么叫你
 *  - 详略：影响回答长度
 *  - 主动程度：影响它会不会主动提建议
 *
 * 两条安全边界：
 *  1. 空值 = 不加任何指令。默认配置下系统提示词**一字不变**（不引入行为漂移）。
 *  2. 称呼要清洗：它会被拼进系统提示，带换行或引号就是一次提示注入。
 */

import type { AIConfig } from '@/lib/ai/types';

/** 称呼长度上限：再长就不是称呼，是句子 */
const MAX_NAME_CHARS = 16;

/** 清洗称呼：去引号/换行/控制符，截断长度 */
export function sanitizeName(raw?: string): string {
  if (!raw) return '';
  return raw
    // 换行/制表先变空格（直接删掉会把 'a\nb' 粘成 'ab'，那是在改内容而不是清洗）
    .replace(/[\n\r\t]/g, ' ')
    .replace(/[「」『』"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);
}

export type PersonalConfig = Pick<AIConfig, 'addressName' | 'verbosity' | 'proactivity'>;

/**
 * 生成追加到系统提示词的一段。
 *
 * 返回空串表示"什么都不加"——调用方直接拼接即可，不需要判断。
 */
export function personalInstruction(cfg?: Partial<PersonalConfig> | null): string {
  if (!cfg) return '';
  const lines: string[] = [];

  const name = sanitizeName(cfg.addressName);
  if (name) lines.push(`称呼用户为「${name}」。`);

  if (cfg.verbosity === 'concise') {
    lines.push('回答尽量简短：先给结论，必要步骤用短句；不要复述用户已经知道的内容。');
  } else if (cfg.verbosity === 'detailed') {
    lines.push('回答可以展开：说明为什么这么做、会影响到什么范围，并在结尾给出可回退的方式。');
  }

  if (cfg.proactivity === 'quiet') {
    lines.push('只在用户明确要求时给建议；不要主动提出未被问到的操作。');
  } else if (cfg.proactivity === 'active') {
    lines.push('在合适的时机主动提出一条具体、可执行的小建议（一次只提一条，不要罗列）。');
  }

  if (lines.length === 0) return '';
  return `\n\n【个性化】\n${lines.join('\n')}`;
}
