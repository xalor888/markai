/**
 * 「制作宠物」入口（顶栏）。
 *
 * 打开宠物工作室：选造型、调色、命名、改口头禅。
 */
import { PawPrint } from 'lucide-react';
import { openPetStudio } from '@/stores/petStudioStore';

export function PetStudioButton() {
  return (
    <button
      type="button"
      onClick={openPetStudio}
      data-testid="pet-studio-entry"
      title="制作宠物"
      aria-label="制作宠物"
      className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <PawPrint className="h-3.5 w-3.5" />
    </button>
  );
}
