/** ── Agent 系统提示词与工具定义 ── */

/** Agent 系统提示词（中文，明确能力边界与行为准则） */
export const SYSTEM_PROMPT = `你是 MarkAI，运行在用户浏览器里的智能书签管家 Agent。你可以自由对话，并通过工具对用户的浏览器书签进行管理。

【能力边界】
- 你可以立即执行：创建文件夹与书签、移动、重命名、修改 URL、搜索书签、检测链接是否存活、统计书签状况、记录与查询长期记忆。
- 删除书签：默认模式下你只能调用 propose_deletions 提交"删除提议"，用户会在界面中确认后才真正删除。永远不要声称"已删除"，应表述为"已提交删除提议，等待用户在界面确认"。
- 如果用户开启了"无需确认"模式（在设置页配置），propose_deletions 与 delete_all_bookmarks 会自动执行删除——此时才可以如实报告"已删除"。
- 用户明确要求清空书签时使用 delete_all_bookmarks（会清空书签栏/其他书签/移动设备，根文件夹保留），默认仍需用户确认。

【长期记忆机制】
- 你拥有跨会话的长期记忆能力。已记录的用户偏好、整理习惯和保留规则会注入在上下文的【长期记忆】区域。
- 当用户表达个人偏好、规则要求，或使用「记住...」、「以后...」、「我喜欢...」、「不要动...」等表达时，应主动调用 remember 工具将其记录到长期记忆库。
- 当用户要求「忘记...」或废止某条规则时，调用 forget_memory 工具删除对应的记忆。
- 执行书签整理、重命名、去重、归类或清理时，必须主动结合已注入的长期记忆偏好与规则执行，不需要每次都重复询问用户已记录的习惯。

【行为准则】
1. 默认使用中文回复（除非用户使用其他语言），内容简洁、条理清晰，必要时使用短列表。
2. 动手之前先了解结构：优先用 list_bookmarks / search_bookmarks / get_folder_path 查询，不要凭空假设书签 ID；多个互不依赖的只读查询放在同一轮并发发出，不要一轮只查一个。
   书签库有多个根（书签栏 / 其他书签 / 移动设备），**书签栏 ≠ 全库**。用户说“整理收藏夹 / 整理书签”但没指明文件夹时，先调用 stats 看各根的书签分布，再问清或明确选择范围；不要默认只查书签栏。
3. 用户指令模糊时（例如"帮我整理一下"没指明范围），先结合长期记忆判断；如果上下文提供了用户正在查看的文件夹，就优先处理它。范围仍然不清时，**先看清各根/文件夹结构，能安全形成计划就直接调用 organize_folder（默认暂存）生成可确认批次**，不要只输出一段分析再问“需要我执行吗”；只有跨根搬迁、删除、或范围本身有歧义时才先问一句。
4. **整理默认先进暂存区，用 organize_folder 一次完成**：先用 list_bookmarks 取目标文件夹直接子书签的 id，把分类计划作为 plan 一次提交；工具会建/复用分类并批量移动，不要逐个 create_folder + move_bookmarks。
   默认暂存开启时它会自动开批次，完成后说"已放进自动整理暂存区，等待确认"；落位由用户在「整理记录」里点——**不要自己搬运，也不要声称已经改进用户的文件夹**。
   目标文件夹只有子文件夹、书签都在下一层时，先 get_folder_content 看结构；用户明确要整理这一整类时，可显式用 scope:"deep"（只接受该子树内书签，默认仍不递归）。
   如果用户明确说"直接整理进去/不用确认"，才传 staging:false 让工具直接落位；暂存已在设置里关闭时，工具会直接落位，不要调用 stage_organize。
5. **直接落位时，整理某个文件夹的新子分类必须建在它内部**（organize_folder 已保证；手工分步时 create_folder 要显式传 parentId，或 parentPath 写成该文件夹的完整路径）。
   省略 parentId 会落到**书签栏根目录**，那不是整理——那是把一个整齐的文件夹摊到根上。
   开始整理前先确认目标文件夹的 id（消息开头的「当前上下文」会给出，没有就用 get_folder_path / list_bookmarks 查）。
   organize_folder 只移动目标文件夹的**直接**子书签；如果根层全是分类文件夹、书签都在下一层，不要为了“有事可做”硬造同名分类——先用 list_all_folders 看递归书签数，再问用户是否深入某个分类。
   归类时先搜索是否已存在合适的目标文件夹，避免创建重复的同义文件夹；文件夹命名要简短、语义清晰。
   **不要按域名新建文件夹**（例如「自动整理/github.com」这种）——用户明确表示不用这种分类法：
   那种文件夹是程序按域名硬造的，用户从来没建过，书签搬进去就再也认不出原来的收藏夹。
   优先放进用户**已有**的分类；实在认不出就留在原地并说明原因，不要为了"有事可做"而造新文件夹。
   **其他书签 / 移动设备的根级书签是合法存放位置，不叫“游离书签”**；除非用户明确要求合并根，不要擅自把它们搬进书签栏（或反向搬）。
5. 每次操作后如实汇报结果；失败时说明具体原因，不要假装成功。
6. 分析任务（扫描、清理建议）要给出明确结论和依据，例如"链接返回 404（死链）"、"超过 2 年未访问"、"页面是短期促销活动"。
7. 涉及删除建议时，每条都必须给出具体、可信的理由；批量删除前提醒用户确认。
8. 不要编造工具返回中不存在的书签 ID 或数据。
9. 如果用户问与书签无关的问题，可以简短回答，并自然地引导回书签管理。
10. 工具结果可能被截断（list_bookmarks 默认 2000 项；search_bookmarks 默认 50 条，需要更多用 offset）。大量书签优先用专用工具：auto_categorize（仅在用户明确要求按域名/按网站分类时）、check_urls_bulk（批量存活检测）、cleanup_sweep（筛选+检测+删除提议）；完整清单用 export_bookmarks 的 offset/maxItems 分页。不要逐条移动书签。
11. **你产不出文件，也不要声称产出了。**工具只把数据读给你分析，不会在用户磁盘上生成文件。用户要求导出/备份时，如实说明只能读分析，让他们去 **设置 → 数据管理 → 书签导出**（书签 HTML 与 JSON）。不要编造文件名或声称"已为你导出"。
11.5 清理/筛选直接调用 cleanup_sweep 一次完成，不要反复分页拉清单。分析完立即用 propose_deletions / cleanup_sweep 提交删除提议，由用户确认；不要先停下来问"是否删除"再让用户点一次"开始删除"。`;

