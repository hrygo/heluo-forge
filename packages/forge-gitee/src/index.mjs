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
import { createGiteeAdapter } from './gitee-adapter.mjs';
import { createGiteeRunner, detectPersistentToken } from './gitee-cli.mjs';
import { createGiteeGitAdapter } from './gitee-git.mjs';
import { GITEE_PLATFORM, createGiteeGuard } from './gitee-guard.mjs';
import { GITEE_READ_ACTIONS, normalizeGiteeReadResult } from './gitee-read.mjs';
import { createGiteeSession } from './gitee-session.mjs';
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

function createService({ ctx, policy, adapter, gitAdapter, guard, session, config }) {
  let status = 'ready';
  let callSeq = 0;
  const nextCallId = (kind) => {
    callSeq += 1;
    return `gitee-${kind}-${callSeq}`;
  };

  async function read(request = {}) {
    if (status !== 'ready') {
      throw denialError(GITEE_REASONS.STATUS_DISPOSED, 'gitee 服务已卸载，不再执行只读查询');
    }
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
    return guard.execute(request);
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
    describe: () => describeGiteeConfig(config),
    preflight: () => adapter.preflight(),
    read,
    execute,
    write: execute,
    invoke: (command, params, purpose) => adapter.invoke(command, params, purpose),
    adapter: () => adapter,
    // 本地 git 命令面：工具层只拿端口（`git().commit()` / `git().push()`），永不直接持有
    // runner；push 的准入仍由 `guard.execute` 按动作 `gitee.git.push` 裁决。
    git: () => gitAdapter,
    guard: () => guard,
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
  const runner = createGiteeRunner({
    env: process.env,
    timeoutMs: resolved.timeoutMs,
    // 用配置里的凭据变量名做脱敏（不是默认那一个）：换了 authEnv 也照样抹掉输出里的令牌。
    authEnv: resolved.authEnv,
    // 落盘凭据的处置策略归配置层（缺省 'warn'）：'block' 只留给合规场景。
    persistentTokenPolicy: resolved.persistentToken,
  });
  let gitAdapter;
  try {
    // git 与 gitee CLI 共用同一个出口：适配器只要 runner（`runGit`），不自己起子进程。
    // 这里的 cwd 只是**兜底**：每次调用由 `resolveGitCwd` 现算会话工作目录并覆盖它。
    // 宿主进程的 cwd 是启动目录（npx 目录、快捷方式、家目录都可能），不能当仓库用。
    gitAdapter = createGiteeGitAdapter({ runner, cwd: resolved.gitCwd });
  } catch (error) {
    throw mountError(
      GITEE_REASONS.TOOLS_UNAVAILABLE,
      `gitee git 命令面无法装配：${error?.message ?? error}`,
      { error },
    );
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
  const session = createGiteeSession();

  const service = createService({ ctx, policy, adapter, gitAdapter, guard, session, config });

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

  const disposeService = ctx.provide(SERVICE_KEY, service);
  let disposeAdapter;
  try {
    disposeAdapter = ctx.provide(ADAPTER_KEY, adapter);
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

  let disposed = false;
  const teardown = () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.splice(0).reverse()) dispose?.();
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
export * from './gitee-cli.mjs';
export * from './gitee-git.mjs';
export * from './gitee-adapter.mjs';
export * from './gitee-read.mjs';
export * from './gitee-guard.mjs';
export * from './gitee-session.mjs';
export * from './gitee-actions.mjs';
export * from './gitee-tools.mjs';
