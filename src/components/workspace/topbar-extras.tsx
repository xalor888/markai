/**
 * 顶栏右侧的扩展入口。
 *
 * 单独成文件的原因：工作区顶栏已经是全项目最拥挤的 14 行，三个新入口
 * （检查更新 / 点子 / 制作宠物）各有自己的工作线。放在这里组合，
 * 每个入口一个文件，互不改动，顶栏本身只多一行挂载。
 */
import { UpdateCheckButton } from '@/components/update/update-check-button';
import { IdeaButton } from '@/components/ideas/idea-button';
import { PetStudioButton } from '@/components/pet/pet-studio-button';

export function TopbarExtras() {
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="topbar-extras">
      <IdeaButton />
      <PetStudioButton />
      <UpdateCheckButton />
    </div>
  );
}
