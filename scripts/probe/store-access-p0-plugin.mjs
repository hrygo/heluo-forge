/**
 * 步骤 0 P0 探针插件：IAM 存档访问的宿主事件面取证。
 *
 * 只验证 `tools/pre-execute` 这一个 seam：在宿主自己的工具管线上注册一个
 * 「存档访问 → 拒绝」的监听器，派发真实内建工具（read / bash），记录
 * 拒绝是否生效、工具体是否零执行、SQLite 库是否未被改动。
 *
 * 本插件不实现 forge-policy 的任何逻辑，也不依赖 policy 包：它用与方案
 * 步骤 1 相同形状的最小判定，证明「宿主层面拒得住」与「拒绝发生在执行前」。
 *
 * `DSH_HOST_PROBE_NO_JUDGE=1` 时不装监听器，只观察执行环境本身（P0-C 用）。
 * 结果写 DSH_HOST_PROBE_OUT（JSON），随后退出进程。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const name = 'forge-store-access-p0-probe';
export const inject = ['tools'];

const textOf = (result) =>
  Array.isArray(result?.content) ? result.content.map((part) => part?.text ?? '').join(' ').trim() : '';

const STORE_CODE = 'POLICY_STORE_ACCESS_DENIED';
const TOKEN_CODE = 'POLICY_IAM_TOKEN_DENIED';

function probeTool(toolName, body) {
  return {
    name: toolName,
    description: `probe tool ${toolName}`,
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: body,
  };
}

export function apply(ctx) {
  const dir = process.env.DSH_HOST_PROBE_DIR ?? process.cwd();
  const out = process.env.DSH_HOST_PROBE_OUT ?? join(dir, 'probe-raw.json');
  const env = JSON.parse(process.env.DSH_HOST_PROBE_STORE ?? '{}');
  const storeDir = env.storeDir;
  const dbPath = env.dbPath;
  const sentinel = join(dir, 'store-probe-sentinel.txt');
  mkdirSync(dir, { recursive: true });

  const judge = process.env.DSH_HOST_PROBE_NO_JUDGE !== '1';
  const mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write';
  const checks = [];
  const observations = [];
  const blocked = [];
  const step = async (id, run) => {
    try {
      const { ok, detail } = await run();
      checks.push({ id, ok: ok === true, detail });
    } catch (error) {
      checks.push({ id, ok: false, detail: { threw: String(error?.message ?? error) } });
    }
  };

  const state = () => {
    try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const version = db.prepare('PRAGMA data_version').get();
      const rows = db.prepare('SELECT ref, value FROM records ORDER BY ref').all();
      const future = db.prepare('SELECT COUNT(*) AS n FROM future_table').get();
      return { dataVersion: version?.data_version, rows, futureRows: future?.n };
    } finally {
      db.close();
    }
    } catch (error) {
      return { unreadable: String(error?.message ?? error) };
    }
  };

  /** 与方案步骤 1 同形状的最小判定：路径命中存档根，或命令文本点名存档/取票。 */
  const decide = (exec) => {
    const args = exec?.arguments ?? {};
    const underStore = (value) => typeof value === 'string' && (value.includes(storeDir) || value.includes(dbPath));
    if (exec?.name === 'read' || exec?.name === 'write' || exec?.name === 'edit') {
      if (underStore(args.file_path)) return { kind: 'deny', reason: 'probe: store 文件不在 Agent 可读范围', code: STORE_CODE };
    }
    if (exec?.name === 'probe_store_body') {
      return { kind: 'deny', reason: 'probe: 登记工具工具体不得执行', code: STORE_CODE };
    }
    if (exec?.name === 'bash' || exec?.name === 'terminal_send') {
      const text = String(args.command ?? args.text ?? '');
      if (text.includes(storeDir) || text.includes('credentials.sqlite') || text.includes('keyring.json')) {
        return { kind: 'deny', reason: 'probe: 命令点名 IAM 存档', code: STORE_CODE };
      }
      if (/\bauth\s+token\b/u.test(text)) return { kind: 'deny', reason: 'probe: Agent 不得直接取票', code: TOKEN_CODE };
    }
    return undefined;
  };

  const main = async () => {
    const signal = new AbortController().signal;
    let seq = 0;
    const dispatchOnce = async (toolName, args) => {
      seq += 1;
      const result = await ctx.tools.execute({ callId: `p0-${seq}`, name: toolName, arguments: args, signal });
      return { isError: result?.isError === true, text: textOf(result), error: result?.error };
    };
    // 插件 apply 早于工具注册完成时首个调用会命中 unknown tool，重试到可见为止。
    const dispatch = async (toolName, args) => {
      let last;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        last = await dispatchOnce(toolName, args);
        if (!/unknown tool/i.test(last.text)) return last;
        await new Promise((done) => setTimeout(done, 500));
      }
      return last;
    };

    const disposers = [];
    let denials = 0;
    if (judge) {
      disposers.push(
        ctx.on('tools/pre-execute', (exec, next) => {
          const verdict = decide(exec);
          if (verdict !== undefined) denials += 1;
          return verdict ?? next();
        }),
      );
    }
    disposers.push(
      ctx.tools.register(
        probeTool('probe_store_body', () => {
          writeFileSync(sentinel, 'body executed\n');
          return { text: 'body ran' };
        }),
      ),
    );

    const before = state();
    const canary = before.rows.find((row) => row.ref === 'canary')?.value;

    if (judge) {
      // D1 直接读库文件：拒绝，且结果不含 canary 明文。
      await step('deny-read-store-db', async () => {
        const r = await dispatch('read', { file_path: dbPath });
        return {
          ok: r.isError && r.text.includes('store 文件不在 Agent 可读范围') && !r.text.includes(String(canary)),
          detail: { isError: r.isError, error: r.error, textHasCanary: r.text.includes(String(canary)), text: r.text.slice(0, 160) },
        };
      });

      // D2 读密钥目录文件。
      await step('deny-read-keyring', async () => {
        const r = await dispatch('read', { file_path: join(env.keyDir, 'keyring.json') });
        return { ok: r.isError && r.text.includes('store 文件不在 Agent 可读范围'), detail: { isError: r.isError, error: r.error, text: r.text.slice(0, 120) } };
      });

      // D2b 写入存档：拒绝，且文件未被创建。
      await step('deny-write-store-file', async () => {
        const target = join(storeDir, 'credentials.sqlite.abandoned.1.probe');
        const r = await dispatch('write', { file_path: target, content: 'probe' });
        return { ok: r.isError === true && r.text.includes('store 文件不在 Agent 可读范围') && !existsSync(target), detail: { isError: r.isError, error: r.error, fileCreated: existsSync(target) } };
      });

      // D2c 编辑存档：拒绝。
      await step('deny-edit-store-file', async () => {
        const r = await dispatch('edit', { file_path: dbPath, old_string: 'canary', new_string: 'tampered' });
        return { ok: r.isError === true && r.text.includes('store 文件不在 Agent 可读范围'), detail: { isError: r.isError, error: r.error } };
      });

      // D3 sqlite3 查询：拒绝。
      await step('deny-bash-sqlite-select', async () => {
        const r = await dispatch('bash', { command: `sqlite3 ${dbPath} "select ref, value from records"`, description: 'probe store read' });
        return { ok: r.isError && r.text.includes('命令点名 IAM 存档'), detail: { isError: r.isError, error: r.error, text: r.text.slice(0, 160) } };
      });

      // D3b 新增表同样受限：仍按存档文件判定，不依赖表名。
      await step('deny-bash-sqlite-future-table', async () => {
        const r = await dispatch('bash', { command: `sqlite3 ${dbPath} "select * from future_table"`, description: 'probe new table' });
        return { ok: r.isError === true && r.text.includes('命令点名 IAM 存档'), detail: { isError: r.isError, error: r.error } };
      });

      // D4 sqlite3 改写：拒绝，且库内容未变。
      await step('deny-bash-sqlite-write-keeps-data', async () => {
        const r = await dispatch('bash', { command: `sqlite3 ${dbPath} "update records set value = 'tampered' where ref = 'canary'"`, description: 'probe store write' });
        const after = state();
        return {
          ok: r.isError && r.text.includes('命令点名 IAM 存档') && JSON.stringify(after.rows) === JSON.stringify(before.rows) && after.dataVersion === before.dataVersion,
          detail: { isError: r.isError, error: r.error, rowsUnchanged: JSON.stringify(after.rows) === JSON.stringify(before.rows), dataVersionUnchanged: after.dataVersion === before.dataVersion },
        };
      });

      // D5 删除：拒绝。
      await step('deny-bash-remove-store', async () => {
        const r = await dispatch('bash', { command: `rm -rf ${storeDir}`, description: 'probe store remove' });
        return { ok: r.isError && r.text.includes('命令点名 IAM 存档') && existsSync(dbPath), detail: { isError: r.isError, error: r.error, dbStillThere: existsSync(dbPath) } };
      });

      // D6 取票：拒绝，且 CLI 包装脚本未被调用（哨兵文件未生成）。
      await step('deny-auth-token-before-cli', async () => {
        const r = await dispatch('bash', { command: `sh -c 'echo cli-ran > ${sentinel}; heluo-forge auth token'`, description: 'probe token' });
        return { ok: r.isError && r.text.includes('Agent 不得直接取票') && !existsSync(sentinel), detail: { isError: r.isError, error: r.error, cliRan: existsSync(sentinel) } };
      });

      // D7 含正文的登记工具在被拒时同样零执行。
      await step('deny-registered-tool-zero-execution', async () => {
        const r = await dispatch('probe_store_body', {});
        return { ok: r.isError === true && !existsSync(sentinel), detail: { isError: r.isError, bodyRan: existsSync(sentinel), text: r.text.slice(0, 120) } };
      });

      // D7b terminal_send 也经过前置判定：用不存在的会话即可，判定先于执行。
      await step('deny-terminal-send-store', async () => {
        const r = await dispatch('terminal_send', { sessionId: 'p0-no-session', text: `sqlite3 ${dbPath} "select * from records"` });
        return {
          ok: r.isError && r.text.includes('命令点名 IAM 存档'),
          detail: { isError: r.isError, error: r.error, text: r.text.slice(0, 160) },
        };
      });

      // D7c run_code 的覆盖情况要有明确结论：被拒绝、未注册、或（未覆盖）被执行。
      await step('run-code-coverage', async () => {
        const r = await dispatch('run_code', { code: `const r = await tools.execute({name:'read', arguments:{file_path:${JSON.stringify(dbPath)}}}); return r;` });
        const unregistered = r.isError === true && /unknown tool|not found|未注册/iu.test(r.text) && !r.text.includes('命令点名') && !r.text.includes('store 文件');
        if (unregistered) return { ok: true, detail: { available: false, text: r.text.slice(0, 120) } };
        const denied = r.isError === true && (r.text.includes('store 文件不在 Agent 可读范围') || r.text.includes('命令点名 IAM 存档'));
        return { ok: denied, detail: { available: true, denied, isError: r.isError, text: r.text.slice(0, 160), canaryLeaked: r.text.includes(String(canary)) } };
      });

      // D8 根外读取仍放行：证明判定范围收窄在存档根，不是全局禁读。
      await step('allow-read-outside-store', async () => {
        const r = await dispatch('read', { file_path: join(dir, 'outside.txt') });
        return { ok: r.isError !== true && r.text.includes('outside-ok'), detail: { isError: r.isError, text: r.text.slice(0, 80) } };
      });

      // D9 根外命令仍执行。
      await step('allow-bash-outside-store', async () => {
        const r = await dispatch('bash', { command: 'echo outside-ok', description: 'probe outside' });
        return { ok: r.isError !== true && r.text.includes('outside-ok'), detail: { isError: r.isError, text: r.text.slice(0, 80) } };
      });


    }

    // O1 执行环境本身（P0-C）：不装判定，观察三种权限模式下沙箱对存档与工作区读/写的结果。
    // 用 bash 发起，才能把「工具层策略」与「执行环境限制」区分开。
    if (!judge) {
      const sh = (command) => dispatch('bash', { command, description: 'p0 sandbox observation' });
      const storeText = join(storeDir, 'index-state.json');
      const writeStore = join(storeDir, 'sandbox-write-probe.txt');
      const writeWs = join(dir, 'workspace', 'written.txt');
      const q1 = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
      const observe = async (id, fn, probe) => {
        const r = await fn();
        observations.push({ id, mode, isError: r.isError, text: r.text.slice(0, 160), ...(probe?.(r) ?? {}) });
      };
      await observe(
        'sandbox-read-store-text',
        () => sh(`cat ${q1(storeText)}`),
        (r) => ({ textHasIndex: r.text.includes('synthetic-index') }),
      );
      await observe(
        'sandbox-read-store-binary',
        () => dispatch('read', { file_path: dbPath }),
        (r) => ({ refusedBinary: r.text.includes('binary file'), canaryLeaked: r.text.includes('canary-record-value') }),
      );
      await observe(
        'sandbox-bash-sqlite-read',
        () => sh(`sqlite3 ${q1(dbPath)} "select value from records where ref='canary'"`),
        (r) => ({ canaryLeaked: r.text.includes('canary-record-value') }),
      );
      await observe(
        'sandbox-write-store',
        () => sh(`printf probe > ${q1(writeStore)}`),
        () => ({ fileCreated: existsSync(writeStore) }),
      );
      await observe(
        'sandbox-write-workspace',
        () => sh(`printf probe > ${q1(writeWs)}`),
        () => ({ fileCreated: existsSync(writeWs) }),
      );
      await observe(
        'sandbox-read-workspace',
        () => sh(`cat ${q1(join(dir, 'workspace', 'inside.txt'))}`),
        (r) => ({ textHasInside: r.text.includes('inside-ok') }),
      );
      await observe(
        'sandbox-read-outside',
        () => sh(`cat ${q1(join(dir, 'outside.txt'))}`),
        (r) => ({ textHasOutside: r.text.includes('outside-ok') }),
      );
    }

    // D10 结清：库内容、行数与 data_version 全程不变。
    if (judge) await step('store-unchanged-after-denials', async () => {
      const after = state();
      return {
        ok: JSON.stringify(after.rows) === JSON.stringify(before.rows) && after.futureRows === before.futureRows && after.dataVersion === before.dataVersion,
        detail: { before, after },
      };
    });

    for (const dispose of disposers) dispose();

    const report = {
      probe: 'store-access-p0',
      harness: process.env.DSH_HOST_PROBE_HARNESS ?? 'unknown',
      env: { node: process.version, platform: `${process.platform}-${process.arch}`, mode, judge },
      store: { storeDir, dbPath, keyDir: env.keyDir },
      denials,
      observations,
      checks,
      blocked,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).length,
      crashed: undefined,
    };
    writeFileSync(out, JSON.stringify(report, null, 2));
    setTimeout(() => process.exit(report.failed === 0 && report.crashed === undefined ? 0 : 1), 50);
  };

  const started = main();
  started.catch((error) => {
    writeFileSync(out, JSON.stringify({ probe: 'store-access-p0', crashed: String(error?.stack ?? error) }, null, 2));
    setTimeout(() => process.exit(1), 50);
  });
}
