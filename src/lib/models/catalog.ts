/**
 * ── models.dev 目录的归一化与查询（纯函数，无 chrome / 无网络） ──
 *
 * 只做三件事：
 *  1. 把上游 5.7 MB 的 `api.json` 压成 `ModelCatalog`（丢掉用不上的字段）
 *  2. 把三种「思考能力」形态（toggle / effort / 空数组）归一成 UI 能直接用的 `ReasoningPolicy`
 *  3. 把本地 preset id 对齐 models.dev 的 id（`moonshot` → `moonshotai`）
 *
 * 刻意不在这里做网络与存储：那两件事在 `store.ts`（要碰 chrome API），
 * 混在一起就再也测不了——上一次「模型窗口恒为 1M」的事故，就是因为这个判断埋在 IO 里。
 */

import type {
  CatalogIssue,
  CatalogProvider,
  ModelCatalog,
  ModelInfo,
  ReasoningKind,
  ReasoningPolicy,
} from './types';

/**
 * effort 档位的标准次序（由弱到强）。
 *
 * models.dev 各家给的子集不一样（OpenAI 有 `none/xhigh/max`，DeepSeek 只有 `low/high/max`），
 * 统一按这张表排序，UI 的滑杆/分段控件才不会在切换模型时左右横跳。
 * 不在表里的值不丢，按字母序排在末尾——上游新增档位时能立刻显示，而不是被静默吃掉。
 */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 本地 preset id → models.dev provider id。
 *
 * 实测差异（2026-11 的 api.json）：
 *  - 本地 `moonshot`   → 上游 `moonshotai`（另有 `moonshotai-cn` 中国区）
 *  - 本地 `zhipu`      → 上游 `zhipuai`（另有 `zhipuai-coding-plan`）
 *  - 本地 `openai` / `deepseek` 同名，无需映射
 *  - 本地 `ollama` / `opencode-go` / `custom` 上游**没有**：本地模型与自建网关没有元数据，
 *    只能靠 GET /models + 本地窗口表兜底（别假装能查到）
 */
export const PROVIDER_ALIASES: Record<string, string> = {
  moonshot: 'moonshotai',
  zhipu: 'zhipuai',
  'moonshot-cn': 'moonshotai-cn',
};

/** 本地 preset id → models.dev id；未知原样返回（自定义网关仍可能同名） */
export function canonicalProviderId(localId: string): string {
  return PROVIDER_ALIASES[localId] ?? localId;
}

/** 决定"该不该给用户一个思考强度控件"，以及控件长什么样 */
export function resolveReasoningPolicy(raw: Record<string, unknown>): ReasoningPolicy {
  const supported = raw['reasoning'] === true;
  const field = readInterleavedField(raw);
  if (!supported) return { supported: false, kind: null, efforts: [], field };

  const options = Array.isArray(raw['reasoning_options']) ? raw['reasoning_options'] : [];
  // 有 reasoning 能力但上游没给任何选项：会思考、不可调（kimi-k2.7 就是这种）
  if (options.length === 0) return { supported: true, kind: null, efforts: [], field };

  let kind: ReasoningKind | null = null;
  let efforts: string[] = [];
  for (const opt of options) {
    if (typeof opt !== 'object' || opt === null) continue;
    const o = opt as Record<string, unknown>;
    const type = o['type'];
    if (type === 'effort') {
      kind = 'effort';
      efforts = normalizeEfforts(o['values']);
    } else if (type === 'toggle' && kind === null) {
      // 先记 toggle，但**继续往下找 effort**：DeepSeek 同时给了 toggle 与 effort，
      // 后者信息量更大（能给档位就不该只给开关）
      kind = 'toggle';
    }
  }
  return { supported: true, kind, efforts, field };
}

/** 读取思考流字段名；拿不到给 `reasoning_content`（实测四家 OpenAI 兼容端点都用它） */
function readInterleavedField(raw: Record<string, unknown>): string | null {
  const interleaved = raw['interleaved'];
  if (typeof interleaved === 'object' && interleaved !== null) {
    const f = (interleaved as Record<string, unknown>)['field'];
    if (typeof f === 'string' && f.trim()) return f.trim();
  }
  return raw['reasoning'] === true ? 'reasoning_content' : null;
}

/** 档位归一：去重、按 EFFORT_ORDER 排序、未知值按字母序垫后 */
export function normalizeEfforts(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) seen.add(v.trim().toLowerCase());
  }
  const known = EFFORT_ORDER.filter((e) => seen.has(e));
  const unknown = [...seen].filter((v) => !(EFFORT_ORDER as readonly string[]).includes(v)).sort();
  return [...known, ...unknown];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 单个模型归一化。
 *
 * 缺 `id` 的条目直接返回 null：没有 id 就没法在请求里指名，留着只会让 UI 出现
 * 一个点了没反应的选项（0.2.69「死按钮」那一类问题）。
 */
