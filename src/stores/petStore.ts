/**
 * ── 宠物设置与"刚刚发生了什么" ──
 *
 * 两件不同的东西放在一起，因为它们都是"宠物的输入"，而且都需要跨窗口共享：
 *  · `PetSettings`：用户可改的（开关、大小、说不说话、眼睛跟不跟指针），落盘到 storage；
 *  · `PetSignals` 的原料：成功/失败的时间戳、最近互动时刻、碎碎念的冷却状态。
 *
 * 为什么不塞进 `markai.config`：那份配置是「AI 服务」的 schema（provider/baseUrl/key…），
 * 每加一个 UI 偏好都要动它的校验与迁移；宠物是个独立的展示层，用独立 key 更干净，
 * 用户在设置页清空 AI 配置时也不会顺手把宠物设置清掉。
 */

import { create } from 'zustand';
import type { ChatterState } from '@/lib/pet/chatter';
import {
  PET_DEFAULT_DESIGN,
  normalizePetDesign,
  type PetDesign,
} from '@/lib/pet/design';

/** 落盘 key（与 AI 配置分开，见文件头） */
export const PET_STORAGE_KEY = 'markai.pet';
/** 碎碎念冷却状态单独存：它是运行时数据，不该混进用户设置里被"恢复默认"抹掉 */
export const PET_CHATTER_KEY = 'markai.pet.chatter';

export type PetSize = 48 | 56 | 72;

export interface PetSettings {
  enabled: boolean;
  size: PetSize;
  /** 允许它主动碎碎念（关掉后只在点击时说话） */
  chatter: boolean;
  /** 眼珠跟随指针（关掉 = 更省电，也不会有"被盯着"的压迫感） */
  follow: boolean;
  /**
   * 外观（名字/口头禅/轮廓/配色/配件）。
   *
   * 嵌在设置里而不是另开一个 key：它和 enabled/size 一样是"用户对宠物的偏好"，
   * 拆开会让"恢复默认"要清两处，也会让导出/导入漏掉一半。
   */
  design: PetDesign;
}

export const PET_DEFAULT_SETTINGS: PetSettings = {
  enabled: true,
  size: 56,
  chatter: true,
  follow: true,
  design: PET_DEFAULT_DESIGN,
};

export const PET_SIZES: PetSize[] = [48, 56, 72];

const EMPTY_CHATTER: ChatterState = { lastAnyAt: 0, lastById: {}, mutedUntil: 0 };

interface PetStore extends PetSettings {
  /** 碎碎念冷却 */
  chatterState: ChatterState;
  /** 最近一次成功 / 失败（0 = 没有；供心情裁决使用） */
  lastSuccessAt: number;
  lastFailureAt: number;
  /** 被撸了一把（双击）→ 得意 */
  lastPrideAt: number;
  /** 最近一次用户活动（指针/键盘/点击宠物） */
  lastActiveAt: number;
  loaded: boolean;

  load: () => Promise<void>;
  update: (patch: Partial<PetSettings>) => Promise<void>;
  /** 记一次用户活动（节流由调用方做，这里只写值） */
  touch: (now?: number) => void;
  markSuccess: (now?: number) => void;
  markFailure: (now?: number) => void;
  markPride: (now?: number) => void;
  /** 记录一次发言：更新全局间隔与单条冷却 */
  spoken: (factId: string, now?: number) => void;
  /** 静默到某个时刻（用户正在打字/任务进行中） */
  muteUntil: (until: number) => void;
}

/** 只写变化的字段：storage 是全量覆盖，漏字段会把用户的其它设置抹掉 */
function pickSettings(raw: unknown): Partial<PetSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<PetSettings> = {};
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.chatter === 'boolean') out.chatter = src.chatter;
  if (typeof src.follow === 'boolean') out.follow = src.follow;
  if (src.size === 48 || src.size === 56 || src.size === 72) out.size = src.size;
  // 旧版本没有 design 字段：normalize 会把空对象洗成默认造型，
  // 但**不能**在这里无条件赋值，否则 storage 里没有 design 时会把内存里的用户改动冲掉
  if (src.design && typeof src.design === 'object') out.design = normalizePetDesign(src.design);
  return out;
}

export const usePetStore = create<PetStore>((set, get) => ({
  ...PET_DEFAULT_SETTINGS,
  chatterState: EMPTY_CHATTER,
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastPrideAt: 0,
  lastActiveAt: 0,
  loaded: false,

  load: async () => {
    try {
      const data = await chrome.storage.local.get([PET_STORAGE_KEY, PET_CHATTER_KEY]);
      const settings = pickSettings(data[PET_STORAGE_KEY]);
      const rawChatter = data[PET_CHATTER_KEY] as Partial<ChatterState> | undefined;
      set({
        ...settings,
        chatterState: rawChatter
          ? {
              lastAnyAt: Number(rawChatter.lastAnyAt) || 0,
              lastById: rawChatter.lastById && typeof rawChatter.lastById === 'object' ? rawChatter.lastById : {},
              mutedUntil: Number(rawChatter.mutedUntil) || 0,
            }
          : EMPTY_CHATTER,
        loaded: true,
      });
    } catch {
      // 读不到就按默认显示：宠物不该因为 storage 抖动而消失
      set({ loaded: true });
    }
  },

  update: async (patch) => {
    // design 走 normalize：外部（工作室/导入）传进来的可能是半截对象，
    // 直接 set 会让宠物变成"没有轮廓"的空白
    const next = patch.design ? { ...patch, design: normalizePetDesign(patch.design) } : patch;
    set(next);
    const current = {
      enabled: get().enabled,
      size: get().size,
      chatter: get().chatter,
      follow: get().follow,
      design: get().design,
    };
    try {
      await chrome.storage.local.set({ [PET_STORAGE_KEY]: current });
    } catch {
      // 落盘失败不影响本次会话的表现（下一次改动会再写一次）
    }
  },

  touch: (now = Date.now()) => set({ lastActiveAt: now }),
  markSuccess: (now = Date.now()) => set({ lastSuccessAt: now }),
  markFailure: (now = Date.now()) => set({ lastFailureAt: now }),
  markPride: (now = Date.now()) => set({ lastPrideAt: now }),

  spoken: (factId, now = Date.now()) => {
    const prev = get().chatterState;
    const next: ChatterState = {
      lastAnyAt: now,
      lastById: { ...prev.lastById, [factId]: now },
      mutedUntil: prev.mutedUntil,
    };
    set({ chatterState: next });
    void chrome.storage.local.set({ [PET_CHATTER_KEY]: next }).catch(() => {});
  },

  muteUntil: (until) => {
    const prev = get().chatterState;
    if (until <= prev.mutedUntil) return;
    const next: ChatterState = { ...prev, mutedUntil: until };
    set({ chatterState: next });
  },
}));
