/**
 * 需求域工程提示词构造器（CORP-DSH-TOOLS-002 §5）。
 *
 * 覆盖一期 4 类需求/故事提示词：
 *   req.create.one_sentence / req.clarify.from_doc / req.card.clarify_and_split / story.card.design_and_prep
 */
import { Buffer } from 'node:buffer';
import { ERROR_CODES, WorkbenchError } from '../../shared/errors.mjs';
import {
  ASK_USER_QUESTION_GUIDE,
  formatPerson,
  MAX_DOC_INJECT_BYTES,
  MAX_ONE_SENTENCE_CHARS,
  stripHtmlToText,
  truncateUtf8Bytes,
} from '../../shared/prompt-utils.mjs';

export const REQUIREMENT_PROMPT_ACTION_KEYS = Object.freeze([
  'req.create.one_sentence',
  'req.clarify.from_doc',
  'req.card.clarify_and_split',
  'story.card.design_and_prep',
]);

function buildOneSentencePrompt(input) {
  const idea = String(input.idea ?? '').trim();
  if (idea === '') {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '请输入一句话业务想法');
  }
  if (idea.length > MAX_ONE_SENTENCE_CHARS) {
    throw new WorkbenchError(
      ERROR_CODES.BAD_REQUEST,
      `初步想法不能超过 ${MAX_ONE_SENTENCE_CHARS} 个字符`,
    );
  }
  const ownerName = String(input.ownerName ?? '').trim() || '当前用户';

  const prompt = [
    '[来源：DOP 工作台 · 一句话新建需求]',
    `发起人（只读归属）：${ownerName}`,
    '',
    '请引导我完成多轮业务需求澄清，并按企业标准需求规格模板整理结构化草案：',
    '1. 先聚焦核心业务目标、受众角色、涉及渠道与前后端系统边界（必要时可先用 forge_workbench_rmp_doc_search / forge_workbench_todo_summary 检索相近历史需求）；',
    '2. 业务规则、阈值、安全合规或异常处理口径缺失时，调用 ask_user_question 提供候选选项让我直接在对话框点选对齐；',
    '3. 待关键口径对齐后，输出包含背景、功能清单、异常兜底与合规检查点的需求文档草稿。',
    '',
    ASK_USER_QUESTION_GUIDE,
    '',
    `我的初步想法：${idea}`,
    '',
    '约束：未经我明确确认不得调用写接口向需求平台或 DOP 平台创建/覆盖单据。',
  ].join('\n');

  return {
    ok: true,
    prompt,
    meta: {
      promptKind: 'req.create.one_sentence',
      title: '一句话新建需求澄清',
      sourceSummary: '工作台快捷入口 · 一句话新建需求',
      docCount: 0,
      byteLength: Buffer.byteLength(prompt, 'utf8'),
      charLength: prompt.length,
      truncated: false,
      emptySections: [],
      warnings: [],
      deliveryNote: '请核对提示词内容后手动填入对话草稿箱或复制，系统不会自动发送。',
    },
  };
}