/**
 * 本轮的整理落位策略。
 *
 * 为什么不能只靠入口指令：用户完全可以自己在聊天框里说"帮我整理软件工具"，
 * 不经过 chip / 右键 / 斜杠命令。静态系统提示如果没有这一段，关掉暂存后
 * 模型仍会按默认去调 stage_organize——设置看起来生效了，实际没生效。
 */
export function organizeStagingInstruction(staging: boolean): string {
  if (staging) {
    return `

【整理落位策略】本轮**启用暂存区**（用户设置 organizeStaging = 开）：
- 整理单个文件夹：list_bookmarks 取直接子书签 id → organize_folder(plan=[{folder, bookmarkIds}]) 一次完成；它会自动开批次，新分类与书签都放进去。完成后如实说"已放进自动整理暂存区，等待确认"。
- 落位由用户在「整理记录」里点（原文件夹 / 书签栏 / 其他文件夹），**不要自己搬运，也不要声称已经改进用户的文件夹**。
- 只有用户明确要求"直接整理进去/不用确认"时才传 staging:false；零散选中的书签、整库整理不要硬塞进一个批次。
`;
  }
  return `

【整理落位策略】本轮**暂存已关闭**（用户设置 organizeStaging = 关）：
- 不要调用 stage_organize；整理文件夹时用 organize_folder（默认直接落位）一次建好分类并移动到位，它会把新子分类建在该文件夹内部。
- 若手工分步，create_folder 必须传目标 folderId 作 parentId；省略会落到书签栏根目录，那不是整理。
`;
}

/** 工具参数 JSON Schema（OpenAI 兼容 tools 协议） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 开启「执行前先看计划」时追加到系统提示的指令。
 *
 * 为什么要写在这里：`submit_plan` 的工具说明只讲"这个工具是干什么的"，
 * 而"**本轮动手之前先声明**"是一个流程要求——需要在系统提示里明确，模型才会稳定照做。
 * 声明没做也不影响安全（未声明就逐个确认），只是确认次数会变多。
 */
export const PLAN_MODE_INSTRUCTION = [
  '',
  '## 本轮执行方式：先声明计划，再动手',
  '用户开启了「执行前先看计划」。本轮**第一次调用任何写类工具之前**，先用 `submit_plan` 把本轮打算做的写操作一次列全（每项写清工具名与一句人话说明）。',
  '用户确认一次即覆盖整轮；之后按计划依次执行即可，不必再重复声明。',
  '如果本轮完全不需要改动书签，就不要调用 `submit_plan`。',
  '注意：只声明你**确实打算执行**的操作；计划之外临时决定要用的写类工具仍会单独请求用户确认。',
  '',
].join('\n');

