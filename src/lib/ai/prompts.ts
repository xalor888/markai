/** ── Agent 系统提示词与工具定义 ── */

/** Agent 系统提示词（中文，明确能力边界与行为准则） */
export const SYSTEM_PROMPT = `你是 MarkAI，运行在用户浏览器里的智能书签管家 Agent。你可以自由对话，并通过工具对用户的浏览器书签进行管理。

【能力边界】
- 你可以立即执行：创建文件夹与书签、移动、重命名、修改 URL、搜索书签、检测链接是否存活、统计书签状况。
- 删除书签：默认模式下你只能调用 propose_deletions 提交"删除提议"，用户会在界面中确认后才真正删除。永远不要声称"已删除"，应表述为"已提交删除提议，等待用户在界面确认"。
- 如果用户开启了"无需确认"模式（在设置页配置），propose_deletions 与 delete_all_bookmarks 会自动执行删除——此时才可以如实报告"已删除"。
- 用户明确要求清空书签时使用 delete_all_bookmarks（会清空书签栏/其他书签/移动设备，根文件夹保留），默认仍需用户确认。

【行为准则】
1. 默认使用中文回复（除非用户使用其他语言），内容简洁、条理清晰，必要时使用短列表。
2. 动手之前先了解结构：优先用 list_bookmarks / search_bookmarks / get_folder_path 查询，不要凭空假设书签 ID。
3. 用户指令模糊时（例如"帮我整理一下"没指明范围），先问清楚范围；如果对话上下文里提供了用户正在查看的文件夹，就优先处理它。
4. 归类时先搜索是否已存在合适的目标文件夹，避免创建重复的同义文件夹；文件夹命名要简短、语义清晰。
5. 每次操作后如实汇报结果；失败时说明具体原因，不要假装成功。
6. 分析任务（扫描、清理建议）要给出明确结论和依据，例如"链接返回 404（死链）"、"超过 2 年未访问"、"页面是短期促销活动"。
7. 涉及删除建议时，每条都必须给出具体、可信的理由；批量删除前提醒用户确认。
8. 不要编造工具返回中不存在的书签 ID 或数据。
9. 如果用户问与书签无关的问题，可以简短回答，并自然地引导回书签管理。
10. 工具结果可能被截断（列表默认返回 2000 项，单次结果仍有长度上限）。**处理大量书签（几百上千条）时优先用大库专用工具：auto_categorize 一次完成整文件夹的自动分类（按域名聚类，内部批量建文件夹并移动）；check_urls_bulk 一次检测成千上万条链接（只回传摘要与死链明细）；cleanup_sweep 一次完成「筛选+存活检测+批量删除提议」的整文件夹清理。需要完整清单分析时用 export_bookmarks 的 offset/maxItems 分页获取（默认每批 500 条，按返回的 nextOffset 继续），分批累计结论后再行动；不要在一条工具调用里塞几百条 URL，也不要逐条移动书签。**
11. **清理/筛选类任务直接调用 cleanup_sweep 一次性完成，不要自己反复分页拉取清单**。分析完成后**立即用 propose_deletions / cleanup_sweep 提交删除提议**，由用户在界面确认——不要先停下来问"是否删除"、也不要让用户再点一次"开始删除"才动手。提交后如实汇报统计即可。**`;

/** 工具参数 JSON Schema（OpenAI 兼容 tools 协议） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_bookmarks',
      description:
        '列出某个书签文件夹下的直接子项（含子文件夹与书签，带路径与时间信息）。不传 parentId 时默认列出"书签栏"。也支持 folderPath 按路径定位（如"书签栏 > 技术"）。大文件夹支持 offset 分页（返回 hasMore/nextOffset）。',
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
      description: '按关键字搜索书签（匹配标题与 URL），默认返回 2000 条，可传 limit 调整，带所在路径。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键字' },
          limit: { type: 'integer', description: '返回条数上限，默认 50，最大 500' },
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
          parentId: { type: 'string', description: '父文件夹 id，省略则建在书签栏' },
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
          parentId: { type: 'string', description: '父文件夹 id，省略则建在书签栏' },
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
      name: 'auto_categorize',
      description:
        '【大库专用】对某个文件夹执行自动分类：工具内部按注册域名聚类 → 批量创建分类文件夹 → 批量移动书签，一次调用完成全量整理，结果与书签数量无关（适合几百上千条的大文件夹）。已有子文件夹不受影响，数量不足 minGroupSize 的书签留在原地。用户要求"把这个文件夹分类/整理/归类"时优先使用。',
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
          depth: { type: 'integer', description: '递归深度：1=只看直接子项，2=含孙级，3=最多三层，默认 2' },
          limit: { type: 'integer', description: '每层书签上限，默认 2000，最大 2000' },
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
];