function buildFromDocPrompt(input) {
  const origin = input.source === 'local' ? 'local' : 'rmp';
  const docName = String(input.docName ?? input.fileName ?? '').trim();
  const docVer = String(input.docVer ?? '').trim();
  if (docName === '') {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少待澄清文档名称');
  }

  const sections = Array.isArray(input.sections) ? input.sections : [];
  const emptySections = [];
  const warnings = Array.isArray(input.warnings) ? [...input.warnings] : [];
  const blocks = [];

  if (origin === 'local') {
    const cleaned = stripHtmlToText(input.content ?? '');
    if (cleaned.text === '') {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '本地上传文档正文为空，无法构造澄清上下文');
    }
    blocks.push(cleaned.text);
  } else {
    if (sections.length === 0) {
      throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '请至少选择一个大纲章节或上传本地文档');
    }
    for (const sec of sections) {
      const label = [sec.scode, sec.sname].filter(Boolean).join(' ').trim() || String(sec.iid ?? '未命名章节');
      const cleaned = stripHtmlToText(sec.html ?? sec.text ?? '');
      if (cleaned.isEmptyPlaceholder || cleaned.text === '') {
        emptySections.push(label);
        continue;
      }
      blocks.push(`### ${label}\n${cleaned.text}`);
    }
  }

  const rawJoined = blocks.join('\n\n');
  const capped = truncateUtf8Bytes(rawJoined, MAX_DOC_INJECT_BYTES);
  const truncationNotice = capped.truncated
    ? `\n\n[注：文档正文超出 16 KiB 上限，已安全截断保留前 ${capped.byteLength} 字节；其余章节可在对话中按需继续读取]`
    : '';
  const emptyNotice = emptySections.length > 0
    ? `\n[注：以下所选 RMP 章节暂无正文内容（nodata）：${emptySections.join('、')}]`
    : '';

  if (emptySections.length > 0) {
    warnings.push(`已自动跳过 ${emptySections.length} 个无正文（nodata）章节`);
  }
  if (capped.truncated) {
    warnings.push('文档正文超过 16 KiB 注入上限，已截断保留核心前缀');
  }

  const verSuffix = docVer ? `（版本 ${docVer}）` : '';
  const bodySection = capped.text !== ''
    ? `【已注入文档上下文】\n${capped.text}${truncationNotice}${emptyNotice}`
    : `【已注入文档上下文】\n（所选节点均为无正文占位，请结合文档标题《${docName}》展开缺失检查）${emptyNotice}`;

  const prompt = [
    `[来源：DOP 工作台 · 已有文档澄清（${origin === 'local' ? '本地上传' : 'RMP'}）]`,
    `文档名称：《${docName}》${verSuffix}`,
    '',
    '请对照企业需求模板规范，针对下列已加载文档上下文开展缺口体检与多轮澄清（如需核对关联单据或补充章节正文，可按需调用 forge_workbench_rmp_outline_read / forge_workbench_rmp_section_read / forge_workbench_requirement_read）：',
    '1. 先输出简明结构化缺口体检清单（章节缺失、业务规则模糊、边界值缺失、异常兜底与安全/合规遗漏）；',
    '2. 针对体检发现的关键缺口，立即调用 ask_user_question 生成带推荐选项的选择卡片供我在对话框直接点选；',
    '3. 对齐完成后生成修订对照摘要。',
    '',
    ASK_USER_QUESTION_GUIDE,
    '',
    bodySection,
    '',
    '约束：未经我明确确认不得覆盖或写回需求管理平台原文档。',
  ].join('\n');

  return {
    ok: true,
    prompt,
    meta: {
      promptKind: 'req.clarify.from_doc',
      title: `文档澄清 · ${docName.slice(0, 24)}`,
      sourceSummary: `${origin === 'local' ? '本地文档' : 'RMP 文档'}《${docName}》${verSuffix}`,
      docCount: 1,
      byteLength: Buffer.byteLength(prompt, 'utf8'),
      charLength: prompt.length,
      truncated: capped.truncated,
      emptySections,
      warnings,
      deliveryNote: '确认将携带上述文档摘要进入对话草稿，绝不自动发送。',
    },
  };
}

