/**
 * `@heluo/forge-devops` 的 dop 适配器：业务事实（变更 / 用户故事 / 验收条件）的唯一出口（T2）。
 *
 * 只做三件事：**固定 argv**、**把命令结果翻译成只读信封**、**失败给已登记原因码**。
 * 记录 → `Change` 的字段映射不在这里（见 `change-context.mjs`）：这里把解析后的记录
 * 原样放进 `raw`，避免同一个字段出现两份映射。同理，记录字段齐不齐、id 是否与请求一致，
 * 都由 `normalizeChangeRecord(raw, { expectedId })` 判定——适配器不越权替上层做契约校验。
 *
 * 命令面（AC-22 / TECHNICAL §5.3）：
 *   `change view <changeId> --json`（配置了 endpoint 时追加 `--api-endpoint <env>`）
 *   `change list --json`（可选 `--status <status>`）
 *   `change update <changeId> [--summary <s>] [--description <s>] [--ai-ac <s>]`（受控写，
 *   2026-11-04 用户提供的 dop 1.x 新参数；三个 flag 逐一固定，不做通用 argv 透传）
 *
 * endpoint flag 的名义与真实 CLI 对齐：1.0.4 的全局 flag 是 `--api-endpoint`（此前写成
 * `--endpoint`，配置了 endpoint 时会以 unknown flag 直接失败）。1.0.4 实测该 flag 被解析但
 * 不改变实际请求地址；这里仍原样透传，兼容后续版本。
 * 结构化输出**只用长名 `--json`**：内网真 CLI 没有短名 `-j`（2026-10 实测直接报错），
 * 只有 mock 同时收两者——短名会让离线全绿、到真实环境才炸，别改回去。
 * 写命令与"通用 run(args)"入口在本模块**不存在**：argv 由本文件的常量与字段校验拼出，
 * 调用方只能传业务字段，传 `args` 之类的 argv 覆盖项不会生效。
 *
 * 装配要点（AC-22，fail closed 且不崩装配）：
 * - `dopBin` 必须由运行时配置注入，本模块**不写默认值、不硬编码路径**；未注入时
 *   `createDopAdapter` 仍可构造，但任何命令都以 `NO_READER` 显式失败且**零子进程调用**。
 * - `dopEndpoint` 只作 `--endpoint` 实参透传，不进命令标签、不进日志（诊断文案只写逻辑名 `dop`）。
 * - 不读 `process.env`、不读时钟：`now` 可注入，`observed_at` 因而可离线断言。
 */

import { createHash } from 'node:crypto';

import { failureFaceOf } from './failure-face.mjs';
import { DevopsReadError, READ_REASONS } from './read.mjs';

/**
 * 允许的命令面（枚举到函数）：每条都是 `<verb> <sub>` 的固定前缀，后面只跟业务字段。
 * 测试按此表逐条核对；表里没有的动词在本模块不存在，不靠运行时拦截。
 */
export const DOP_COMMANDS = Object.freeze({
  changeView: Object.freeze(['change', 'view']),
  changeList: Object.freeze(['change', 'list']),
  changeUpdate: Object.freeze(['change', 'update']),
});

/**
 * `change update` 支持的三个字段与它们的 flag（顺序即 argv 顺序）。
 *
 * `summary` = 标题、`description` = 描述、`aiAc` = 验收标准（用户 2026-11-04 给出）。
 * 真实 CLI 的 `--help` 尚未取证：只按这三条固定 flag 拼参，新增参数必须先拿到实测输出。
 */
export const DOP_UPDATE_FIELDS = Object.freeze([
  Object.freeze({ field: 'summary', flag: '--summary' }),
  Object.freeze({ field: 'description', flag: '--description' }),
  Object.freeze({ field: 'aiAc', flag: '--ai-ac' }),
]);

/** `change update` 的写前置原因（命令失败/超时按结果四态返回，不在这里抛）。 */
export const DOP_WRITE_REASONS = Object.freeze({
  MISSING_FIELDS: 'MISSING_FIELDS',
});

/** 诊断标签用的逻辑程序名：真实路径由环境注入，任何输出/错误文案都不回显它。 */
export const DOP_LOGICAL_NAME = 'dop';

/** 变更号形状与入口 `parseChangeId` 同源：令牌，不按前缀推断（§5.1）。 */
const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

