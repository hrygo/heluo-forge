/** #25: user-attested oh-my-sdd read contract, not a guessed CLI protocol. */
import { runDopChange } from './dop-process.mjs';

export const SOURCE_CONTRACT = Object.freeze({
  project: 'oh-my-sdd',
  commit: '3b95d536230fde36f867b3b1917d6569ae0d918c',
  evidence: 'user-attested enterprise usage; local source review',
  command: 'dop change view <ID> -j',
});

export class ChangeBriefingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ChangeBriefingError';
    this.code = code;
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const fieldState = (obj, key) => !Object.hasOwn(obj, key) ? 'missing' : obj[key] === null ? 'null' : obj[key] === '' || (Array.isArray(obj[key]) && obj[key].length === 0) ? 'empty' : 'present';

/** Project only explicitly sourced fields. No whole CLI payload, invented URL or revision. */
export function normalizeChangeBriefing(raw, changeId) {
  if (!/^[A-Z]{2,6}\d+$/u.test(changeId)) throw new ChangeBriefingError('BAD_CHANGE_ID');
  if (!object(raw)) throw new ChangeBriefingError('INVALID_CHANGE');
  if (raw.id !== changeId) throw new ChangeBriefingError('CHANGE_ID_MISMATCH');
  for (const key of ['title', 'status', 'description']) {
    if (!text(raw[key])) throw new ChangeBriefingError(`MISSING_${key.toUpperCase()}`);
  }
  if (!Array.isArray(raw.acceptance_criteria) || raw.acceptance_criteria.length === 0 || !raw.acceptance_criteria.every(text)) {
    throw new ChangeBriefingError('MISSING_ACCEPTANCE');
  }
  if (raw.sub_systems !== undefined && raw.sub_systems !== null && !Array.isArray(raw.sub_systems)) throw new ChangeBriefingError('INVALID_SUBSYSTEMS');
  if (raw.user_stories !== undefined && raw.user_stories !== null && !Array.isArray(raw.user_stories)) throw new ChangeBriefingError('INVALID_STORIES');
  const subsystems = (raw.sub_systems ?? []).map((item) => {
    if (!object(item) || !text(item.code) || !text(item.name)) throw new ChangeBriefingError('INVALID_SUBSYSTEMS');
    return { code: item.code, name: item.name };
  });
  const stories = (raw.user_stories ?? []).map((story) => {
    if (!object(story) || !text(story.code) || !text(story.title)) throw new ChangeBriefingError('INVALID_STORIES');
    const release = story.release_info;
    if (release !== undefined && release !== null && !object(release)) throw new ChangeBriefingError('INVALID_RELEASE');
    return {
      code: story.code,
      title: story.title,
      release: object(release) && text(release.release_num) ? {
        number: release.release_num,
        name: text(release.release_name) ? release.release_name : null,
      } : null,
    };
  });
  return {
    id: raw.id, title: raw.title, platformStatus: raw.status,
    description: raw.description, acceptance: [...raw.acceptance_criteria],
    subsystems, stories, release: stories.find((story) => story.release !== null)?.release ?? null,
    fieldStates: {
      sub_systems: fieldState(raw, 'sub_systems'), user_stories: fieldState(raw, 'user_stories'),
      requirement_revision: 'unmapped', repository: 'unmapped',
    },
    // The source contract does not establish either field. Ignore tempting
    // unknown top-level aliases, including model-supplied approved/principal.
    sourceRevision: null, repository: null, engineeringReady: false,
    limitations: ['需求版本未映射：可阅读，不作冻结或并发写依据。', '仓库映射未核定：不跨仓查询、不自动承接任务。'],
  };
}

/** Plug into the existing reader port; policy remains owned by the caller. */
export function createDopReader(options = {}) {
  return Object.freeze({
    async read({ action, target } = {}) {
      if (action !== 'change.read') throw new ChangeBriefingError('UNSUPPORTED_DOP_ACTION');
      const raw = await runDopChange({ ...options, changeId: target });
      const facts = normalizeChangeBriefing(raw, target);
      return {
        status: 'unknown', source_revision: null, target_ref: target,
        result_refs: [], error_code: 'MISSING_SOURCE_REVISION',
        observed_at: new Date().toISOString(), facts,
      };
    },
  });
}