function buildRequirementCardPrompt(input) {
  const req = input.requirement;
  if (!req || typeof req !== 'object') {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少需求详情对象');
  }
  const mode = input.mode === 'qa' ? 'qa' : 'split';
  const reqNo = String(req.no ?? req.requirementNo ?? req.id ?? '').trim() || '未知需求号';
  const reqName = String(req.name ?? req.requirementName ?? '').trim() || '未命名需求';
  const stageName = String(req.stage?.name ?? req.stage ?? '未知阶段');
  const stateName = String(req.state?.name ?? req.state ?? '未知状态');
  const managerText = formatPerson(req.manager ?? req.managerUser);
  const bizOwnerText = formatPerson(req.businessOwner ?? req.businessOwnerUser);

  // 从 77 字段中白名单提取业务核心字段，严禁注入冗余审批/系统全量
  const background = stripHtmlToText(req.backGround).text || '（无背景描述）';
  const description = stripHtmlToText(req.description).text || '（无详细描述）';
  const benefit = stripHtmlToText(req.reqBenefit).text;
  const reqDocs = Array.isArray(req.reqDocs)
    ? req.reqDocs.map((d) => String(d?.docName ?? d?.docname ?? d?.name ?? d?.code ?? '')).filter(Boolean)
    : [];

  const contextLines = [
    `需求编号：${reqNo}`,
    `需求标题：${reqName}`,
    `阶段/状态：${stageName} / ${stateName}`,
    `需求经理：${managerText}｜业务负责人：${bizOwnerText}`,
    `计划上线日：${req.onlineDate ? String(req.onlineDate) : '--'}`,
    `业务背景：${truncateUtf8Bytes(background, 2048).text}`,
    `需求描述：${truncateUtf8Bytes(description, 4096).text}`,
  ];
  if (benefit) contextLines.push(`预期收益：${truncateUtf8Bytes(benefit, 1024).text}`);
  if (reqDocs.length > 0) contextLines.push(`关联文档目录：${reqDocs.join('、')}`);

  const taskInstruction = mode === 'qa'
    ? [
      `请基于需求 ${reqNo}（${reqName}）以上上下文开展定向问答梳理（如需进一步查看需求全貌或关联 RMP 文档正文，请调用 forge_workbench_requirement_read、forge_workbench_rmp_doc_search、forge_workbench_rmp_outline_read 与 forge_workbench_rmp_section_read）：`,
      '1. 提炼核心业务流程、渠道范围、参数阈值口径与异常边界；',
      '2. 若文档或字段存在缺口需我确认，调用 ask_user_question 列出选项供我在对话框点选，严禁编造缺失参数；',
      '3. 对齐后总结需核验的安全与合规要点。',
    ]
    : [
      `请围绕需求 ${reqNo}（${reqName}）协助澄清并拆解用户故事（先按需调用 forge_workbench_requirement_read 及关联 RMP 文档工具 forge_workbench_rmp_outline_read / forge_workbench_rmp_section_read 读取完整背景与章节内容）：`,
      '1. 对照背景、描述与文档中的规则/阈值/渠道/合规口径缺口，先通过 ask_user_question 弹出候选选项卡片让我直接在对话框点选对齐；',
      '2. 口径对齐后按企业用户故事颗粒度拆解任务清单，标注需要联动「安全」或「合规」评审的故事及理由；',
      '3. 输出可审阅的故事拆分预览表供我确认。',
    ];

  const prompt = [
    `[来源：DOP 工作台 · ${mode === 'qa' ? '需求定向上下文问答' : '需求澄清与拆分用户故事'}]`,
    ...contextLines,
    '',
    ...taskInstruction,
    '',
    ASK_USER_QUESTION_GUIDE,
    '',
    '约束：请优先通过只读工具读取真实上下文；未经我明确确认不得向 DOP 平台写入或覆盖故事。',
  ].join('\n');

  return {
    ok: true,
    prompt,
    meta: {
      promptKind: 'req.card.clarify_and_split',
      title: `${mode === 'qa' ? '需求问答' : '拆解故事'} · ${reqNo}`,
      sourceSummary: `需求 ${reqNo}（${reqName.slice(0, 24)}）`,
      docCount: reqDocs.length,
      byteLength: Buffer.byteLength(prompt, 'utf8'),
      charLength: prompt.length,
      truncated: false,
      emptySections: [],
      warnings: [],
      deliveryNote: `已携带需求 ${reqNo} 核心 77 字段白名单摘要，确认后写入草稿箱。`,
    },
  };
}

function extractChangeCodes(systemChanges) {
  if (!Array.isArray(systemChanges)) return [];
  return systemChanges
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return String(item.code ?? item.changeCode ?? item.no ?? '').trim();
      return '';
    })
    .filter(Boolean);
}

