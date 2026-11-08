/**
 * ── 生效中的模型目录（进程内索引，同步查询） ──
 *
 * 为什么需要这一层：
 * `getModelContextWindow()` 是**同步**函数，被设置页与 Agent 循环在任意时刻调用；
 * 而目录的加载是异步的（读缓存/走网络）。把目录塞进同步函数的唯一办法，
 * 就是先把它压成一张内存索引，让同步查询变成一次 Map.get。
 *
 * 索引按 `模型 id 小写` 建键：上游 id 里大小写混用（GLM-5V-Turbo / kimi-k2.7），
 * 用户手填时不可能总对得上。同名冲突保留**先出现的**那个（目录顺序稳定，
 * 后到的覆盖只会让同一次会话里窗口忽大忽小）。
 *
 * 没设置（null）时所有查询返回 null，调用方退回本地窗口表——这是红线：
 * 目录不可用绝不能变成"没有预算"，只能是"用保守值"。
 */

import type { ModelCatalog, ModelInfo } from './types';

let index: Map<string, ModelInfo> | null = null;

/** 设置生效目录；传 null = 卸载（回落本地表） */
export function setActiveCatalog(catalog: ModelCatalog | null): void {
  if (!catalog) {
    index = null;
    return;
  }
  const map = new Map<string, ModelInfo>();
  for (const p of catalog.providers) {
    for (const m of p.models) {
      const key = m.id.trim().toLowerCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, m);
    }
  }
  index = map;
}

/** 生效索引里的模型数（0 = 尚未预热；用于诊断与设置页提示） */
export function activeCatalogSize(): number {
  return index?.size ?? 0;
}

/** 同步查询生效目录；未预热或查不到 → null */
export function lookupActiveModel(modelId: string): ModelInfo | null {
  const id = modelId?.trim().toLowerCase();
  if (!index || !id) return null;
  return index.get(id) ?? null;
}
