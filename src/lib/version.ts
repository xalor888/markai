/**
 * 版本号的唯一来源：扩展清单。
 *
 * `manifest.version` 由 WXT 从 `package.json` 注入，所以 UI 只要读清单，
 * 就永远和真实产物一致。**不要在界面里硬编码版本号**——本项目已经栽过一次：
 * `config-form.tsx` 与 `popup/main.tsx` 里的 "v0.2.1" 在 0.2.0 → 0.2.1 时被漏改，
 * 界面显示的版本与装到浏览器里的产物脱节（`tests/agent.test.ts` 的 T25 现在会拦住它）。
 */
export function appVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    // 非扩展环境（例如被 node 测试在极早期加载）兜底，不让界面因读不到清单而崩。
    // 刻意不写成「0.0.0」这类看起来像版本号的假值：宁可显示"未知"，
    // 也不要让一个假版本号混进界面（T25 的源码守卫会拦下三段式版本字面量）。
    return '未知';
  }
}
