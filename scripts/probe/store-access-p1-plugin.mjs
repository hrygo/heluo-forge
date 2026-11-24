/**
 * 步骤 0 P1 探针插件：企业装配下的 IAM 存档/取票拦截取证。
 *
 * 与 P0 探针不同，本插件**不实现判定**：它只通过 `ctx.tools.execute` 派发真实
 * 内建工具，由补丁层挂载的 `@heluo/forge-policy`（`denyIamStoreAccess` /
 * `denyIamTokenAccess` 全开）与 `@heluo/forge-credentials-keychain`（提供
 * `credentials-store-location`）完成拦截，验证的是真实装配而不是夹具。
 *
 * 结果写 `DSH_HOST_PROBE_OUT`（JSON），随后退出进程。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const name = 'forge-store-access-p1-probe';
export const inject = ['tools', 'policy'];

const textOf = (result) =>
  Array.isArray(result?.content) ? result.content.map((part) => part?.text ?? '').join(' ').trim() : '';

const DENY_STORE = /凭据存档/u;
const DENY_TOKEN = /IAM 取票|auth token/u;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function apply(ctx) {
  const dir = process.env.DSH_HOST_PROBE_DIR ?? process.cwd();
  const out = process.env.DSH_HOST_PROBE_OUT ?? join(dir, 'probe-raw.json');
  const env = JSON.parse(process.env.DSH_HOST_PROBE_STORE ?? '{}');
  const { storeDir, dbPath, keyDir } = env;
  const label = process.env.DSH_HOST_PROBE_LABEL ?? 'unknown';
  mkdirSync(dir, { recursive: true });

  const checks = [];
  const step = async (id, run) => {
    try {
      const { ok, detail } = await run();
      checks.push({ id, ok: ok === true, detail });
    } catch (error) {
      checks.push({ id, ok: false, detail: { threw: String(error?.message ?? error) } });
    }
  };

  const state = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('select id, value from probe_canary order by id').all();
      const version = db.prepare('pragma data_version').get();
      return { rows, dataVersion: version?.data_version };
    } finally {
      db.close();
    }
  };

  const dispatch = async (name, args) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await ctx.tools.execute({
        callId: `p1-${name}-${attempt}-${Math.random().toString(16).slice(2)}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
      });
      const text = textOf(result);
      if (result?.isError === true && /unknown tool|not found/iu.test(text)) {
        await sleep(500);
        continue;
      }
      return { isError: result?.isError === true, text };
    }
    return { isError: true, text: 'unknown tool (after retries)' };
  };

  const sh = (command) => dispatch('bash', { command, description: 'p1 probe' });

  async function main() {
    if (process.env.DSH_HOST_PROBE_EXPECT === 'closed') {
      // engineering 单装：没有内置凭据后端，规则必须保持关闭（P1-D 的反向断言）。
      const DENY = /IAM 凭据库与密钥目录只能经公开接口访问|IAM 取票/u;
      writeFileSync(join(storeDir, 'index-state.json'), '{"closed-mode":true}\n', { mode: 0o600 });
      await step('closed-policy-mounted', async () => {
        let policy;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          policy = typeof ctx.get === 'function' ? ctx.get('policy') : undefined;
          if (policy !== undefined) break;
          await sleep(100);
        }
        return { ok: policy !== undefined, detail: { mounted: policy !== undefined } };
      });
      await step('closed-store-read-allowed', async () => {
        const result = await dispatch('read', { file_path: join(storeDir, 'index-state.json') });
        return { ok: result.isError === false && DENY.test(result.text) === false, detail: { text: result.text.slice(0, 120) } };
      });
      await step('closed-bash-store-allowed', async () => {
        const result = await sh(`cat '${join(storeDir, 'index-state.json')}'`);
        return { ok: result.isError === false && DENY.test(result.text) === false, detail: { text: result.text.slice(0, 120) } };
      });
      await step('closed-token-allowed', async () => {
        const result = await sh('heluo-forge auth token');
        return { ok: DENY.test(result.text) === false, detail: { text: result.text.slice(0, 120) } };
      });
      finish();
      return;
    }

    if (process.env.DSH_HOST_PROBE_EXPECT === 'fingerprint') {
      // 无内置凭据后端（engineering 单装、或 keychain 被禁用）时的兜底：按文件名/目录名指纹拒绝。
      const DENY = /IAM 凭据库与密钥目录只能经公开接口访问/u;
      await step('fingerprint-read-store-db', async () => {
        const result = await dispatch('read', { file_path: dbPath });
        return { ok: result.isError === true && DENY.test(result.text), detail: { text: result.text.slice(0, 160) } };
      });
      await step('fingerprint-bash-sqlite', async () => {
        const result = await sh(`sqlite3 '${dbPath}' 'select 1'`);
        return { ok: result.isError === true && DENY.test(result.text), detail: { text: result.text.slice(0, 160) } };
      });
      await step('fingerprint-read-outside-allowed', async () => {
        const result = await dispatch('read', { file_path: join(dir, 'outside.txt') });
        return { ok: result.isError === false && result.text.includes('outside-ok'), detail: { text: result.text.slice(0, 120) } };
      });
      await step('fingerprint-no-store-created', async () => ({
        ok: existsSync(dbPath) === false,
        detail: { dbExists: existsSync(dbPath) },
      }));
      finish();
      return;
    }

    // 合成 canary：库由 keychain 打开（惰性建库），这里只加一张与凭据无关的测试表。
    const setup = new DatabaseSync(dbPath);
    setup.exec('create table if not exists probe_canary (id integer primary key, value text not null)');
    setup.exec("delete from probe_canary where id = 1");
    setup.exec("insert into probe_canary (id, value) values (1, 'p1-canary-value')");
    setup.close();
    const before = state();

    // 装配自证：policy 服务存在、两根齐备、开关已开（规则关闭时两根为空）。
    await step('assembly-policy-mounted', async () => {
      // 叠装时策略可能晚于插件装载：等服务就绪后再判定（最多 5 秒）。
      let policy;
      let roots = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        policy = typeof ctx.get === 'function' ? ctx.get('policy') : undefined;
        roots = typeof policy?.storeDirectories === 'function' ? policy.storeDirectories() : [];
        if (roots.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        ok: policy !== undefined && roots.length === 2 && roots.includes(storeDir) && roots.includes(keyDir),
        detail: { mounted: policy !== undefined, roots },
      };
    });

    await step('deny-read-store-db', async () => {
      const result = await dispatch('read', { file_path: dbPath });
      return { ok: result.isError === true && DENY_STORE.test(result.text), detail: { text: result.text.slice(0, 200) } };
    });

    await step('deny-read-keyring', async () => {
      const result = await dispatch('read', { file_path: join(keyDir, 'keyring.json') });
      return { ok: result.isError === true && DENY_STORE.test(result.text), detail: { text: result.text.slice(0, 200) } };
    });

    await step('deny-write-store-file', async () => {
      const target = join(storeDir, 'p1-written-by-tool.txt');
      const result = await dispatch('write', { file_path: target, content: 'should-not-exist' });
      return { ok: result.isError === true && !existsSync(target), detail: { text: result.text.slice(0, 200) } };
    });

    await step('deny-bash-sqlite-select', async () => {
      const result = await sh(`sqlite3 ${JSON.stringify(dbPath)} "select value from probe_canary"`);
      return {
        ok: result.isError === true && !result.text.includes('p1-canary-value'),
        detail: { text: result.text.slice(0, 200) },
      };
    });

    await step('deny-bash-cat-store', async () => {
      const result = await sh(`cat ${JSON.stringify(dbPath)}`);
      return { ok: result.isError === true, detail: { text: result.text.slice(0, 200) } };
    });

    await step('deny-glob-store', async () => {
      const result = await dispatch('glob', { pattern: '**/*.sqlite', path: storeDir });
      return { ok: result.isError === true, detail: { text: result.text.slice(0, 200) } };
    });

    await step('deny-bash-remove-store', async () => {
      const result = await sh(`rm -rf ${JSON.stringify(storeDir)}`);
      return { ok: result.isError === true && existsSync(dbPath), detail: { text: result.text.slice(0, 200) } };
    });

    await step('deny-auth-token', async () => {
      const result = await sh('heluo-forge auth token');
      const leaked = /eyJ[A-Za-z0-9_-]{8,}|access_token/iu.test(result.text);
      return { ok: result.isError === true && DENY_TOKEN.test(result.text) && !leaked, detail: { text: result.text.slice(0, 200) } };
    });

    await step('deny-auth-token-before-cli', async () => {
      // 包装脚本先写哨兵再取票：哨兵不存在，说明整条命令没有被执行（CLI 未启动）。
      const sentinel = join(storeDir, 'p1-cli-started.sentinel');
      const result = await sh(`sh -c 'touch ${sentinel}; heluo-forge auth token'`);
      const started = existsSync(sentinel);
      if (started) rmSync(sentinel, { force: true });
      return { ok: result.isError === true && DENY_TOKEN.test(result.text) && started === false, detail: { started, text: result.text.slice(0, 200) } };
    });

    await step('allow-whoami', async () => {
      const repo = process.env.DSH_HOST_PROBE_REPO;
      const cli = repo === undefined ? 'heluo-forge' : `node '${join(repo, 'packages/forge-iam/bin/heluo-forge.mjs')}'`;
      const result = await sh(`${cli} auth whoami --json`);
      // 未登录时 CLI 自身可能失败（退出码 2）；这里只要求"不是策略拒绝"。
      return { ok: !DENY_STORE.test(result.text) && !DENY_TOKEN.test(result.text), detail: { text: result.text.slice(0, 200) } };
    });

    await step('allow-read-outside', async () => {
      const result = await dispatch('read', { file_path: join(dir, 'outside.txt') });
      return { ok: result.isError === false && result.text.includes('outside-ok'), detail: { text: result.text.slice(0, 120) } };
    });

    await step('store-unchanged-after-denials', async () => {
      const after = state();
      return {
        ok: JSON.stringify(after.rows) === JSON.stringify(before.rows) && after.dataVersion === before.dataVersion,
        detail: { before, after },
      };
    });

    finish();
  }

  function finish() {
    const report = {
      probe: 'store-access-p1',
      label,
      harness: process.env.DSH_HOST_PROBE_HARNESS ?? 'unknown',
      env: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        storeEnv: process.env.HELUO_FORGE_STORE_DIRECTORY ?? null,
      },
      store: { storeDir, dbPath, keyDir },
      checks,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).length,
    };
    writeFileSync(out, JSON.stringify(report, null, 2));
    setTimeout(() => process.exit(report.failed === 0 ? 0 : 1), 50);
  }

  main().catch((error) => {
    writeFileSync(out, JSON.stringify({ probe: 'store-access-p1', label, crashed: String(error?.stack ?? error) }, null, 2));
    setTimeout(() => process.exit(1), 50);
  });
}
