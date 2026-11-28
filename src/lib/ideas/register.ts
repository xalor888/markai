/**
 * 点子生成器注册（占位实现）。
 *
 * 真正的生成逻辑由「点子管家」工作线提供：把 `registerIdeaGenerator(...)` 换成真实实现即可，
 * 调用方（`lib/features/ideas.ts`）与 UI 不需要改。
 *
 * 占位阶段返回空数组是**有意为之**：UI 会继续显示规则建议（pet/suggest），
 * 所以"还没装好"不会表现为一块空白。
 */
import { registerIdeaGenerator } from '@/lib/features/ideas';

export function installIdeas(): void {
  registerIdeaGenerator(null);
}