export function normalizeModel(raw: unknown, providerId: string): ModelInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r['id']);
  if (!id) return null;
  const limit = (typeof r['limit'] === 'object' && r['limit'] !== null ? r['limit'] : {}) as Record<string, unknown>;
  const cost = typeof r['cost'] === 'object' && r['cost'] !== null ? (r['cost'] as Record<string, unknown>) : null;
  return {
    id,
    providerId,
    name: str(r['name']) ?? id,
    description: str(r['description']),
    contextLimit: num(limit['context']) ?? num(limit['input']),
    outputLimit: num(limit['output']),
    reasoning: resolveReasoningPolicy(r),
    // 上游缺字段时的语义：**保守**。没写 tool_call 就不当作能调工具，
    // 否则 UI 会推荐一个发起工具调用必然失败的模型。
    toolCall: r['tool_call'] === true,
    attachment: r['attachment'] === true,
    cost: cost ? { input: num(cost['input']), output: num(cost['output']) } : null,
    updatedAt: str(r['last_updated']) ?? str(r['release_date']),
  };
}

/** 上游整份 api.json → 内部目录。坏条目计数进 issues，不静默丢弃 */
export function normalizeCatalog(
  json: unknown,
): { catalog: ModelCatalog; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  const providers: CatalogProvider[] = [];
  if (typeof json !== 'object' || json === null) {
    return { catalog: { fetchedAt: 0, source: 'fallback', providers: [] }, issues };
  }
  for (const [providerId, rawProvider] of Object.entries(json as Record<string, unknown>)) {
    if (typeof rawProvider !== 'object' || rawProvider === null) {
      issues.push({ providerId, modelId: '*', reason: 'provider 不是对象' });
      continue;
    }
    const p = rawProvider as Record<string, unknown>;
    const rawModels = typeof p['models'] === 'object' && p['models'] !== null ? (p['models'] as Record<string, unknown>) : null;
    if (!rawModels) {
      issues.push({ providerId, modelId: '*', reason: 'models 字段缺失或不是对象' });
      continue;
    }
    const models: ModelInfo[] = [];
    for (const [modelKey, rawModel] of Object.entries(rawModels)) {
      const m = normalizeModel(rawModel, providerId);
      if (!m) {
        issues.push({ providerId, modelId: modelKey, reason: '缺 id 或不是对象' });
        continue;
      }
      models.push(m);
    }
    providers.push({ id: providerId, name: str(p['name']) ?? providerId, models });
  }
  return { catalog: { fetchedAt: 0, source: 'remote', providers }, issues };
}

/** 按 provider 取模型；未知 provider 返回空数组（不是全量目录，免得 UI 显示别人的模型） */
export function modelsForProvider(catalog: ModelCatalog, localProviderId: string): ModelInfo[] {
  const canonical = canonicalProviderId(localProviderId);
  const p = catalog.providers.find((x) => x.id === canonical);
  return p ? p.models : [];
}

/**
 * 跨 provider 找模型：先精确 id，再大小写不敏感，再 `providerId/modelId` 组合。
 *
 * 返回 null 而非抛错——调用方（设置页、请求构建）都只需要"知不知道该模型的窗口"，
 * 查不到时的正确行为是回退本地表，而不是让整个设置页白屏。
 */