function buildStoryCardPrompt(input) {
  const story = input.story;
  if (!story || typeof story !== 'object') {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '缺少用户故事详情对象');
  }
  const code = String(story.code ?? story.id ?? '').trim() || '未知故事号';
  const summary = String(story.summary ?? '').trim() || '未命名用户故事';
  const parentReqNo = String(story.requirement?.no ?? '').trim() || '--';
  const parentReqName = String(story.requirement?.name ?? '').trim() || '';
  const assigneeText = formatPerson(story.assignee);
  const bizOwnerText = formatPerson(story.businessOwner);
  const stateName = String(story.state?.name ?? '未知状态');

  const desc = stripHtmlToText(story.description).text || '（无描述）';
  const ac = stripHtmlToText(story.storyAC ?? story.acceptanceCriteria).text;
  const changeCodes = extractChangeCodes(story.systemChanges);

  const sprintItems = Array.isArray(input.sprintIssue?.items) ? input.sprintIssue.items : [];
  const sprintEntry = sprintItems[0];
  const sprintLabel = sprintEntry?.sprint?.name
    ? String(sprintEntry.sprint.name)
    : '当前接口未返回迭代归属（请核实迭代列表）';
  const pointLabel = sprintEntry?.storyPoints != null
    ? String(sprintEntry.storyPoints)
    : (story.storyPoint != null ? String(story.storyPoint) : '未估算/null');

  const lines = [
    '[来源：DOP 工作台 · 用户故事设计与 AC 准备]',
    `故事编号：${code}`,
    `故事标题：${summary}`,
    `所属需求：${parentReqNo}${parentReqName ? `（${parentReqName}）` : ''}`,
    `状态/计划上线：${stateName} / ${story.planOnlineDate ? String(story.planOnlineDate) : '--'}`,
    `迭代与故事点：${sprintLabel} / ${pointLabel}`,
    `经办人：${assigneeText}｜业务负责人：${bizOwnerText}`,
    `故事描述：${truncateUtf8Bytes(desc, 4096).text}`,
    `现有验收准则（AC）：${ac ? truncateUtf8Bytes(ac, 3072).text : '（缺失，待澄清补充）'}`,
    `关联系统变更单：${changeCodes.length > 0 ? changeCodes.join('、') : '（暂无关联系统变更单）'}`,
  ];

  const toolHints = Array.isArray(input.cliHints?.suggestions) ? input.cliHints.suggestions : [];
  if (toolHints.length > 0) {
    lines.push(`可用本地 CLI 串联：${toolHints.join('；')}`);
  }

  lines.push(
    '',
    '请基于上述用户故事上下文执行设计与验收准备（如需核对故事全量与关联父需求，可调用 forge_workbench_story_read 与 forge_workbench_requirement_read；存在变更单号时优先调用 forge_devops_change_context 补全变更级上下文）：',
    '1. 核查描述与 AC 是否存在边界条件、失败回滚、权限控制或审计留痕口径缺口，存在缺口时调用 ask_user_question 提供选项让我直接在对话框点选，严禁编造；',
    '2. 口径对齐后输出规范的 Given-When-Then 结构化 AC，以及关联系统/接口改造设计检查清单；',
    '3. 若存在关联系统变更单号，整合变更单维度受影响系统范围与独立验收要点。',
    '',
    ASK_USER_QUESTION_GUIDE,
    '',
    '约束：未经我明确确认不得回填覆盖 DOP 故事 AC 或修改系统变更状态。',
  );

  const prompt = lines.join('\n');
  return {
    ok: true,
    prompt,
    meta: {
      promptKind: 'story.card.design_and_prep',
      title: `故事澄清 · ${code}`,
      sourceSummary: `故事 ${code}（所属需求 ${parentReqNo}）`,
      docCount: changeCodes.length,
      byteLength: Buffer.byteLength(prompt, 'utf8'),
      charLength: prompt.length,
      truncated: false,
      emptySections: [],
      warnings: ac ? [] : ['当前用户故事缺少 AC，已提示引导优先补全'],
      deliveryNote: `已附带故事 ${code} 上下文与关联变更信息，确认后写入草稿箱。`,
    },
  };
}

/**
 * 需求域提示词统一入口。
 *
 * @param {object} spec
 */
export function buildRequirementPrompt(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, '提示词构造参数必须为对象');
  }
  const key = spec.actionKey;
  if (key === 'req.create.one_sentence') return buildOneSentencePrompt(spec);
  if (key === 'req.clarify.from_doc') return buildFromDocPrompt(spec);
  if (key === 'req.card.clarify_and_split') return buildRequirementCardPrompt(spec);
  if (key === 'story.card.design_and_prep') return buildStoryCardPrompt(spec);

  throw new WorkbenchError(ERROR_CODES.BAD_REQUEST, `需求域不支持的提示词动作键: ${String(key ?? '')}`);
}
