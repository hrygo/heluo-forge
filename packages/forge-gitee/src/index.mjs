/**
 * `@heluo/forge-gitee` 插件入口（宿主装配层）。
 *
 * 这一层只做**装配与 fail-closed**，不做业务判断：配置校验、宿主能力探测、策略目录自检、
 * 依赖装配（runner → adapter → guard → session → 工具面）、provide、注册工具、清理注册。
 * 业务判定（只读归一、四状态、幂等、回读、审查渲染、交付判定）都在 `gitee-*.mjs` 里，
 * 这样"装上了但策略没生效"这类问题只能在装配期暴露，而不是运行期悄悄降级。
 *
 * 装配顺序是硬约束（TECHNICAL §3，失败即抛 `GiteeMountError`，原因码见 `GITEE_REASONS`）：
 *   1. 配置：`validateGiteeConfig` → `GITEE_CONFIG_INVALID`（报字段名，不报值）
 *   2. 宿主能力：`ctx.get/provide/effect` 与 `ctx.tools.register` → `GITEE_HOST_UNAVAILABLE`
 *   3. 策略服务：`ctx.get('policy')` 且有 `executeAction` → `GITEE_POLICY_UNAVAILABLE`
 *   4. 目录自检：三个 `gitee.*` 只读动作必须已登记且 `enabled` → `GITEE_ACTION_UNREGISTERED`
 *      （`detail.missing` 列全）。缺策略、缺目录都不降级成"无策略只读"。
 *      **只查 gitee 自己的三条**：默认目录是 devops 与 gitee 的 6 条并集（含 devops 的
 *      `change.read` / `change.list`），本插件不依赖那两条 dop 动作，要求它们存在就是耦合到
 *      另一个平台的配置面。
 *   5. 依赖装配：`resolveGiteeConfig` → runner → git adapter / CLI adapter → guard → session
 *      （**惰性**：`preflight()` 在首次真正调用时执行，装配期不起子进程、不读凭据内容；
 *      但 git 适配器的 argv 表与 `runGit` 出口在装配期就校验，缺 `runGit` 直接拒绝挂载）
 *   6. `provide('gitee', service)` + `provide('giteeAdapter', adapter)` + 注册 10 个工具
 *   7. `ctx.effect(() => teardown)`：卸载时撤工具、撤服务，`status()` 变 `disposed`
 *
 * 顶层没有任何副作用：不访问 `ctx`、不读 `process.env`、不起子进程——插件模块在宿主
 * `--dump-config` 与 `import()` 探针里都可能被单独加载（AC-6）。
 *
 * ## `service` 端口（工具定义只通过它触达平台）
 *
 * 工具定义由 `gitee-read.mjs` / `gitee-actions.mjs` 提供，它们拿到的就是下面这个对象。
 * 端口是**薄**的：只暴露"经门禁的一次调用"与只读元信息，不暴露 argv、不暴露子进程、
 * 不暴露写操作的重放能力。
 *
 * | 成员 | 语义 |
 * |---|---|
 * | `provider` | 恒为 `'gitee'`（信封与动作命名空间的唯一来源） |
 * | `readActions()` / `toolNames()` | 3 个只读动作 / 10 个工具名（顺序固定） |
 * | `writeTools()` | 4 个受控写工具名（交付判定是只读能力，归 `GITEE_JUDGE_TOOLS`，不算写工具） |
 * | `status()` | `'ready'`（已装配）或 `'disposed'`（已卸载） |
 * | `describe()` | 脱敏配置描述（不含令牌内容与绝对路径） |
 * | `preflight()` | CLI/凭据预检（首次调用才真正执行，返回原因码而非抛错） |
 * | `read({action,target,params})` | 只读：先过 `policy.executeAction`，再归一成 AC-15 信封；策略拒绝时抛带 `code='POLICY_DENIED'` 的错误 |
 * | `execute({action,target,payload,confirm,…})` | 受控动作：**直通** `guard.execute`（唯一准入点），不做二次解释、不重试、不重放 |
 * | `write(request)` | `execute` 的同义入口（两侧工具定义的叫法不同，语义只有一套） |
 * | `invoke(command,params,purpose)` | 经适配器调用 CLI（仍是唯一 `execFile` 出口，argv 由适配器白名单构造） |
 * | `adapter()` / `guard()` / `session()` / `git()` | 只给同包内工具定义用的装配件（幂等台账是进程内 Map，不落盘） |
 * | `git()` | 本地 git 命令面（`commit` 是本地动作、`push` 走受控动作 `gitee.git.push`）；工具层只拿端口，不持 runner |
 */
