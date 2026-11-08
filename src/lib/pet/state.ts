/**
 * ── 小宠物的状态与外观（纯函数） ──
 *
 * 状态不是"贴图切换"，而是一组**连续参数**（眼型 + 基础开合 + 呼吸幅度/周期 + 视线范围 + 眨眼频率）。
 * 这样"待机→思考中"是过渡，不是跳帧；也让状态机可以被单测钉住。
 *
 * 参考 dsh-pet 的做法：它用视频动画按权重首尾相接；我们没有素材预算，
 * 于是把"每个状态长什么样"压成参数表——差的是画面精致度，赢的是体积与连续性。
 */

import type { BlinkEvent } from './eyes';
import type { ChatMessage } from '@/lib/ai/types';

export type PetState = 'idle' | 'thinking' | 'working' | 'sleeping' | 'happy' | 'error';

export interface PetLook {
  /** 眼型名（EYE_SHAPES 的 key） */
  eye: string;
  /** 基础眼睑开合：睡觉时接近闭合 */
  lidBase: number;
  /** 呼吸缩放幅度（1 ± amp） */
  breathAmp: number;
  /** 呼吸周期（ms）：睡着时慢、工作时快 */
  breathPeriodMs: number;
  /** 视线最大偏移（0 = 不跟随指针，例如睡着） */
  gazeRange: number;
  /** 平均眨眼间隔（ms） */
  blinkEveryMs: number;
}

export const PET_LOOKS: Record<PetState, PetLook> = {
  idle: { eye: 'normal', lidBase: 1, breathAmp: 0.015, breathPeriodMs: 3200, gazeRange: 3.0, blinkEveryMs: 4200 },
  // 思考中：眯一点、呼吸加快、眨眼更频繁（"在想事情"的体感来自这个组合，不是单个参数）
  thinking: { eye: 'squint', lidBase: 0.78, breathAmp: 0.012, breathPeriodMs: 1900, gazeRange: 2.0, blinkEveryMs: 2600 },
  // 干活中：眼睛睁大一点、呼吸明显（"在忙"）
  working: { eye: 'squint', lidBase: 0.92, breathAmp: 0.022, breathPeriodMs: 1400, gazeRange: 2.6, blinkEveryMs: 3200 },
  // 睡着：几乎闭眼、慢呼吸、**不跟随指针**（跟随会立刻"醒"）
  sleeping: { eye: 'tired', lidBase: 0.12, breathAmp: 0.032, breathPeriodMs: 5200, gazeRange: 0, blinkEveryMs: 9000 },
  happy: { eye: 'happy', lidBase: 1, breathAmp: 0.026, breathPeriodMs: 1200, gazeRange: 3.2, blinkEveryMs: 2200 },
  error: { eye: 'tired', lidBase: 0.82, breathAmp: 0.008, breathPeriodMs: 4000, gazeRange: 0.8, blinkEveryMs: 5000 },
};

/** 状态 → 外观；未知状态回落 idle（宠物不该因为一个拼错的状态名变空白） */
export function lookOf(state: PetState): PetLook {
  return PET_LOOKS[state] ?? PET_LOOKS.idle;
}

/**
 * 呼吸缩放：正弦，值域 [1-amp, 1+amp]。
 * 用正弦而不是缓动曲线，是因为它**天然循环且无跳变**——呼吸不该有"接缝"。
 */
export function breathScale(tMs: number, periodMs: number, amp: number): number {
  if (periodMs <= 0) return 1;
  return 1 + Math.sin((tMs / periodMs) * Math.PI * 2) * amp;
}

/**
 * Agent 状态 → 宠物状态。
 *
 * 优先级：工具在跑 > 本轮在跑 > 空闲。不用"最近有无消息"判断——
 * 那会让宠物在解决长任务时看起来像发呆（用户最需要它"在忙"的时刻）。
 */
export function stateFromAgent(busy: boolean, toolRunning: boolean): PetState {
  if (toolRunning) return 'working';
  if (busy) return 'thinking';
  return 'idle';
}

/** 该轮到眨眼了吗：到点就排一次并推进下一次（间隔带 ±25% 抖动，避免机械节拍） */
export function scheduleBlink(
  queue: BlinkEvent[],
  now: number,
  nextAt: number,
  look: PetLook,
  random: () => number = Math.random,
): number {
  if (now < nextAt) return nextAt;
  const jitter = 0.75 + random() * 0.5;
  // 具体事件由 eyes.queueBlink 生成；这里只负责"何时"（职责分开，各自可测）
  return now + look.blinkEveryMs * jitter;
}

/**
 * 当前是否有工具正在执行。
 *
 * 为什么扫全部 assistant 消息而不是只看最后一条：Agent 一轮里可能有多回次，
 * 中途取消/重发会留下历史块——只看最后一条会在"刚重发、旧块还挂着 running"时误判。
 * status=running 本身只可能短暂存在，扫全量成本可以忽略（消息量级是几十条）。
 */
export function hasRunningTool(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.blocks) {
      if (b.kind === 'tool' && b.record.status === 'running') return true;
    }
  }
  return false;
}