/** 变更状态是平台侧词表，适配器只做"安全令牌"校验，不硬编码平台枚举。 */
const STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** 诊断片段上限：错误信息要能贴进工具输出，不能把整段 stdout 搬进去。 */
const DIAGNOSTIC_LIMIT = 160;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});

function clip(value, limit = DIAGNOSTIC_LIMIT) {
  const raw = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

/** 失败信息的首选证据行：先 stderr，再 stdout，都没有就说"无输出"，不编原因。 */
function failureLine(result) {
  const stderr = text(result?.stderr);
  if (stderr !== '') return clip(stderr.split('\n').find((line) => line.trim() !== ''), DIAGNOSTIC_LIMIT);
  const stdout = text(result?.stdout);
  if (stdout !== '') return clip(stdout.split('\n').find((line) => line.trim() !== ''), DIAGNOSTIC_LIMIT);
  return '无输出';
}

function fail(code, message, detail = {}) {
  throw new DevopsReadError(code, message, detail);
}

function assertChangeId(changeId) {
  const value = text(changeId);
  if (value === '') {
    fail(READ_REASONS.MISSING_TARGET, '缺少变更号：dop 只接受 change view/list 需要的业务标识', { field: 'changeId' });
  }
  if (!CHANGE_ID_PATTERN.test(value)) {
    fail(READ_REASONS.MISSING_TARGET, `变更号格式非法：${clip(value, 40)}（应为字母或数字开头的令牌，例如 ARD123456）`, {
      field: 'changeId',
    });
  }
  return value;
}

function assertStatus(status) {
  const value = text(status);
  if (!STATUS_PATTERN.test(value)) {
    fail(READ_REASONS.MISSING_TARGET, `变更状态格式非法：${clip(value, 40)}（只接受小写字母开头的令牌）`, { field: 'status' });
  }
  return value;
}

/**
 * 记录内容指纹：dop 不返回版本号，"事实冻结在哪一版"必须有一串可引用（TECHNICAL §4.1）。
 * 用原始 stdout 而不是重新序列化的对象：换一种键序不该被读成另一个版本。
 */
const digest = (stdout) => createHash('sha256').update(String(stdout ?? ''), 'utf8').digest('hex').slice(0, 12);

/**
 * dop 的 JSON 解析：单条记录必须是对象；清单（`change list --json`）在真实 1.x 里是数组，
 * 只有显式 `allowArray` 的调用方接受数组——两种形状都在这里判，不在下游猜。
 */
function parseRecord(stdout, detail, { allowArray = false } = {}) {
  const raw = text(stdout);
  if (raw === '') fail(READ_REASONS.MALFORMED_RESULT, 'dop 没有输出，无法解析 JSON 记录', detail);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(READ_REASONS.MALFORMED_RESULT, `dop 输出不是合法 JSON：${clip(raw)}`, detail);
  }
  if (allowArray && Array.isArray(parsed)) return parsed;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(READ_REASONS.MALFORMED_RESULT, `dop 的 JSON 输出必须是对象，实际是 ${Array.isArray(parsed) ? 'array' : typeof parsed}`, detail);
  }
  return parsed;
}

/**
 * 创建 dop 适配器。
 *
 * `platform` 只影响**未启动时的归因文案**（入口形态判定），可选注入是为了让 win32 提示
 * 能在任意宿主上离线断言；不传时跟随 `process.platform`，现有调用零改动。
 *
 * @param {{runner: {run: Function}, dopBin?: string, dopEndpoint?: string, now?: () => string, platform?: string}} options
 */
