/**
 * ── 宠物造型：可自定义的那一层 ──
 *
 * 与 `geometry.ts` 的分工：
 *  · `geometry.ts` 是**表情**的唯一真相（眼睛、眉、嘴、特效），所有造型共用；
 *  · 本文件是**外观**的唯一真相（轮廓、配色、配件、名字、口头禅）。
 *
 * 为什么要分开：表情是"它现在什么心情"，外观是"它是谁"。用户改外观时不该
 * 影响表情坐标，改表情时也不该把用户的配色覆盖掉。两条数据线各自归一化、各自落盘。
 *
 * 这里不 import 任何组件、不碰 storage：纯数据 + 纯函数，Node 测试可以直接跑。
 */

export const PET_SPECIES = ['ink', 'cat', 'ghost', 'bean'] as const;
export type PetSpecies = (typeof PET_SPECIES)[number];

export const PET_ACCESSORIES = ['none', 'glasses', 'bowtie', 'scarf', 'headphones', 'crown'] as const;
export type PetAccessory = (typeof PET_ACCESSORIES)[number];

export interface PetDesign {
  /** 用户给它起的名字（气泡/读屏里会用到） */
  name: string;
  /** 被撸一把时说的那句话；空 = 用内置台词 */
  catchphrase: string;
  species: PetSpecies;
  /** 配色 id（见 PET_PALETTES） */
  palette: string;
  accessory: PetAccessory;
}

export const PET_DEFAULT_DESIGN: PetDesign = {
  name: '墨点',
  catchphrase: '',
  species: 'ink',
  palette: 'ink',
  accessory: 'none',
};

/** 名字/口头禅长度上限：气泡最宽 190px，再长会折成三行挡住内容 */
export const PET_NAME_MAX = 10;
export const PET_CATCHPHRASE_MAX = 24;

export interface PetPalette {
  id: string;
  label: string;
  /** 身体渐变的两端 */
  top: string;
  bottom: string;
  /** 腮红；不填走主题默认 */
  blush?: string;
  /** 眼睛颜色：浅色身体上要用深色眼白，否则"黑体白眼球"的对比会反过来糊掉 */
  eye?: string;
  pupil?: string;
}

/**
 * 配色板。
 *
 * 所有配色都保持"深身体 + 浅眼睛"的对比关系（或反过来），
 * 因为表情的读法依赖这个对比：白眼在深色身体上永远读得清。
 */
export const PET_PALETTES: PetPalette[] = [
  { id: 'ink', label: '墨黑', top: '#15181f', bottom: '#2b3242' },
  { id: 'indigo', label: '靛蓝', top: '#232a5c', bottom: '#4c56b8' },
  { id: 'teal', label: '青瓷', top: '#123f43', bottom: '#2c7d78' },
  { id: 'rose', label: '胭脂', top: '#5c2233', bottom: '#a8445c' },
  { id: 'amber', label: '琥珀', top: '#4a3115', bottom: '#a3702a' },
  { id: 'forest', label: '松绿', top: '#1c3a2a', bottom: '#3f7a53' },
  { id: 'plum', label: '梅紫', top: '#3b2149', bottom: '#7a4a96' },
  { id: 'paper', label: '宣纸', top: '#e8e6df', bottom: '#bdb9ac', eye: '#1b1d22', pupil: '#f7f8fa', blush: 'rgb(214 122 122 / 0.45)' },
];

export function paletteById(id: string): PetPalette {
  return PET_PALETTES.find((p) => p.id === id) ?? PET_PALETTES[0]!;
}

/**
 * 四种轮廓。全部画在 100×100 视口里，眼睛坐标固定在 (36,46)/(64,46)，
 * 所以任何轮廓都必须给眼睛留出同样宽的脸——轮廓只改"外沿"，不改五官位置。
 */
export const PET_BODY_PATHS: Record<PetSpecies, string> = {
  /** 原始造型：四角曲率不对称的圆角方块 */
  ink: 'M 50 14 C 70 14 82 21 85 34 C 87 45 87 57 84 68 C 80 80 69 87 50 87 C 31 87 20 80 16 68 C 13 57 13 45 15 34 C 18 21 30 14 50 14 Z',
  /** 猫：顶部两只尖耳，脸颊略收 */
  cat: 'M 50 21 C 60 21 68 24 72 28 L 76 9 C 77 6.4 79.6 5.8 81 8 L 86 30 C 88 40 88 58 84 69 C 80 81 68 88 50 88 C 32 88 20 81 16 69 C 12 58 12 40 14 30 L 19 8 C 20.4 5.8 23 6.4 24 9 L 28 28 C 32 24 40 21 50 21 Z',
  /** 幽灵：圆顶 + 波浪下摆 */
  ghost: 'M 50 12 C 70 12 84 27 84 47 L 84 77 C 84 83.5 80 86.5 76 83.5 C 72 80.5 68 80.5 64 83.5 C 60 86.5 56 86.5 52 83.5 C 48 80.5 44 80.5 40 83.5 C 36 86.5 32 86.5 28 83.5 C 24 80.5 20 80.5 16 83.5 C 12 86.5 12 83 12 77 L 12 47 C 12 27 30 12 50 12 Z',
  /** 豆子：上下略收的蛋形，最圆、最"软" */
  bean: 'M 50 13 C 72 13 87 32 87 52 C 87 73 71 88 50 88 C 29 88 13 73 13 52 C 13 32 28 13 50 13 Z',
};