const RAW_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_bookmarks',
      description:
        '列出某个书签文件夹下的直接子项（含子文件夹与书签，带路径与时间信息）；列到根层时会同时给出所有根的书签分布（书签栏 ≠ 全库）。不传 parentId 时默认列出"书签栏"。也支持 folderPath 按路径定位（如"书签栏 > 技术"）。大文件夹支持 offset 分页（返回 hasMore/nextOffset）。',
      parameters: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: '文件夹 id，省略则默认书签栏' },
          folderPath: { type: 'string', description: '文件夹路径（如"书签栏 > 技术"），与 parentId 二选一，优先用路径' },
          limit: { type: 'integer', description: '返回条数上限，默认 2000，最大 2000' },
          offset: { type: 'integer', description: '跳过前 N 条（分页用，取上一批返回的 nextOffset）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_bookmarks',
      description: '按关键字搜索书签（匹配标题与 URL），默认返回 50 条，支持 offset 翻页，带所在路径。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键字' },
          limit: { type: 'integer', description: '返回条数上限，默认 50，最大 2000' },
          offset: { type: 'integer', description: '跳过前 N 条（分页用，取上一批返回的 nextOffset）' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_bookmarks',
      description: '获取最近添加的书签列表（支持按天数筛选），用于快速了解用户新收藏的内容。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: '数量，默认 10，最多 20' },
          days: { type: 'integer', description: '只看最近 N 天添加的（跨全部文件夹），省略则取最近添加的' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_folder_path',
      description: '解析某个书签/文件夹在书签树中的完整路径，例如"书签栏 > 技术 > AI"。',
      parameters: {
        type: 'object',
        properties: { bookmarkId: { type: 'string', description: '书签或文件夹 id' } },
        required: ['bookmarkId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_folder',
      description: '创建书签文件夹。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文件夹名称' },
          parentId: { type: 'string', description: '父文件夹 id。整理某个文件夹时必须传该文件夹的 id；省略会建在当前上下文文件夹（没有上下文则建在书签栏）' },
          parentPath: { type: 'string', description: '父文件夹完整路径（如"书签栏 > 软件工具"），与 parentId 二选一' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_bookmarks',
      description:
        '批量创建书签（一次最多 50 条）。支持 parentId 或 parentPath（如"书签栏 > 技术"）定位目标文件夹；逐条返回成功/失败明细。适合从清单批量收藏（如把一批主页面建到新分类）。',
      parameters: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: '目标文件夹 id（与 parentPath 二选一，省略则书签栏）' },
          parentPath: { type: 'string', description: '目标文件夹路径（如"书签栏 > 技术"）' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '书签标题' },
                url: { type: 'string', description: '书签地址' },
              },
              required: ['title', 'url'],
              additionalProperties: false,
            },
            description: '要创建的书签列表（1-50 条）',
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_bookmark',
      description: '创建书签。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '书签标题' },
          url: { type: 'string', description: '完整 URL' },
          parentId: { type: 'string', description: '父文件夹 id。整理某个文件夹时必须传该文件夹的 id；省略会建在当前上下文文件夹（没有上下文则建在书签栏）' },
          parentPath: { type: 'string', description: '父文件夹完整路径（如"书签栏 > 软件工具"），与 parentId 二选一' },
        },
        required: ['title', 'url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_bookmark',
      description: '把书签或文件夹移动到目标文件夹（可指定插入位置）。执行前会自动校验目标存在且不会造成循环嵌套。',
      parameters: {
        type: 'object',
        properties: {
          bookmarkId: { type: 'string', description: '要移动的书签/文件夹 id' },
          parentId: { type: 'string', description: '目标文件夹 id' },
          index: { type: 'integer', description: '可选，目标位置序号（0 起）' },
        },
        required: ['bookmarkId', 'parentId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_bookmark',
      description: '重命名书签或文件夹。',
      parameters: {
        type: 'object',
        properties: {
          bookmarkId: { type: 'string', description: '书签/文件夹 id' },
          title: { type: 'string', description: '新名称' },
        },
        required: ['bookmarkId', 'title'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_bookmark_url',
      description: '修改书签的 URL（仅书签，文件夹不可用）。',
      parameters: {
        type: 'object',
        properties: {
          bookmarkId: { type: 'string', description: '书签 id' },
          url: { type: 'string', description: '新的完整 URL' },
        },
        required: ['bookmarkId', 'url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'classify_urls',
      description:
        '批量分类 URL 类型（不联网，启发式）：root=主页面（域名根/index）、page=浅层栏目页（/about 等单段无扩展名）、sub=子页面、deep=深层子页面（文章/文档页）。**「只保留主页面」类清理任务请直接使用 cleanup_sweep（内部已包含本分类 + 存活检测 + 批量提议），无需手动走此工具。**',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: '要分类的 URL 列表（最多 500 个）',
          },
        },
        required: ['urls'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_urls_bulk',
      description:
        '【大库专用】一次批量检测成千上万条 URL 是否存活（check_urls 的超集：内部并发 20 路 + 单条 8 秒超时，带实时进度）。只回传摘要统计 + 死链明细（默认最多 200 条，可传 maxDeadList 调整，0=只回统计）。适合全量死链扫描：把 export_bookmarks 取回的整份清单直接传入即可，无需分批多次调用。',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: '要检测的 URL 列表（去重后最多 20000 条）',
          },
          maxConcurrent: { type: 'integer', description: '并发数，默认 20，最大 50' },
          timeoutMs: { type: 'integer', description: '单条超时毫秒，默认 8000，范围 2000~30000' },
          maxDeadList: { type: 'integer', description: '死链明细条数上限，默认 200；0 = 只返回统计' },
        },
        required: ['urls'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stage_organize',
      description:
        '开一个「整理暂存批次」。用户在设置里默认要求"先看再落位"：' +
        '调用它拿到 batchId 后，把新分类建在 batchId 下、把书签移进 batchId —— ' +
        '用户会在「整理记录」里看到这批改动，并自行决定"应用到原文件夹 / 放到书签栏 / 选择其他文件夹 / 放弃"。' +
        '整理类任务应当先调它；整理完成后如实说"已放进自动整理暂存区，等待确认"，不要声称已改进用户的文件夹。',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '要整理的文件夹 id；省略则用本轮当前上下文文件夹' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'organize_folder',
      description:
        '一次完成一个文件夹的整理：按 plan 在目标文件夹内（暂存开启时在暂存批次内）创建/复用分类文件夹，并批量移动书签。' +
        '默认只整理直接子书签；目标文件夹里书签都在子文件夹时，显式传 scope="deep" 递归整理（只允许该子树内的书签）。' +
        '模型只需先 list_bookmarks / get_folder_content 取得书签 id，然后调用本工具，不要为每个分类分别 create_folder + move_bookmarks。' +
        '默认开启暂存时，本工具会自动开批次；dryRun=true 只返回将要创建/移动的数量，不改动书签。',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '要整理的文件夹 id（与 folderPath 二选一；省略则用当前上下文文件夹）' },
          folderPath: { type: 'string', description: '要整理的文件夹完整路径' },
          scope: {
            type: 'string',
            enum: ['direct', 'deep'],
            description: '整理范围：direct（默认，只收直接子书签）或 deep（递归目标文件夹子树，书签在子文件夹里时用）',
          },
          plan: {
            type: 'array',
            description: '分类计划：每个分类一个 folder + 要移入的 bookmarkIds；direct 模式必须直接子书签，deep 模式可用子树内任意书签；同一条不能重复',
            items: {
              type: 'object',
              properties: {
                folder: { type: 'string', description: '分类文件夹标题；已存在同名子文件夹时复用' },
                bookmarkIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '要移入该分类的书签 id 列表',
                },
              },
              required: ['folder', 'bookmarkIds'],
              additionalProperties: false,
            },
          },
          dryRun: { type: 'boolean', description: '只预览，不创建/移动' },
          staging: { type: 'boolean', description: '是否先进暂存区；省略按设置，false=用户明确要求直接落位' },
        },
        required: ['plan'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_categorize',
      description:
        '先用 dryRun=true 出计划（不创建文件夹、不移动书签），用户确认后再执行。' +
        
        '【大库专用】对某个文件夹执行自动分类：工具内部按注册域名聚类 → 批量创建分类文件夹 → 批量移动书签，一次调用完成全量整理，结果与书签数量无关（适合几百上千条的大文件夹）。已有子文件夹不受影响，数量不足 minGroupSize 的书签留在原地。' +
        '**注意：本工具会按域名新建文件夹，与「不要自发按域名建文件夹」的规则冲突——只有用户明确要求「按域名/按网站分类」时才可调用；用户只是说「整理一下」时不要用它，改用你已有的分类。**',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '目标文件夹 id（与 folderPath 二选一）' },
          folderPath: { type: 'string', description: '目标文件夹路径（如"书签栏 > 技术"）' },
          minGroupSize: { type: 'integer', description: '组内至少多少条才建文件夹，默认 2' },
          maxGroups: { type: 'integer', description: '最多创建多少个分类文件夹，默认 25' },
          foldOverflow: { type: 'boolean', description: '超出 maxGroups 的组是否并入「其他」文件夹，默认 false（留在原地）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cleanup_sweep',
      description:
        '先用 dryRun=true 出计划（不改动任何书签、不生成提议），用户确认后再用 dryRun=false 执行。' +
        
        '【一键清理】扫描→分类→实测存活→删除，一次调用完成整文件夹清理。按收藏年份（beforeYear）与页面类型（keepOnly）筛选，对保留候选实测可访问性。确认模式下其余全部生成删除提议（理由含具体类型/HTTP 状态）；「无需确认」模式下直接删除（生成"已删除"卡片）。适合「只保留 2026 年前主页面且可访问」这类任务——不要自己分页拉清单，直接调用本工具，一次处理最多 1000 条，超出用返回的 remaining/offset 继续。',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '目标文件夹 id（与 folderPath 二选一，省略则书签栏）' },
          folderPath: { type: 'string', description: '目标文件夹路径（如"书签栏"）' },
          beforeYear: { type: 'integer', description: '只处理该年份 1 月 1 日前添加的书签（如 2026 = 2026 年前），省略则全部' },
          keepOnly: { type: 'string', enum: ['root', 'page'], description: '保留类型：root=仅主页面（默认），page=主页面+栏目页' },
          checkReachable: { type: 'boolean', description: '是否实测保留候选的存活（默认 true）' },
          recursive: { type: 'boolean', description: '是否递归子文件夹（默认 true，只删书签不删文件夹）' },
          dryRun: { type: 'boolean', description: '只预览，不生成删除提议；确认后再用 dryRun=false 执行' },
          limit: { type: 'integer', description: '本次处理条数上限，默认 1000，最大 1000' },
          offset: { type: 'integer', description: '跳过前 N 条（分页：上一轮返回 remaining>0 时用返回的 offset 继续）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_urls',
      description:
        '并发检测一批 URL 是否存活（HEAD 请求，8 秒超时）。用于识别死链、失效文档、被墙页面。一次最多 50 个；**检测大清单（几十条以上）用 check_urls_bulk，不要循环分批调用本工具**。',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: '要检测的 URL 列表' },
        },
        required: ['urls'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stats',
      description: '统计书签整体状况：总数、文件夹数、空文件夹数、超过 2 年未访问的书签数、各根目录分布。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_all_folders',
      description:
        '列出全部书签文件夹（id + 完整路径 + 子项数），一次调用完成。需要判断"是否已有合适文件夹"或规划归类时优先使用，避免逐层递归查询。文件夹很多时按返回的 offset 分页取全（默认每批 200 个）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回条数上限，默认 200，最大 500' },
          offset: { type: 'integer', description: '跳过前 N 个（分页用）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_bookmarks',
      description: '批量移动多个书签/文件夹到目标文件夹（一次调用替代多轮移动，效率更高）。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '要移动的书签/文件夹 id 列表（最多 50 个）' },
          parentId: { type: 'string', description: '目标文件夹 id' },
          index: { type: 'integer', description: '目标位置（可选）' },
        },
        required: ['ids', 'parentId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_bookmark',
      description: '复制书签或文件夹（文件夹深拷贝全部子项）到目标文件夹。',
      parameters: {
        type: 'object',
        properties: {
          bookmarkId: { type: 'string', description: '要复制的书签/文件夹 id' },
          parentId: { type: 'string', description: '目标文件夹 id' },
          title: { type: 'string', description: '可选的副本新标题（仅书签）' },
        },
        required: ['bookmarkId', 'parentId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_plan',
      description:
        '声明本轮打算执行的写操作（仅登记，不执行、不改动任何书签）。当用户开启了「执行前先看计划」时，先用它把整轮要做的事一次说清，用户确认一次即可覆盖整轮；未在计划里的写操作仍会单独请求确认。不做任何写操作时不要调用它。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '本轮打算执行的写操作，按执行先后排列',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: '写类工具名，如 move_bookmarks / create_folder / rename_bookmark' },
                summary: { type: 'string', description: '给人看的一句话说明' },
                count: { type: 'integer', description: '影响条数（可选）' },
              },
              required: ['tool'],
              additionalProperties: false,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_bookmark',
      description: '在浏览器新标签页中打开书签（background=true 时后台打开）。',
      parameters: {
        type: 'object',
        properties: {
          bookmarkId: { type: 'string', description: '书签 id' },
          background: { type: 'boolean', description: '是否后台打开，默认 false（前台）' },
        },
        required: ['bookmarkId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_bookmarks',
      description: '批量打开多个书签（自动去重，最多 20 个，background=true 时全部后台打开）。适合"打开这个清单里的一批书签"。',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '书签 id 列表（1-20 个）',
          },
          background: { type: 'boolean', description: '是否后台打开，默认 false' },
        },
        required: ['ids'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_empty_folders',
      description:
        '列出所有空文件夹（无任何子项的文件夹，含完整路径与总数）。清理书签时先用它找出可删除的空文件夹，再用 propose_deletions 提议删除。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_folder_content',
      description:
        '查看某个文件夹的完整结构（含子文件夹与书签，可控制递归深度）。支持 folderId 或 folderPath（如"书签栏 > 技术"）。整理前先用它摸清结构。',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: '文件夹 id，与 folderPath 二选一' },
          folderPath: { type: 'string', description: '文件夹路径（如"书签栏 > 技术"）' },
          depth: { type: 'integer', description: '递归深度：1=只看直接子项（默认），2=含孙级，3=最多三层' },
          limit: { type: 'integer', description: '每层书签上限，默认 100，最大 2000' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_bookmarks',
      description:
        '导出书签清单（扁平化，每行一个书签含完整 url 与收藏日期 YYYY-MM-DD；scope=all 导出全部，scope=folder 导出指定文件夹）。大清单支持 offset/maxItems 分页：默认每批 500 条，返回里有 total/nextOffset/hasMore，还有剩余时按 nextOffset 继续取下一批，逐批累计结论。includeId=true 时每行附书签 id（后续需要 propose_deletions / move 等按 id 操作时务必开启，避免二次拉取）。适合需要完整 url 的分析任务（判断主页面/子页面/死链/按收藏年份筛选）。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['all', 'folder'], description: '导出范围，默认 all' },
          folderId: { type: 'string', description: 'scope=folder 时的文件夹 id（与 folderPath 二选一）' },
          folderPath: { type: 'string', description: 'scope=folder 时的文件夹路径（如"书签栏 > 技术"）' },
          format: { type: 'string', enum: ['markdown', 'json'], description: '输出格式，默认 markdown' },
          maxItems: { type: 'integer', description: '本批条数，默认 500，最大 5000' },
          offset: { type: 'integer', description: '跳过前 N 条（分页用，取上一批返回的 nextOffset）' },
          includeId: { type: 'boolean', description: '是否每行附带书签 id（后续按 id 操作时开启，默认 false）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_folders',
      description:
        '合并文件夹：把 sourceId 文件夹的全部内容移入 targetId（保持相对顺序）。源文件夹清空后会自动提议删除空文件夹（仍需用户确认，遵守删除安全机制）。',
      parameters: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: '源文件夹 id（内容将被移走）' },
          targetId: { type: 'string', description: '目标文件夹 id（内容移入这里）' },
        },
        required: ['sourceId', 'targetId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_duplicates',
      description:
        '查找重复书签（URL 归一化后相同的归为一组，重复最多的在前）。用于清理重复收藏，清理时用 propose_deletions 提交删除提议。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回多少组重复，默认 50，最大 500' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dedupe_bookmarks',
      description:
        '一键去重：按归一化 URL（忽略片段/查询参数/www/尾斜杠，http 与 https 视为不同）找出重复书签，每组保留 1 条、删除其余。' +
        '保留规则确定且可解释：自定义标题优先 → 最近使用 → 最早收藏 → 按 id 稳定排序。' +
        '先用 dryRun=true 出计划（不改动任何书签），用户确认后再用 dryRun=false 执行；' +
        '「无需确认」模式下直接删除（可一键撤销），否则提交删除提议等待用户确认。',
      parameters: {
        type: 'object',
        properties: {
          folderIds: { type: 'array', items: { type: 'string' }, description: '只在这些文件夹里查重（不传 = 全库）' },
          limit: { type: 'integer', description: '最多处理多少组，默认 100，最大 500' },
          dryRun: { type: 'boolean', description: 'true = 只出计划、不改动书签（建议先预览）' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sort_folder',
      description:
        '对指定文件夹内的子项排序（文件夹置顶），写入真实顺序。by 支持 title（名称，自然数字排序）、url（地址）、dateAdded（添加时间升序）、dateLastUsed（最近使用降序）。',
      parameters: {
        type: 'object',
        properties: {
          parentId: { type: 'string', description: '要排序的文件夹 id' },
          by: { type: 'string', enum: ['title', 'url', 'dateAdded', 'dateLastUsed'], description: '排序字段，默认 title' },
        },
        required: ['parentId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_deletions',
      description:
        '【删除安全机制】提交"删除提议"。默认模式下需要用户确认后才真正执行；如果用户开启了"无需确认"模式则会自动执行。用于建议清理死链、过期促销页、失效文档、长期未访问的书签。每次调用都会生成待确认列表。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                bookmarkId: { type: 'string', description: '要删除的书签/文件夹 id' },
                reason: { type: 'string', description: '删除理由（必须具体可信）' },
              },
              required: ['bookmarkId', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_all_bookmarks',
      description:
        '【危险操作】请求删除全部书签（清空书签栏/其他书签/移动设备的所有内容，根文件夹保留）。默认模式下会生成"删除全部"提议等待用户确认；如果用户开启了"无需确认"模式则直接执行。仅在用户明确要求"清空/删除全部书签"时使用，并先告知后果。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '删除理由（可选，会展示给用户）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '记录一条用户偏好、习惯或整理规则到长期记忆库。当用户明确要求记住某些偏好（例如"记住我喜欢按语言分类"、"以后把技术博客放到阅读目录"、"清理时保留 2024 年后的内容"）或表达强烈习惯时调用。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '需要长期记住的偏好、习惯或规则内容' },
          category: {
            type: 'string',
            enum: ['preference', 'rule', 'habit', 'custom'],
            description: '记忆类型：preference=偏好，rule=硬性规则，habit=日常习惯，custom=其他自定义',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memories',
      description:
        '查询长期记忆库中的偏好与规则。支持 query 关键词搜索，省略 query 则返回全部已记录的记忆项。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，省略则返回全部记忆' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_memory',
      description:
        '从长期记忆库中删除指定的记忆项。可传入记忆 id 或根据 query 关键词匹配要遗忘的内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆项 id' },
          query: { type: 'string', description: '要遗忘或删除的记忆关键词或描述' },
        },
        additionalProperties: false,
      },
    },
  },
];

/**
 * 工具描述的「压缩视图」。
 *
 * 35 个工具的完整 schema 每轮请求约 5.7k token（占总固定开销 80%），而其中大量文字
 * 是给开发者看的背景说明、示例和重复的限制句。模型真正需要的只有：**这个工具做什么、
 * 关键参数是什么、什么时候不该用**。因此保留一份详尽的 RAW 定义作为源码事实，
 * 发给模型前再过一遍 lossy 压缩——参数名、类型、required、enum 一个不动。
 *
 * 约束：
 *  - 只删/缩短 description，不改任何 schema 结构；
 *  - 关键前置条件（parentId、暂存开关、删除确认）必须留在描述里；
 *  - 压缩后仍要能通过「提示词禁止/允许不冲突」守卫。
 */
const TOOL_SUMMARY: Record<string, string> = {
  list_bookmarks: '列出文件夹的直接子项（id/标题/URL/文件夹），支持路径与 offset 分页；省略 parentId 时用当前文件夹。',
  search_bookmarks: '按标题/URL 搜索书签；默认 50 条，支持 offset 分页。',
  get_recent_bookmarks: '最近添加的书签，可按天数筛选。',
  get_folder_path: '把书签/文件夹 id 解析成完整路径。',
  create_folder: '新建文件夹；整理某个文件夹时必须显式传 parentId。',
  create_bookmarks: '批量创建书签（≤50 条），parentId/parentPath 定位目标。',
  create_bookmark: '创建单条书签。',
  move_bookmark: '移动单条书签到指定文件夹。',
  rename_bookmark: '重命名书签或文件夹。',
  update_bookmark_url: '修改书签 URL。',
  classify_urls: '把 URL 归为主页面/栏目页/深层页，供清理判断。',
  check_urls_bulk: '批量实测 URL 存活，只回摘要与死链明细。',
  stage_organize: '开整理暂存批次（高级工具；一般直接用 organize_folder）。',
  auto_categorize: '按域名聚类整理文件夹并批量移动；仅在用户明确要求按网站/域名分类时用。',
  cleanup_sweep: '一键清理文件夹：筛选→存活检测→删除提议；仅用户明确要求清理时用。',
  check_urls: '检测少量 URL 是否存活。',
  stats: '统计书签/文件夹数量与最近变化。',
  list_all_folders: '列出所有文件夹的 id、路径与递归书签数；先看 roots 分布，判断书签实际在哪个根/分类。',
  move_bookmarks: '批量移动书签到同一文件夹，保留顺序。',
  copy_bookmark: '复制书签到另一个文件夹。',
  submit_plan: '计划模式下，动手前一次性声明本轮写操作。',
  open_bookmark: '在浏览器打开一个书签。',
  open_bookmarks: '批量打开书签（≤10 条）。',
  list_empty_folders: '列出空文件夹，供清理。',
  get_folder_content: '递归读取文件夹内容，适合看结构。',
  export_bookmarks: '分页导出书签 HTML/JSON 供分析；不会写用户磁盘。',
  merge_folders: '把源文件夹内容并入目标文件夹。',
  find_duplicates: '按 URL/标题查找重复书签，只读。',
  dedupe_bookmarks: '批量去重并保留一条，删除走确认。',
  sort_folder: '按标题/日期/URL 排序文件夹。',
  propose_deletions: '提交删除提议，等用户确认；默认不直接删。',
  delete_all_bookmarks: '清空书签（危险，需确认）。',
  remember: '记录一条长期偏好/规则。',
  recall_memories: '查询长期记忆。',
  forget_memory: '删除一条长期记忆。',
  organize_folder: '一次完成整理：按 plan 在目标文件夹（或暂存批次）内建分类并移动书签；书签都在子文件夹时显式传 scope:"deep" 递归整理。',
};

/**
 * 明显到不需要说明的参数名。模型从名字和类型就能正确填；
 * 保留它们只会让每轮 schema 多几百 token。parentId 例外——它是最容易
 * 被省略、且一省略就落到书签栏根的危险参数，必须保留一句前置条件。
 */
const BARE_PARAM_NAMES = new Set([
  'title', 'url', 'query', 'count', 'bookmarkId', 'id', 'ids', 'index',
  'days', 'name', 'value', 'folderId', 'folderPath', 'parentPath',
  'folder', 'bookmarkIds', 'reason', 'category', 'enabled', 'text', 'plan',
]);

function trimDescription(text: string, max = 78): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
  return (sentence > max * 0.45 ? cut.slice(0, sentence) : cut).trimEnd() + '…';
}

/** 只压缩 description，结构原样保留（JSON Schema 的 required/enum/type 不动） */
function compactSchema(node: unknown, key = ''): unknown {
  if (Array.isArray(node)) return node.map((item) => compactSchema(item));
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  if (typeof out.description === 'string') {
    if (key && BARE_PARAM_NAMES.has(key) && !src.type?.toString().includes('object') && !src.enum) {
      delete out.description;
    } else {
      out.description = trimDescription(out.description, key === 'parentId' ? 52 : 78);
    }
  }
  if (out.properties && typeof out.properties === 'object') {
    const props = out.properties as Record<string, unknown>;
    out.properties = Object.fromEntries(
      Object.entries(props).map(([name, schema]) => [name, compactSchema(schema, name)]),
    );
  }
  if (out.items) out.items = compactSchema(out.items, key);
  return out;
}

function compactToolDefinition(def: ToolDefinition): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: def.function.name,
      description: TOOL_SUMMARY[def.function.name] ?? trimDescription(def.function.description, 110),
      parameters: compactSchema(def.function.parameters) as Record<string, unknown>,
    },
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = RAW_TOOL_DEFINITIONS.map(compactToolDefinition);

/**
 * 实际发给模型的定义：去掉 `additionalProperties: false`。
 *
 * 这个键对 OpenAI 兼容接口不是必填，zod 也会静默剥离未知键；
 * 36 个工具每个多 7 token，合计约 290 token/轮，纯属白付。
 * 源码保留完整定义（契约测试仍能检查），发送层用这份精简副本。
 */
function stripAdditionalProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripAdditionalProperties);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // 只删这个键本身；数组 items、allOf/oneOf、properties 里的对象都要继续递归
    if (key === 'additionalProperties') continue;
    out[key] = stripAdditionalProperties(value);
  }
  return out;
}

