/**
 * 静态守卫：禁止已经明确删掉的行为悄悄回来。
 *
 * 为什么要这个：有些决定是**用户明确表过态的**（比如"不要按域名建文件夹"），
 * 删的时候只在系统提示里加了一句软规则。软规则挡不住回归——
 * 哪天有人给 `autoCategorize` 加个"默认也按域名建夹"的分支，
 * 或者在新工具里复制一份同样的逻辑，提示词那一句不会报错，用户也不会发现，
 * 直到他的书签栏里又出现一堆 `github.com` 文件夹。
 *
 * 这里用**源码事实**而不是提示词措辞来守：
 *   - 凡是 `create({ title: <某个域名> })` 这种形状，必须出现在
 *     一个名字里带 `domain`/`categorize` 的受控函数里，且该函数必须带前提说明；
 *   - 系统提示里"禁止"与"允许"不能对同一件事各说各话。
 *
 * 纯静态、不开浏览器：读文件 + 正则，失败时给出可定位的文件与行号。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

export interface GuardFinding {
  file: string;
  line: number;
  text: string;
  rule: string;
}

/**
 * 规则 1：`create({ … title: g.domain })` 这类"按域名命名文件夹"的调用，
 * 只能出现在文件名或所在函数名带 `domain` / `categorize` 的受控位置。
 *
 * 判据是**形状**（`title:` 的值来自域名变量），不是字符串"domain"——
 * 换个变量名照样能认出来。
 */
export function findDomainFolderCreation(files: { path: string; text: string }[]): GuardFinding[] {
  const out: GuardFinding[] = [];
  // 匹配 title: xxx.domain / title: g.domain / title: item.hostname …
  const re = /title:\s*[A-Za-z_$][\w$.]*\.(domain|hostname|host)\b/g;
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      re.lastIndex = 0;
      if (isControlled(f.path, lines, i)) return;
      out.push({ file: f.path, line: i + 1, text: line.trim(), rule: 'domain-folder-outside-controlled-module' });
    });
  }
  return out;
}

/**
 * 这一处"按域名建文件夹"是不是**受控的**。
 *
 * 判据有两个，满足其一即可：
 *  1. 文件路径里带 domain / categorize（专门的模块）；
 *  2. **所在函数**的名字带 domain / categorize ——
 *     真正的实现在 `lib/ai/tools.ts` 的 `autoCategorize` 里，只看文件路径会误报。
 */
function isControlled(path: string, lines: string[], lineIndex: number): boolean {
  if (/domain|categorize/i.test(path)) return true;
  /*
   * 往上收集**所有**声明，任一命中即算受控。
   *
   * 不能"取最近的一个"就返回：真正的实现函数上面往往还有若干内部箭头函数
   * （回调、局部 helper），最近的那个名字通常不带 domain/categorize，
   * 于是会把 `autoCategorize` 里的合法调用误报成违规。
   */
  const decl = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  for (let i = lineIndex; i >= 0 && i > lineIndex - 400; i--) {
    decl.lastIndex = 0;
    const m = decl.exec(lines[i]!);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? '';
    if (/domain|categorize/i.test(name)) return true;
  }
  return false;
}

/**
 * 规则 2：系统提示里不能同时对同一件事既禁止又允许。
 *
 * **必须传运行时的字符串**（`SYSTEM_PROMPT` 与 `TOOL_DEFINITIONS` 里真正发给模型的内容），
 * 不要传源码文件内容——源码里的注释不会发给模型，拿它判定会即使用户看到的自相矛盾
 * 已经消除也照样报红（这次就是这么栽的）。
 *
 * 具体查：出现「不要按域名新建文件夹」的同时，
 * 任何工具描述里提到 `auto_categorize` 就必须带上"用户明确要求"这类前提，
 * 否则模型读到两条会自相矛盾。
 */
export function findPromptSelfContradiction(promptText: string, toolDescriptions: string[]): GuardFinding[] {
  const out: GuardFinding[] = [];
  const hasBan = /不要按域名新建文件夹|不要自发按域名建文件夹/.test(promptText);
  if (!hasBan) {
    out.push({
      file: 'SYSTEM_PROMPT',
      line: 0,
      text: '找不到"不要按域名新建文件夹"这条硬规则',
      rule: 'missing-domain-ban',
    });
    return out;
  }
  // 提示词正文里每处提到 auto_categorize，附近必须有前提限定
  const lines = promptText.split('\n');
  const WINDOW = 20;
  lines.forEach((line, i) => {
    if (!line.includes('auto_categorize')) return;
    const nearby = lines.slice(i, i + WINDOW).join(' ');
    if (!/明确要求|仅在用户|用户明确/.test(nearby)) {
      out.push({ file: 'SYSTEM_PROMPT', line: i + 1, text: line.trim().slice(0, 120), rule: 'prompt-mention-without-precondition' });
    }
  });
  // 工具描述：提到按域名建夹就必须带前提
  toolDescriptions.forEach((d, idx) => {
    if (!/auto_categorize|按域名/.test(d)) return;
    if (!/明确要求|仅在用户|用户明确/.test(d)) {
      out.push({ file: `TOOL_DEFINITIONS[${idx}]`, line: 0, text: d.slice(0, 120), rule: 'tool-description-without-precondition' });
    }
  });
  return out;
}