export function findModel(catalog: ModelCatalog, modelId: string, localProviderId?: string): ModelInfo | null {
  const id = modelId.trim();
  if (!id) return null;
  const scoped = localProviderId ? modelsForProvider(catalog, localProviderId) : null;
  const pools = scoped && scoped.length > 0 ? [scoped] : catalog.providers.map((p) => p.models);
  for (const pool of pools) {
    const hit = pool.find((m) => m.id === id);
    if (hit) return hit;
  }
  const lower = id.toLowerCase();
  for (const pool of pools) {
    const hit = pool.find((m) => m.id.toLowerCase() === lower);
    if (hit) return hit;
  }
  // `provider/model` 形式（用户手填 "deepseek/deepseek-v4-pro" 的常见写法）
  const slash = id.indexOf('/');
  if (slash > 0) {
    const pid = id.slice(0, slash);
    const mid = id.slice(slash + 1);
    for (const p of catalog.providers) {
      if (p.id !== canonicalProviderId(pid)) continue;
      const hit = p.models.find((m) => m.id === mid);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 用户选的档位 → 实际能发的档位。
 *
 * 三种返回：
 *  - `null`  该模型不支持思考 / 不可调 → **不要往请求里加任何思考参数**
 *  - `'toggle'` 只能开不能调 → 调用方发"开启思考"的开关
 *  - 具体字符串 → 就是 effort 值
 *
 * 找不到精确匹配时回落到**最近的**档位（按 EFFORT_ORDER 距离），而不是静默返回 null：
 * 用户在"高压"模型上选了 `medium`、切到只支持 `low/high/max` 的模型后，
 * 静默关闭思考会让回答质量突然掉一档，而他不知道为什么。
 */
export function pickEffort(
  policy: ReasoningPolicy,
  wanted?: string | null,
): string | 'toggle' | null {
  if (!policy.supported) return null;
  if (policy.kind === 'toggle' || policy.efforts.length === 0) return policy.kind === 'toggle' ? 'toggle' : null;
  const target = (wanted ?? 'medium').trim().toLowerCase();
  if (policy.efforts.includes(target)) return target;
  const targetIdx = (EFFORT_ORDER as readonly string[]).indexOf(target);
  if (targetIdx >= 0) {
    // 按绝对距离找最近档位；距离相同取更弱的那档（省钱、少超时）
    let best = policy.efforts[0]!;
    let bestDist = Infinity;
    for (const e of policy.efforts) {
      const idx = (EFFORT_ORDER as readonly string[]).indexOf(e);
      const dist = idx >= 0 ? Math.abs(idx - targetIdx) : Infinity;
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }
  // 用户选了上游不认识的档位（手写配置/旧值）：取中间档，比极端更安全
  return policy.efforts[Math.floor(policy.efforts.length / 2)]!;
}

/**
 * 内置最小快照：断网、models.dev 挂了、首次启动还没拉到时用。
 *
 * 数据直接从 2026-11 的 api.json 抄出来（不是猜的），覆盖本地 preset 的主力模型；
 * `source: 'fallback'` 让 UI 能诚实地标一句"离线快照，可能过期"。
 */
export function fallbackCatalog(): ModelCatalog {
  const model = (
    providerId: string,
    id: string,
    name: string,
    contextLimit: number,
    reasoning: ReasoningPolicy,
    extra: Partial<ModelInfo> = {},
  ): ModelInfo => ({
    id,
    providerId,
    name,
    description: null,
    contextLimit,
    outputLimit: null,
    reasoning,
    toolCall: true,
    attachment: false,
    cost: null,
    updatedAt: null,
    ...extra,
  });
  const effort = (values: string[]): ReasoningPolicy => ({
    supported: true,
    kind: 'effort',
    efforts: values,
    field: 'reasoning_content',
  });
  const toggle: ReasoningPolicy = { supported: true, kind: 'toggle', efforts: [], field: 'reasoning_content' };
  const effortOnly = (values: string[]): ReasoningPolicy => ({
    supported: true,
    kind: 'effort',
    efforts: values,
    field: null,
  });
  const noReasoning: ReasoningPolicy = { supported: false, kind: null, efforts: [], field: null };

  return {
    fetchedAt: 0,
    source: 'fallback',
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          model('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000, effortOnly(['none', 'low', 'medium', 'high', 'xhigh', 'max'])),
          model('openai', 'gpt-5.6', 'GPT-5.6', 1_050_000, effortOnly(['none', 'low', 'medium', 'high', 'xhigh', 'max'])),
          model('openai', 'gpt-5.1', 'GPT-5.1', 400_000, effortOnly(['none', 'low', 'medium', 'high'])),
          model('openai', 'gpt-4.1', 'GPT-4.1', 1_047_576, noReasoning),
        ],
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          model('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 1_048_576, effort(['low', 'high', 'max'])),
          model('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', 1_048_576, effort(['low', 'high', 'max'])),
        ],
      },
      {
        id: 'moonshotai',
        name: 'Moonshot Kimi',
        models: [
          model('moonshotai', 'kimi-k3', 'Kimi K3', 1_048_576, effort(['low', 'high', 'max'])),
          model('moonshotai', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code HighSpeed', 262_144, {
            supported: true,
            kind: null,
            efforts: [],
            field: 'reasoning_content',
          }),
        ],
      },
      {
        id: 'zhipuai',
        name: '智谱 GLM',
        models: [
          model('zhipuai', 'glm-5.2', 'GLM-5.2', 1_000_000, effort(['high', 'max'])),
          model('zhipuai', 'glm-5.1', 'GLM-5.1', 200_000, toggle),
          model('zhipuai', 'glm-5', 'GLM-5', 204_800, toggle),
          model('zhipuai', 'glm-4.6', 'GLM-4.6', 204_800, toggle),
        ],
      },
    ],
  };
}

/**
 * 上下文窗口：目录优先、本地表兜底。
 *
 * 与 `getModelContextWindow` 的关系是"更准的来源优先"，不是替换——
 * 本地表仍有用的场景：Ollama 本地模型（models.dev 没有）、上游把某个模型下架了。
 */
export function contextWindowFor(catalog: ModelCatalog | null, modelId: string, localFallback: (m: string) => number): number {
  const hit = catalog ? findModel(catalog, modelId) : null;
  return hit?.contextLimit ?? localFallback(modelId);
}