export const API_TOOL_DEFINITIONS: ToolDefinition[] = TOOL_DEFINITIONS.map((def) => ({
  type: 'function',
  function: {
    name: def.function.name,
    description: def.function.description,
    parameters: stripAdditionalProperties(def.function.parameters) as Record<string, unknown>,
  },
}));


/**
 * 给模型的「现在几点」上下文。
 *
 * 为什么必须有：工具回填的 `dateAdded` / `dateLastUsed` 是**原始毫秒时间戳**，
 * 而系统提示词原先没有任何"今天是什么时候"的信息——模型只能拿自己的训练截止日
 * 当"现在"。于是「找出超过 2 年没访问的书签」「上周收藏的」这类**明确的时间判断会算错**，
 * 而且错得很自信。
 *
 * 这一句成本极低（几十 token），却是所有时间相关判断的前提。
 */
export function buildTimeContext(now: Date = new Date(), timeZone = resolveTimeZone()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  // 用本地时间构造"人类可读"的那一行（模型读的是本地时间，不是 UTC）
  let human = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  let isoDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  let offsetHint = '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const y = get('year');
    const mo = get('month');
    const d = get('day');
    const h = get('hour');
    const mi = get('minute');
    if (y && mo && d) {
      isoDate = `${y}-${mo}-${d}`;
      human = `${y}-${mo}-${d} ${h}:${mi}`;
    }
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const oh = pad(Math.floor(Math.abs(offsetMinutes) / 60));
    const om = pad(Math.abs(offsetMinutes) % 60);
    offsetHint = `，UTC${sign}${oh}:${om}`;
  } catch {
    // 时区不可用时退回本地时间，功能不受影响
  }
  return `\n\n## 当前时间\n现在是 ${human}（${timeZone}${offsetHint}），今天是 ${isoDate}。\n工具返回的 \`dateAdded\` / \`dateLastUsed\` 是 Unix 毫秒时间戳。判断「多久以前」「是否超过 N 年」「最近/上周」时，一律以上面这个当前时间为基准换算，不要用你的训练数据里的日期。`;
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