import {
  GITEE_CONFIG_KEYS,
  GITEE_ENTRY_ID,
  GITEE_ORIGINS,
  GITEE_PAGE_HINT,
  GITEE_REBUILD_REASON,
  createGiteeAccess,
} from './config-access.mjs';
import { GITEE_API_PREFIX, GITEE_CONFIG_ROUTE, createGiteeApi, toNodeRoute } from './http.mjs';
import { createGiteeAdapter } from './gitee-adapter.mjs';
import { createGiteeRunner, detectPersistentToken } from './gitee-cli.mjs';
import { createGiteeGitAdapter } from './gitee-git.mjs';
import { GITEE_PLATFORM, createGiteeGuard } from './gitee-guard.mjs';
import { GITEE_READ_ACTIONS, normalizeGiteeReadResult } from './gitee-read.mjs';
import { createGiteeSession } from './gitee-session.mjs';
import { SNAPSHOT_REASONS, createGiteeSnapshotReader } from './gitee-snapshot.mjs';
import { GITEE_TOOLS, GITEE_WRITE_TOOLS, buildGiteeTools } from './gitee-tools.mjs';
import {
  ConfigStandard,
  describeGiteeConfig,
  resolveGiteeConfig,
  validateGiteeConfig,
} from './runtime-config.mjs';

/** 插件名：宿主的条目名与补丁层 `name:` 都必须是这个包根名。 */
export const name = 'forge-gitee';

/** 依赖的宿主服务：工具面 + 策略门禁。两者缺一即拒绝挂载。 */
export const inject = Object.freeze(['tools', 'policy']);

/** 配置标准（`ConfigStandard['~standard'].validate`）。 */
export const Config = ConfigStandard;

/** 服务键：装配出的 gitee 服务。 */
export const SERVICE_KEY = 'gitee';

/** 服务键：装配出的 gitee 适配器（供同 profile 的其它插件做 provider 分流，不暴露 argv）。 */
export const ADAPTER_KEY = 'giteeAdapter';

/** 装配期原因码（工具面/动作侧的原因码各自在对应模块里）。 */
export const GITEE_REASONS = Object.freeze({
  /** 配置不合法：`detail.issues` 只带字段名与原因，不回显用户填的值。 */
  CONFIG_INVALID: 'GITEE_CONFIG_INVALID',
  /** 宿主能力不足（缺 `ctx.get/provide/effect` 或 `ctx.tools.register`）。 */
  HOST_UNAVAILABLE: 'GITEE_HOST_UNAVAILABLE',
  /** 策略服务缺失或没有 admission 入口。 */
  POLICY_UNAVAILABLE: 'GITEE_POLICY_UNAVAILABLE',
  /** 三个只读动作没在策略目录里登记/启用（或目录本身为空）。 */
  ACTION_UNREGISTERED: 'GITEE_ACTION_UNREGISTERED',
  /** 工具面组装/注册失败（缺项、越界、宿主注册抛错）——已回滚，不留半挂载。 */
  TOOLS_UNAVAILABLE: 'GITEE_TOOLS_UNAVAILABLE',
  /** 服务已卸载后仍被调用（可见错误，不是静默返回空）。 */
  STATUS_DISPOSED: 'GITEE_STATUS_DISPOSED',
  /** 只读调用被策略拒绝（工具层据此给出 `status:'denied'` 的统一信封）。 */
  POLICY_DENIED: 'POLICY_DENIED',
  /**
   * 配置已落盘、读面重建失败（AC-8）：保存与应用是两个结论，页面必须能分开说。
   * 这个码只出现在 `saveGiteeConfig()` 的 `applied.reason` 里，不改变保存本身的成功。
   */
  REBUILD_FAILED: GITEE_REBUILD_REASON,
});