/**
 * 配件几何：全部画在身体之上，坐标与轮廓对齐。
 * `stroke` 类的用描边，`fill` 类的用填充——两套颜色都由 CSS 变量给，
 * 这样浅色/深色主题与配色板能同时生效。
 */
export const PET_ACCESSORY_PATHS: Record<Exclude<PetAccessory, 'none'>, string[]> = {
  /** 圆框眼镜：两圈 + 中间鼻梁 */
  glasses: [
    'M 25 45 A 10 10 0 1 0 45 45 A 10 10 0 1 0 25 45 Z',
    'M 55 45 A 10 10 0 1 0 75 45 A 10 10 0 1 0 55 45 Z',
    'M 45 45 H 55',
  ],
  /** 领结：两个三角 + 中间结 */
  bowtie: [
    'M 50 73 L 36 66 L 36 80 Z',
    'M 50 73 L 64 66 L 64 80 Z',
    'M 46 70 H 54 V 76 H 46 Z',
  ],
  /** 围巾：一条绕过下巴的带子 + 垂下的一角 */
  scarf: [
    'M 22 62 C 30 72 70 72 78 62 L 78 68 C 70 78 30 78 22 68 Z',
    'M 70 70 L 78 84 L 70 86 L 64 72 Z',
  ],
  /** 耳机：头梁 + 两侧耳罩 */
  headphones: [
    'M 20 46 C 20 24 80 24 80 46',
    'M 14 52 A 6 9 0 1 0 26 52 A 6 9 0 1 0 14 52 Z',
    'M 74 52 A 6 9 0 1 0 86 52 A 6 9 0 1 0 74 52 Z',
  ],
  /** 小皇冠：三个尖 + 底边 */
  crown: [
    'M 30 16 L 34 6 L 41 13 L 50 4 L 59 13 L 66 6 L 70 16 Z',
    'M 30 16 H 70 V 21 H 30 Z',
  ],
};

/** 配件里用填充还是描边（眼镜/耳机是描边，其余是填充） */
export const PET_ACCESSORY_STYLE: Record<Exclude<PetAccessory, 'none'>, 'stroke' | 'fill'> = {
  glasses: 'stroke',
  bowtie: 'fill',
  scarf: 'fill',
  headphones: 'stroke',
  crown: 'fill',
};

/** 把任意输入洗成合法设计：坏字段回默认，不抛错（storage 里可能有旧版本数据） */
export function normalizePetDesign(raw: unknown): PetDesign {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const species = PET_SPECIES.includes(src.species as PetSpecies)
    ? (src.species as PetSpecies)
    : PET_DEFAULT_DESIGN.species;
  const accessory = PET_ACCESSORIES.includes(src.accessory as PetAccessory)
    ? (src.accessory as PetAccessory)
    : PET_DEFAULT_DESIGN.accessory;
  const palette = typeof src.palette === 'string' && PET_PALETTES.some((p) => p.id === src.palette)
    ? src.palette
    : PET_DEFAULT_DESIGN.palette;
  return {
    name: cleanPetText(src.name, PET_NAME_MAX) || PET_DEFAULT_DESIGN.name,
    catchphrase: cleanPetText(src.catchphrase, PET_CATCHPHRASE_MAX),
    species,
    palette,
    accessory,
  };
}

/**
 * 名字与口头禅共用一套清洗：去控制符、压空白、截断。
 * 不删标点——「小墨！」是用户的选择，不是脏数据。
 */
export function cleanPetText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function isDefaultDesign(d: PetDesign): boolean {
  return (
    d.name === PET_DEFAULT_DESIGN.name &&
    d.catchphrase === PET_DEFAULT_DESIGN.catchphrase &&
    d.species === PET_DEFAULT_DESIGN.species &&
    d.palette === PET_DEFAULT_DESIGN.palette &&
    d.accessory === PET_DEFAULT_DESIGN.accessory
  );
}

export const PET_SPECIES_LABELS: Record<PetSpecies, string> = {
  ink: '墨块',
  cat: '猫耳',
  ghost: '幽灵',
  bean: '豆子',
};

export const PET_ACCESSORY_LABELS: Record<PetAccessory, string> = {
  none: '不戴',
  glasses: '眼镜',
  bowtie: '领结',
  scarf: '围巾',
  headphones: '耳机',
  crown: '皇冠',
};