export function createDopAdapter({
  runner = null,
  dopBin = '',
  dopEndpoint = '',
  now = () => new Date().toISOString(),
  platform = process.platform,
} = {}) {
  if (runner === null || typeof runner !== 'object' || typeof runner.run !== 'function') {
    throw new TypeError('createDopAdapter 需要可注入的 runner（{ run({bin,args,purpose}) }），不允许在适配器内自建子进程');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须是返回 ISO 时间串的函数');

  const bin = text(dopBin);
  const hostPlatform = platform ?? process.platform;
  const endpoint = text(dopEndpoint);
  const at = () => now();

  /** 未注入可执行入口：fail closed 且零调用，而不是退化成 PATH 上的某个 dop。 */
  function assertConfigured(context) {
    if (bin === '') {
      fail(READ_REASONS.NO_READER, '未配置 dop 可执行入口（FORGE_DEVOPS_DOP_BIN），命令不执行', {
        ...context,
        field: 'dopBin',
      });
    }
  }

  /** endpoint 只作实参透传（真实 flag 名 `--api-endpoint`）；命令标签不含它，避免泄露环境信息。 */
  function argvOf(args) {
    return endpoint === '' ? [...args] : [...args, '--api-endpoint', endpoint];
  }

  const labelOf = (args) => [DOP_LOGICAL_NAME, ...args].join(' ');

  function assertSucceeded(result, context) {
    if (result === null || typeof result !== 'object') {
      fail(READ_REASONS.MALFORMED_RESULT, `${context.command} 没有返回命令结果`, context);
    }
    if (result.timedOut === true) {
      fail(READ_REASONS.COMMAND_TIMEOUT, `${context.command} 超时，未取得平台事实`, { ...context, timedOut: true });
    }
    if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
      // 失败面由 `failure-face.mjs` 单点渲染（r9 / AC-1、AC-5）：本模块只回答「这次调用失败了
      // 吗」，不再自己拼用户可见的句子。未启动（exitCode 为 null）时**证据行根本不传进去**——
      // 形态即结论，这是 AC-2「六注入零命中」的结构性保证，而不是靠正则把路径抹掉。
      const spawnFailed = result.exitCode === null || result.exitCode === undefined;
      const face = failureFaceOf({
        command: context.command,
        bin,
        platform: hostPlatform,
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        evidence: spawnFailed ? '' : failureLine(result),
        observedAt: context.observedAt,
      });
      fail(face.code, face.message, face.detail);
    }
  }

  async function invoke({ args, purpose }) {
    const command = labelOf(args);
    const observedAt = at();
    const context = { command, observedAt };
    assertConfigured(context);
    const result = await runner.run({ bin, args: argvOf(args), purpose });
    assertSucceeded(result, context);
    return { result, context };
  }

  /** `change view <id> --json` 的单点实现：读面与写后回读共用。 */
  async function readChangeOf({ changeId } = {}) {
    const id = assertChangeId(changeId);
    const { result, context } = await invoke({
      args: [...DOP_COMMANDS.changeView, id, '--json'],
      purpose: 'dop.change.view',
    });
    const raw = parseRecord(result.stdout, context);
    return {
      status: 'succeeded',
      target_ref: id,
      source_revision: `dop:${digest(result.stdout)}`,
      observed_at: context.observedAt,
      result_refs: [],
      command: context.command,
      change_id: id,
      duration_ms: Number.isFinite(result.durationMs) ? result.durationMs : null,
      truncated: result.truncated === true,
      raw,
    };
  }

  /** 写后回读：`change view --json` 的平台记录里，三个字段落在哪里（字段缺失按 absent）。 */
  function readbackOf(raw, fields) {
    const value = (input) => (typeof input === 'string' ? input.trim() : '');
    const storyAc = value(asObject(raw?.userStory).storyAC);
    const state = (expected, actual, { contains = false } = {}) => {
      if (expected === '') return 'skipped';
      if (actual === '') return 'absent';
      if (actual === expected) return 'match';
      // `--ai-ac` 写进故事的 storyAC（平台可能用 HTML 包裹），包含即视为已写入；
      // 这只用于"回读是否可见"，不改变写入内容。
      return contains && actual.includes(expected) ? 'match' : 'mismatch';
    };
    return {
      summary: state(fields.summary, value(raw?.summary)),
      description: state(fields.description, value(raw?.description)),
      aiAc: state(fields.aiAc, storyAc, { contains: true }),
    };
  }

  return Object.freeze({
    /** `change view <id> --json`：只读一条变更；记录不在此处校验，`raw` 原样交出。 */
    readChange: readChangeOf,

    /**
     * `change update <id> [--summary/--description/--ai-ac]`：受控写的**执行面**。
     *
     * 只做三件事：固定 argv、把命令面失败翻译成结果状态、写后用 `change view` 回读核对。
     * 门禁、confirm、变更号绑定都在工具/装配层；本方法不知道"谁批准了这次写"。
     *
     * 结果状态：`done`（回读三字段全部 match/skipped）、`unknown`（命令可能已执行但回读
     * 不一致/不可得，**不重放**）、`failed`（命令失败且回读确认未写入）。
     */
    async updateChange({ changeId, summary, description, aiAc } = {}) {
      const id = assertChangeId(changeId);
      const fields = {
        summary: text(summary),
        description: text(description),
        aiAc: text(aiAc),
      };
      if (fields.summary === '' && fields.description === '' && fields.aiAc === '') {
        fail(DOP_WRITE_REASONS.MISSING_FIELDS, 'change update 至少需要一个字段（summary / description / aiAc）', {
          field: 'summary',
        });
      }
      const args = [...DOP_COMMANDS.changeUpdate, id];
      for (const { field, flag } of DOP_UPDATE_FIELDS) {
        if (fields[field] !== '') args.push(flag, fields[field]);
      }
      const command = labelOf(args);
      const observedAt = at();
      const context = { command, observedAt };
      assertConfigured(context);

      let outcome = 'sent';
      let reason = null;
      try {
        await invoke({ args, purpose: 'dop.change.update' });
      } catch (error) {
        const detail = asObject(error?.detail);
        // 没启动 = 没写；超时/非零退出 = 可能已写，交给回读判定，绝不重放。
        if (detail.spawnFailed === true) throw error;
        if (detail.timedOut === true) {
          outcome = 'uncertain';
          reason = 'COMMAND_TIMEOUT';
        } else if (text(error?.code) === 'COMMAND_FAILED') {
          outcome = 'uncertain';
          reason = 'COMMAND_FAILED';
        } else {
          throw error;
        }
      }

      let readback = null;
      let readbackError = null;
      try {
        const read = await readChangeOf({ changeId: id });
        const states = readbackOf(read.raw, fields);
        readback = {
          ok: Object.values(states).every((state) => state === 'match' || state === 'skipped'),
          fields: states,
          source_revision: read.source_revision,
          observed_at: read.observed_at,
        };
      } catch (error) {
        readbackError = text(error?.code) || 'READBACK_FAILED';
      }

      const verified = readback !== null && readback.ok === true;
      const status = verified ? (outcome === 'sent' ? 'done' : 'unknown') : outcome === 'sent' || readback === null ? 'unknown' : 'failed';
      return {
        status,
        target_ref: id,
        command,
        observed_at: observedAt,
        fields: Object.freeze({ ...fields }),
        reason,
        readback,
        readback_error: readbackError,
        // 写动作的可能副作用标记：非零退出/超时时即使未回读到，也不能假设"没发生"。
        // 命令跑完（exit 0）或回读不可得时，都不能假设"没发生"；非零退出且回读确认未写入才算无副作用。
        may_have_side_effect: verified || outcome === 'sent' || readback === null,
        retry_policy: 'none',
      };
    },

    /** `change list --json`：只读变更清单（幂等查重与范围提示用），不做分页推断。 */
    async listChanges({ status } = {}) {
      const filter = status === undefined || status === null || text(status) === '' ? '' : assertStatus(status);
      // 真实 1.x 的清单过滤 flag 是 `--state`（`--status` 不存在）；分页/搜索/team 尚未接入。
      const args = [...DOP_COMMANDS.changeList, '--json', ...(filter === '' ? [] : ['--state', filter])];
      const { result, context } = await invoke({ args, purpose: 'dop.change.list' });
      const raw = parseRecord(result.stdout, context, { allowArray: true });
      // 真实 1.x 的 JSON 是数组（无 changes/total 包裹，也没有分页元数据）；旧 mock 是对象。
      const list = Array.isArray(raw) ? null : asObject(raw);
      const items = Array.isArray(raw) ? raw : asArray(list.changes);
      return {
        status: 'succeeded',
        target_ref: filter === '' ? 'changes' : `changes:${filter}`,
        source_revision: `dop:${digest(result.stdout)}`,
        observed_at: context.observedAt,
        result_refs: [],
        command: context.command,
        filter: filter === '' ? null : { status: filter },
        items,
        count: items.length,
        total: list !== null && Number.isInteger(list.total) ? list.total : items.length,
        // 平台清单自报的"当前用户"：没有就显式 null，不按本机账号猜。
        user: list !== null && typeof list.user === 'string' ? list.user : null,
        truncated: result.truncated === true,
        raw,
      };
    },

    /** 命令面自述：只报能力与是否注入 endpoint，不回显路径/endpoint 值。 */
    capabilities() {
      return Object.freeze({
        source: DOP_LOGICAL_NAME,
        read: Object.freeze(['change.view', 'change.list']),
        write: Object.freeze(['change.update']),
        endpoint_configured: endpoint !== '',
        executable_configured: bin !== '',
      });
    },
  });
}
