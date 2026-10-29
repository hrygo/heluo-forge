/**
 * `@heluo/forge-devops` 的 dop 适配器：业务事实（变更 / 用户故事 / 验收条件）的唯一出口（T2）。
 *
 * 只做三件事：**固定 argv**、**把命令结果翻译成只读信封**、**失败给已登记原因码**。
 * 记录 → `Change` 的字段映射不在这里（见 `change-context.mjs`）：这里把解析后的记录
 * 原样放进 `raw`，避免同一个字段出现两份映射。同理，记录字段齐不齐、id 是否与请求一致，
 * 都由 `normalizeChangeRecord(raw, { expectedId })` 判定——适配器不越权替上层做契约校验。
 *
 * 命令面（AC-22 / TECHNICAL §5.3），两条都是只读：
 *   `change view <changeId> --json`（运行时配置了 endpoint 时追加 `--endpoint <env>`）
 *   `change list --json`（可选 `--status <status>`）
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

import { DevopsReadError, READ_REASONS } from './read.mjs';

/**
 * 允许的命令面（枚举到函数）：每条都是 `<verb> <sub>` 的固定前缀，后面只跟业务字段。
 * 测试按此表逐条核对；表里没有的动词在本模块不存在，不靠运行时拦截。
 */
export const DOP_COMMANDS = Object.freeze({
  changeView: Object.freeze(['change', 'view']),
  changeList: Object.freeze(['change', 'list']),
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

/** dop 的 JSON 只接受对象；解析失败就是拿不到结构化事实，直接抛而非猜字段。 */
function parseRecord(stdout, detail) {
  const raw = text(stdout);
  if (raw === '') fail(READ_REASONS.MALFORMED_RESULT, 'dop 没有输出，无法解析 JSON 记录', detail);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(READ_REASONS.MALFORMED_RESULT, `dop 输出不是合法 JSON：${clip(raw)}`, detail);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(READ_REASONS.MALFORMED_RESULT, `dop 的 JSON 输出必须是对象，实际是 ${Array.isArray(parsed) ? 'array' : typeof parsed}`, detail);
  }
  return parsed;
}

/**
 * 创建 dop 适配器。
 * @param {{runner: {run: Function}, dopBin?: string, dopEndpoint?: string, now?: () => string}} options
 */
export function createDopAdapter({ runner = null, dopBin = '', dopEndpoint = '', now = () => new Date().toISOString() } = {}) {
  if (runner === null || typeof runner !== 'object' || typeof runner.run !== 'function') {
    throw new TypeError('createDopAdapter 需要可注入的 runner（{ run({bin,args,purpose}) }），不允许在适配器内自建子进程');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须是返回 ISO 时间串的函数');

  const bin = text(dopBin);
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

  /** endpoint 只作实参透传；命令标签不含它，避免诊断文案泄露环境信息。 */
  function argvOf(args) {
    return endpoint === '' ? [...args] : [...args, '--endpoint', endpoint];
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
      const spawnFailed = result.exitCode === null || result.exitCode === undefined;
      fail(
        READ_REASONS.COMMAND_FAILED,
        `${context.command} 失败（${spawnFailed ? '未启动' : `退出码 ${result.exitCode}`}）：${failureLine(result)}`,
        { ...context, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null, spawnFailed },
      );
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

  return Object.freeze({
    /** `change view <id> --json`：只读一条变更；记录不在此处校验，`raw` 原样交出。 */
    async readChange({ changeId } = {}) {
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
    },

    /** `change list --json`：只读变更清单（幂等查重与范围提示用），不做分页推断。 */
    async listChanges({ status } = {}) {
      const filter = status === undefined || status === null || text(status) === '' ? '' : assertStatus(status);
      const args = [...DOP_COMMANDS.changeList, '--json', ...(filter === '' ? [] : ['--status', filter])];
      const { result, context } = await invoke({ args, purpose: 'dop.change.list' });
      const raw = parseRecord(result.stdout, context);
      const items = asArray(raw.changes);
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
        total: Number.isInteger(raw.total) ? raw.total : items.length,
        truncated: result.truncated === true,
        raw,
      };
    },

    /** 命令面自述：只报能力与是否注入 endpoint，不回显路径/endpoint 值。 */
    capabilities() {
      return Object.freeze({
        source: DOP_LOGICAL_NAME,
        read: Object.freeze(['change.view', 'change.list']),
        write: Object.freeze([]),
        endpoint_configured: endpoint !== '',
        executable_configured: bin !== '',
      });
    },
  });
}