/** 装配期错误：带原因码，宿主记 `did not activate` 时能看出到底缺什么。 */
export class GiteeMountError extends Error {
  constructor(reason, message, detail) {
    super(message);
    this.name = 'GiteeMountError';
    this.code = reason;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

const HOST_METHODS = Object.freeze(['get', 'provide', 'effect']);

function mountError(reason, message, detail) {
  return new GiteeMountError(reason, message, detail);
}

/** 一次性取到并校验配置：`{issues}` 直接翻成装配错误，不带原值。 */
function validateConfig(rawConfig) {
  const candidate = rawConfig === undefined || rawConfig === null ? {} : rawConfig;
  const result = validateGiteeConfig(candidate);
  if (result !== null && typeof result === 'object' && Array.isArray(result.issues)) {
    throw mountError(
      GITEE_REASONS.CONFIG_INVALID,
      `gitee 配置不合法：${result.issues.join('; ')}`,
      { issues: result.issues },
    );
  }
  return result !== null && typeof result === 'object' && result.value !== undefined
    ? result.value
    : candidate;
}

function assertHost(ctx) {
  for (const method of HOST_METHODS) {
    if (typeof ctx?.[method] !== 'function') {
      throw mountError(
        GITEE_REASONS.HOST_UNAVAILABLE,
        `宿主缺少 ctx.${method}：gitee 插件按 fail-closed 拒绝挂载（不猜宿主能力）`,
        { missing: [`ctx.${method}`] },
      );
    }
  }
  if (typeof ctx?.tools?.register !== 'function') {
    throw mountError(
      GITEE_REASONS.HOST_UNAVAILABLE,
      '宿主缺少 ctx.tools.register：10 个工具无处注册，静默装一半比不装更危险',
      { missing: ['ctx.tools.register'] },
    );
  }
}

function assertPolicy(ctx) {
  const policy = ctx.get('policy');
  if (policy === null || policy === undefined) {
    throw mountError(
      GITEE_REASONS.POLICY_UNAVAILABLE,
      '策略服务未挂载：gitee 动作没有门禁，拒绝降级成"无策略只读"',
      { missing: ['policy'] },
    );
  }
  if (typeof policy.executeAction !== 'function') {
    throw mountError(
      GITEE_REASONS.POLICY_UNAVAILABLE,
      '策略服务没有 admission 入口（executeAction）：无法保证每次读写都过门禁与审计',
      { missing: ['policy.executeAction'] },
    );
  }
  return policy;
}

/**
 * 目录自检：只读动作必须"已登记且 enabled"。
 *
 * 这一项不是防手滑，而是把"装了插件但没配目录"变成装配期可见的失败。空目录 / 少一条 /
 * 被 `enabled: false` 关掉的目录，以前会装上一个每次调用都 `denied` 的工具面——看起来
 * 装了，其实什么都查不到；现在直接拒绝挂载并列出缺哪些动作。
 *
 * 自检面**只含 gitee 自己的三条读**（`GITEE_READ_ACTIONS`），不含并集里的 `change.read` /
 * `change.list`：默认目录是两包共用的 6 条并集，这两条属于 devops 的 dop 流程，gitee 插件不
 * 依赖它们；把它们写进自检等于让 gitee 的单装前置条件依赖另一个平台的配置。
 */
function assertReadCatalog(policy) {
  const read = typeof policy?.catalog?.get === 'function' ? (action) => policy.catalog.get(action) : () => undefined;
  const missing = GITEE_READ_ACTIONS.filter((action) => read(action)?.enabled !== true);
  if (missing.length > 0) {
    throw mountError(
      GITEE_REASONS.ACTION_UNREGISTERED,
      `策略目录缺 gitee 只读动作：${missing.join(', ')}（需在 heluo-policy 行的 config.catalog 里登记且 enabled:true）`,
      { missing },
    );
  }
}

/** 只读调用被策略拒绝时抛的错误：工具层按 `code` 映射成 `status:'denied'`。 */
function denialError(reason, message, detail) {
  const error = new Error(message);
  error.name = 'GiteeDeniedError';
  error.code = reason;
  error.denied = true;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/**
 * 快照 → 运行时配置（TECHNICAL §3.3 的"重新合并"）。
 *
 * 取的是**生效值**而不是某一层：读面只关心"最终用什么路径/超时"，层信息归页面（AC-4）。
 * `origin === 'unset'` 的键跳过——把"没有本机覆盖"当成"显式设成空"，会让默认值失去意义。
 */
function mergedRuntimeOf(snapshot) {
  const fields = snapshot !== null && typeof snapshot === 'object' ? snapshot.entries : null;
  if (fields === null || typeof fields !== 'object') return null;
  const merged = {};
  let count = 0;
  for (const field of GITEE_CONFIG_KEYS) {
    const item = fields[field];
    if (item === null || typeof item !== 'object') continue;
    if (item.origin === undefined || item.origin === null || item.origin === GITEE_ORIGINS.UNSET) continue;
    const value = typeof item.path === 'string' ? item.path : item.value;
    if (value === null || value === undefined || value === '') continue;
    merged[field] = value;
    count += 1;
  }
  return count === 0 ? null : Object.freeze(merged);
}

/**
 * 快照 → 运行时配置，**非法配置一律失败**（fail-closed）。
 *
 * `validateGiteeConfig()` 只要有一项不合法就整层不返回 `value`，`buildSnapshot()` 的
 * `entries[*].value` 于是退化成内置默认值。若拿这份"全默认投影"去重建读面，一个非法的
 * `timeoutMs` 就能把继承层的 `persistentToken: 'block'` 悄悄洗成默认的 `'warn'`——配置错的
 * 后果被隐藏，安全策略反而被放宽。这里把"配置非法"直接当装配失败：宁可关掉读面（可见
 * `GITEE_REBUILD_FAILED`），也不接受一份没有效力的配置。
 */
function runtimeConfigOf(snapshot) {
  if (snapshot !== null && typeof snapshot === 'object' && snapshot.reason === GITEE_REASONS.CONFIG_INVALID) {
    throw mountError(
      GITEE_REASONS.CONFIG_INVALID,
      `gitee 配置不合法 · 请到「${GITEE_PAGE_HINT}」修正后刷新`,
      { next: GITEE_PAGE_HINT },
    );
  }
  return mergedRuntimeOf(snapshot);
}

/**
 * 装配面（TECHNICAL §3.3）：一次 `buildFaces()` 产出一份**可整体替换**的读面。
 *
 * 五个依赖里除了 `policy` 都与配置有关：`cliPath` / `host` / `timeoutMs` / `authEnv` /
 * `persistentToken` 变了，就必须重新构造 runner 与两个适配器。`service` 是 `provide` 出去的
 * 稳定对象、不能换，所以 service 一律经 `current()` 取值——**不许**在 `apply` 顶部解构这五个
 * 变量：解构出来的引用会永远指向装配那一刻的旧配置，AC-9 的"保存后立刻生效"就是这样失效的。
 */
function buildFaces({ policy, resolved }) {
  const runner = createGiteeRunner({
    env: process.env,
    timeoutMs: resolved.timeoutMs,
    // 用配置里的凭据变量名做脱敏（不是默认那一个）：换了 authEnv 也照样抹掉输出里的令牌。
    authEnv: resolved.authEnv,
    // 落盘凭据的处置策略归配置层（缺省 'warn'）：'block' 只留给合规场景。
    persistentTokenPolicy: resolved.persistentToken,
  });
  let git;
  try {
    // git 与 gitee CLI 共用同一个出口：适配器只要 runner（`runGit`），不自己起子进程。
    // 这里的 cwd 只是**兜底**：每次调用由 `resolveGitCwd` 现算会话工作目录并覆盖它。
    // 宿主进程的 cwd 是启动目录（npx 目录、快捷方式、家目录都可能），不能当仓库用。
    git = createGiteeGitAdapter({ runner, cwd: resolved.gitCwd });
  } catch (error) {
    throw mountError(
      GITEE_REASONS.TOOLS_UNAVAILABLE,
      `gitee git 命令面无法装配：${error?.message ?? error}`,
      { error },
    );
  }
  const adapter = createGiteeAdapter({
    runner,
    cliPath: resolved.cliPath,
    host: resolved.host,
    authEnv: resolved.authEnv,
    env: process.env,
    // 落盘凭据自检（AC-22）在装配期注入：CLI 配置目录里有持久令牌时动作层必须阻断，
    // 而不是只靠适配器单测覆盖。
    persistentTokenProbe: () => detectPersistentToken({ env: process.env }).blocked,
    persistentTokenPolicy: resolved.persistentToken,
  });
  const guard = createGiteeGuard({ policy });
  return Object.freeze({ resolved, runner, adapter, guard, git });
}

/**
 * @param {object} options
 * @param {object} options.ctx 宿主上下文
 * @param {object} options.policy 策略服务
 * @param {() => object|null} options.current 当前读面（`null` = 已降级，调用一律 fail-closed）
 * @param {object} options.session 幂等台账（与配置无关，装配期建一次）
 * @param {object} options.access `createGiteeAccess()` 的返回值
 * @param {() => string} options.routeOf 路由状态（`registered` / `no-webserver` / `conflict`）
 * @param {(options:{refresh:boolean}) => object} options.refreshSnapshot 重建读面并回快照
 */
function createService({ ctx, policy, current, session, access, routeOf, refreshSnapshot }) {
  let status = 'ready';
  let callSeq = 0;
  const nextCallId = (kind) => {
    callSeq += 1;
    return `gitee-${kind}-${callSeq}`;
  };

  /** 取当前读面；已降级时给可见错误，而不是拿旧配置继续跑（那是伪证据）。 */
  function live() {
    const faces = current();
    if (faces === null) {
      throw denialError(
        GITEE_REASONS.REBUILD_FAILED,
        'Gitee 读面不可用：配置已保存但重建失败，请修正配置后刷新',
      );
    }
    return faces;
  }

  /**
   * 代码版本快照（只读，PR #215 复审 P1）：runner 必须取**当前**读面——`buildFaces()` 每次
   * 重建都会换一份，装配期缓存一份会让保存后的快照仍走旧配置；读面被降级时如实报不可用，
   * 不去猜目录、也不拿旧读面凑版本。
   */
  async function snapshot(directory) {
    const unavailable = Object.freeze({
      status: 'failed',
      reason: SNAPSHOT_REASONS.NO_WORKSPACE,
      message: 'Gitee 读面不可用：不生成代码版本',
      next: '到「设置 → Gitee」确认配置可用后重试。',
      observedAt: Date.now(),
    });
    let face;
    try {
      face = live();
    } catch {
      return unavailable;
    }
    try {
      return await createGiteeSnapshotReader({ runner: face.runner }).read(directory);
    } catch {
      return unavailable;
    }
  }

  async function read(request = {}) {
    if (status !== 'ready') {
      throw denialError(GITEE_REASONS.STATUS_DISPOSED, 'gitee 服务已卸载，不再执行只读查询');
    }
    const { adapter } = live();
    const action = typeof request.action === 'string' ? request.action : '';
    const target = typeof request.target === 'string' ? request.target.trim() : '';
    const admitted = await policy.executeAction(
      ctx,
      action,
      { name: 'forge_gitee_read', arguments: { target }, callId: nextCallId('read') },
      async () => adapter.read(action, target, request.params),
    );
    if (admitted !== null && typeof admitted === 'object' && admitted.kind === 'error') {
      throw denialError(
        GITEE_REASONS.POLICY_DENIED,
        typeof admitted.text === 'string' && admitted.text.length > 0
          ? admitted.text
          : `策略拒绝了只读查询 ${action}`,
        { action, target },
      );
    }
    // 归一放在服务边界：无论工具定义怎么排，模型拿到的都是 AC-15 信封。
    return normalizeGiteeReadResult({ action, target, result: admitted });
  }

  function execute(request = {}) {
    if (status !== 'ready') {
      throw deniedForDisposed();
    }
    // 门禁唯一准入点：参数原样交给 guard，入口不重解释、不补默认、不重试。
    return live().guard.execute(request);
  }

  function deniedForDisposed() {
    return denialError(GITEE_REASONS.STATUS_DISPOSED, 'gitee 服务已卸载，不再执行受控动作');
  }

  return Object.freeze({
    provider: GITEE_PLATFORM,
    readActions: () => [...GITEE_READ_ACTIONS],
    toolNames: () => [...GITEE_TOOLS],
    // 只报 4 个受控写：判定（`GITEE_JUDGE_TOOLS`）是随包默认登记的只读能力，混进"写工具"
    // 会让调用方与文档口径继续对不上（AC-3）。
    writeTools: () => [...GITEE_WRITE_TOOLS],
    status: () => status,
    describe: () => access.describe().text,
    // 配置面（T1）：状态只出枚举与布尔位，快照才出值（且只经同源 GET）。
    configStatus: () => {
      const described = access.describe();
      const degraded = current() === null;
      return Object.freeze({
        ...described,
        ready: degraded ? false : described.ready,
        reason: degraded ? GITEE_REASONS.REBUILD_FAILED : described.reason,
        route: routeOf(),
      });
    },
    configSnapshot: (snapshotOptions = {}) =>
      snapshotOptions?.refresh === true ? refreshSnapshot(snapshotOptions) : access.snapshot(snapshotOptions),
    saveGiteeConfig: async (saveOptions = {}) => {
      const result = await access.save(saveOptions);
      // 保存成功 ≠ 运行时已应用（AC-8）：重建失败只降级 `applied`，不改写保存结论。
      if (result === null || typeof result !== 'object' || result.ok !== true) return result;
      try {
        refreshSnapshot({ refresh: true });
        return { ...result, applied: Object.freeze({ ok: true }) };
      } catch {
        return { ...result, applied: Object.freeze({ ok: false, reason: GITEE_REBUILD_REASON }) };
      }
    },
    preflight: () => live().adapter.preflight(),
    read,
    // 工具层只拿 `snapshot(cwd)`；容器（runner）由服务自己按当前读面取，永不外泄。
    snapshot: (directory) => snapshot(directory),
    execute,
    write: execute,
    invoke: (command, params, purpose) => live().adapter.invoke(command, params, purpose),
    adapter: () => live().adapter,
    // 本地 git 命令面：工具层只拿端口（`git().commit()` / `git().push()`），永不直接持有
    // runner；push 的准入仍由 `guard.execute` 按动作 `gitee.git.push` 裁决。
    git: () => live().git,
    guard: () => live().guard,
    session: () => session,
    dispose: () => {
      if (status === 'ready') status = 'disposed';
    },
  });
}

/**
 * 挂载 gitee 插件。
 *
 * @param {object} ctx 宿主上下文（cordis）
 * @param {object} [rawConfig] 配置（补丁层省略时宿主传 `undefined`）
 * @returns {() => void} 卸载函数（同时登记在 `ctx.effect` 上）
 */
export function apply(ctx, rawConfig = {}) {
  const config = validateConfig(rawConfig);
  assertHost(ctx);
  const policy = assertPolicy(ctx);
  assertReadCatalog(policy);

  // 解析只做"读配置 + 读环境变量"，不起子进程、不回显凭据内容。
  const resolved = resolveGiteeConfig({ config, env: process.env });

  // 配置面（T1）：`configEditor` 是可选服务——没有它也能读，只是不可写（页面降级为只读）。
  const configEditor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
  const access = createGiteeAccess({
    config,
    env: process.env,
    configEditor: configEditor === null || typeof configEditor !== 'object' ? null : configEditor,
    entryId: GITEE_ENTRY_ID,
  });

  /**
   * 装配期读面：**必须**从 `access` 的合并态算起，不能直接用 loader 交给 `apply` 的那份
   * `config`——那是补丁行自己的 `config:`，公共参数层（bundle 层）与本机覆盖层都在
   * `configEditor` 里。只读 `config` 会让"页面上明明配了路径"在运行期仍走默认值（AC-9）。
   */
  // 生效层非法时这里就抛出 `GITEE_CONFIG_INVALID`：装上了却用默认值跑，是更坏的失败。
  const initialConfig = runtimeConfigOf(access.snapshot()) ?? config;
  let faces = buildFaces({
    policy,
    resolved: initialConfig === config ? resolved : resolveGiteeConfig({ config: initialConfig, env: process.env }),
  });

  /** 重建读面：`refresh` 让 access 重读磁盘并重新合并，再重建 runner / 两个适配器 / 门禁。 */
  function rebuildFaces() {
    const merged = runtimeConfigOf(access.snapshot({ refresh: true }));
    const next = resolveGiteeConfig({ config: merged ?? {}, env: process.env });
    const previous = faces;
    faces = buildFaces({ policy, resolved: next });
    return previous;
  }

  /** 重建失败的**明确不可用**态：不保留"上次看起来还行"的旧读面、不猜路径。 */
  function degradeFaces() {
    faces = null;
  }

  /**
   * 刷新单点（AC-9）：`?refresh=1`、`configSnapshot({refresh:true})`、保存后的重建全走这里。
   * 重建成功才回快照；失败则降级并抛出，由调用方决定是 503 还是 `applied.ok=false`。
   */
  function refreshSnapshot(snapshotOptions = {}) {
    if (snapshotOptions?.refresh !== true) return access.snapshot(snapshotOptions);
    try {
      rebuildFaces();
    } catch {
      degradeFaces();
      throw mountError(
        GITEE_REASONS.REBUILD_FAILED,
        `刷新失败 · 请到「${GITEE_PAGE_HINT}」重试`,
        { reason: GITEE_REBUILD_REASON, next: GITEE_PAGE_HINT },
      );
    }
    // 响应读的是重建后的合并态：与随后工具调用看到的是同一份。
    return access.snapshot();
  }

  /**
   * 按次解析 git 的仓库目录：取**调用方会话**的工作目录，而不是宿主进程目录。
   *
   * 用 `get(agent.session)` 而不是 `ensure(agent)`：`ensure()` 会写会话事件（目录被删时还会
   * 触发恢复并 append `working-directory/change`），一个只读的路径解析不该有副作用。
   * `ctx.workingDirectory` 是可选服务，任一环拿不到就返回 `undefined` 让适配器兜底，绝不猜目录。
   */
  const resolveGitCwd = async (exec) => {
    const agent = exec?.agent;
    if (!agent || agent.session === undefined || agent.session === null) return undefined;
    const directories = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
    if (directories === null || typeof directories !== 'object') return undefined;
    if (typeof directories.get !== 'function') return undefined;
    const dir = directories.get(agent.session);
    return typeof dir === 'string' && dir.trim() !== '' ? dir : undefined;
  };
  const session = createGiteeSession();
  // 路由状态必须在 service 之前声明：`configStatus()` 经闭包读它，而路由要到 provide 之后才挂。
  let routeState = 'no-webserver';

  const service = createService({
    ctx,
    policy,
    current: () => faces,
    session,
    access,
    routeOf: () => routeState,
    refreshSnapshot,
  });

  let tools;
  try {
    tools = buildGiteeTools(service, { resolveGitCwd });
  } catch (error) {
    throw mountError(
      GITEE_REASONS.TOOLS_UNAVAILABLE,
      `gitee 工具面无法组装：${error?.message ?? error}`,
      { error },
    );
  }

  /**
   * `ADAPTER_KEY` 给的是**稳定门面**，不是某一版适配器：读面换页后消费者不能继续拿旧
   * `cliPath`。六个成员与 `createGiteeAdapter()` 的端口一一对应，全部转发到当前读面。
   */
  const adapterFacade = Object.freeze({
    provider: GITEE_PLATFORM,
    logicalName: faces.adapter.logicalName,
    preflight: () => service.preflight(),
    invoke: (command, params, purpose) => service.invoke(command, params, purpose),
    read: (action, target, params) => service.adapter().read(action, target, params),
    describe: () => service.adapter().describe(),
  });

  const disposeService = ctx.provide(SERVICE_KEY, service);
  let disposeAdapter;
  try {
    disposeAdapter = ctx.provide(ADAPTER_KEY, adapterFacade);
  } catch (error) {
    disposeService?.();
    throw mountError(GITEE_REASONS.TOOLS_UNAVAILABLE, `gitee 适配器无法提供服务：${error?.message ?? error}`, { error });
  }

  const disposers = [];
  try {
    for (const definition of tools) {
      disposers.push(ctx.tools.register(definition));
    }
  } catch (error) {
    // 半挂载比不挂载更难查：撤掉已经注册的工具与服务，再把原因抛出去。
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
    disposeAdapter?.();
    disposeService?.();
    throw mountError(
      GITEE_REASONS.TOOLS_UNAVAILABLE,
      `gitee 工具注册失败：${error?.message ?? error}`,
      { error },
    );
  }

  /**
   * 同源配置端点（TECHNICAL §3.2）：`webServer` 是可选服务——没有就保持 `no-webserver`
   * （页面按"不可用"降级），**不**因此拒绝挂载工具面。注册冲突同理只影响页面。
   */
  const giteeApi = createGiteeApi({
    // 端点走 service 的保存端口，而不是 `access.save`：只有 service 知道"写成功后要重建读面"，
    // 也才有 `applied` 可透传（AC-8：保存 / 应用 / 检查是三个独立结论）。
    access: {
      revision: () => access.revision(),
      snapshot: (request) => access.snapshot(request),
      describe: () => access.describe(),
      save: (options) => service.saveGiteeConfig(options),
    },
    snapshot: (request) => refreshSnapshot({ refresh: request?.refresh === true }),
  });
  const giteeRoute = toNodeRoute(giteeApi);
  let disposeRoute = null;
  let routeMounted = false;
  function mountConfigRoute(scope) {
    if (routeMounted) return;
    const server = (scope ?? ctx)?.get?.('webServer');
    if (server === null || server === undefined || typeof server.register !== 'function') {
      routeState = 'no-webserver';
      return;
    }
    routeMounted = true;
    try {
      disposeRoute = server.register({
        kind: 'prefix',
        path: GITEE_API_PREFIX,
        handler: giteeRoute,
        description: 'Gitee 配置面（同源读写）',
      }) ?? null;
      routeState = 'registered';
    } catch {
      // 另一条补丁层已经占了这个前缀：页面不可用，但工具面照常。
      routeState = 'conflict';
    }
  }
  mountConfigRoute(ctx);
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (host) => mountConfigRoute(host));
  }

  let disposed = false;
  const teardown = () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
    disposeRoute?.();
    disposeAdapter?.();
    disposeService?.();
    service.dispose();
  };
  ctx.effect(() => teardown);
  return teardown;
}

/**
 * 公共符号再导出（TECHNICAL §3：入口同时是契约面）。
 *
 * 用 `export *` 而不是逐个列举：装配层不该因为上游**多导出**一个符号而链接失败，也不该因为
 * 某个库函数改名就整体不可加载；每个符号自身的形状由所属模块的契约测试（`test/*.test.mjs`）
 * 负责。入口自己声明的名字（`name`/`inject`/`Config`/`apply`/`GITEE_REASONS`/服务键等）
 * 是显式导出，始终优先于星号导出。
 */
export * from './runtime-config.mjs';
export * from './config-access.mjs';
export * from './http.mjs';
export * from './gitee-cli.mjs';
export * from './gitee-git.mjs';
export * from './gitee-adapter.mjs';
export * from './gitee-read.mjs';
export * from './gitee-guard.mjs';
export * from './gitee-session.mjs';
export * from './gitee-actions.mjs';
export * from './gitee-snapshot.mjs';
export * from './gitee-tools.mjs';