const escape = (value) => String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function renderBriefingText(report) {
  const { facts } = report;
  return [
    `河洛 · 变更只读简报 | ${report.mode === 'demo' ? '本地模拟 / 非企业数据' : '本机 CLI 读取 / 非写授权'}`,
    `${facts.id} · ${facts.title}`, `平台状态：${facts.platformStatus}`,
    '', facts.description, '', '独立验收项：',
    ...facts.acceptance.map((item, index) => `  ${index + 1}. ${item}`),
    '', `子系统：${facts.subsystems.map((item) => `${item.code} · ${item.name}`).join('；') || '未提供'}`,
    `排期：${facts.release ? `${facts.release.number} · ${facts.release.name ?? '名称未提供'}` : '未提供'}`,
    '', '已完成：显式变更读取 → 类型/目标校验 → 需求/验收/排期展示 → 必要审计结清。',
    ...facts.limitations, '写入 / done / merge / 遥测：均未调用。',
    `依据：${SOURCE_CONTRACT.project}@${SOURCE_CONTRACT.commit}`, '',
  ].join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
}

/** Self-contained report: no JS, remote resources or unescaped platform markup. */
export function renderBriefingHtml(report) {
  const { facts } = report;
  const label = report.mode === 'demo' ? '本地模拟 · 非企业数据' : '本机 CLI 只读 · 非写授权';
  const list = (items) => items.map((item) => `<li>${escape(item)}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>河洛 · ${escape(facts.id)} 变更简报</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#19283e;font:16px/1.75 system-ui,sans-serif}main{max-width:1040px;margin:48px auto;padding:0 24px}header{border-bottom:1px solid #d3dae6;padding-bottom:26px}.brand{letter-spacing:.16em;color:#246b61;font-weight:700}.badge{float:right;background:#f6ebcd;color:#775100;padding:4px 14px;border-radius:20px;font-size:13px}h1{font-size:36px;line-height:1.3;margin:20px 0 8px}h2{font-size:21px;margin:0 0 14px}.lead{color:#526579}.grid{display:grid;grid-template-columns:2fr 1fr;gap:22px;margin-top:24px}section{background:white;border:1px solid #dbe2ec;border-radius:14px;padding:25px;margin-bottom:22px}.steps{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}.steps span{background:#e3f2ec;color:#245d48;padding:7px 13px;border-radius:8px}li{margin:10px 0}.description{white-space:pre-wrap;overflow-wrap:anywhere}small,footer{color:#64748b}.note{border-left:4px solid #d4a238}code{overflow-wrap:anywhere;font-size:13px}dt{font-size:13px;color:#64748b}dd{margin:0 0 16px;overflow-wrap:anywhere}footer{font-size:12px;padding-bottom:28px}@media(max-width:700px){.grid{display:block}h1{font-size:28px}.badge{float:none;display:inline-block}main{margin:24px auto}}@media print{body{background:white}main{margin:0}section{break-inside:avoid}}
</style></head><body><main><header><span class="brand">河洛 HELUO FORGE / READ-ONLY</span><span class="badge">${escape(label)}</span><h1>${escape(facts.title)}</h1><div class="lead">${escape(facts.id)} · 平台状态 ${escape(facts.platformStatus)} · 显式选择，零业务写入</div></header><div class="steps"><span>✓ 读取变更</span><span>✓ 校验目标与字段</span><span>✓ 提取独立验收</span><span>✓ 审计结清</span></div><div class="grid"><div><section><h2>需求：这次要完成什么</h2><div class="description">${escape(facts.description)}</div></section><section><h2>独立验收项</h2><ol>${list(facts.acceptance)}</ol><small>这些是平台返回的验收要求，不是本报告宣称业务验收通过。</small></section></div><aside><section><h2>来源与工作背景</h2><dl><dt>子系统</dt><dd>${escape(facts.subsystems.map((item) => `${item.code} · ${item.name}`).join('；') || '未提供')}</dd><dt>排期（故事内首个非空）</dt><dd>${escape(facts.release ? `${facts.release.number} · ${facts.release.name ?? '名称未提供'}` : '未提供')}</dd><dt>故事</dt><dd>${escape(facts.stories.map((story) => `${story.code} · ${story.title}`).join('；') || '未提供')}</dd></dl></section><section class="note"><h2>下一步所需依据</h2><ul>${list(facts.limitations)}</ul><small>可读简报已就绪；不因此开放自动写或关闭 Issue。</small></section></aside></div><section><h2>本次实际做了什么</h2><p>只执行 <code>dop change view ${escape(facts.id)} -j</code>。需求、验收、子系统与排期可见；没有建单、修改、done、合并或遥测请求。</p><p>数据来源：${escape(label)}。命令用法依据：<code>${escape(SOURCE_CONTRACT.project)}@${escape(SOURCE_CONTRACT.commit)}</code>，用户已在企业实测；本次本地仿 CLI 测试不冒充企业往返。</p><p>审计：${escape(report.auditMode)}；观察时间：${escape(report.observedAt)}。</p></section><footer>报告仅含当前显式选择变更的业务内容。实源报告请保存在获准目录，不上传公开 Issue、PR 或日志。</footer></main></body></html>`;
}
