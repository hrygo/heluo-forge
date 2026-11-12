#!/usr/bin/env node
/**
 * #125 A2 — real-composition probe for the single-credentials-provider rule.
 *
 * What this proves (and what it does not):
 *   - It mounts the *actual* installed `@deepseek-ai/dsh-credentials-local` and
 *     this repository's keychain plugin on a real Cordis Context, in both
 *     activation orders, against an isolated `DSH_HOME`.
 *   - It asserts the composition invariant: exactly one `credentials` owner,
 *     the plaintext file is only written when the local provider is actually
 *     mounted, and the disabled-local composition never creates it.
 *   - It does NOT prove process termination, IAM trust, native OS stores or any
 *     enterprise integration. Those are separate gates in the plan (§4.3/§5).
 *
 * Usage:
 *   node scripts/probe/run-credentials-composition-probe.mjs
 *   DSH_BIN=/path/to/dsh node scripts/probe/run-credentials-composition-probe.mjs
 *   DSH_NODE_MODULES=/path/to/node_modules node scripts/probe/run-credentials-composition-probe.mjs
 *
 * Exit codes: 0 all assertions held; 1 an assertion failed; 2 the environment
 * cannot run it (no installed SDK, wrong platform for the bundled runtime).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDshProbeHost } from '../lib/dsh-probe-runtime.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dsh = process.env.DSH_BIN ?? 'dsh';
const hostLocation = resolveDshProbeHost({ dsh, modules: process.env.DSH_NODE_MODULES });

// Vanilla Node cannot import modules inside ASAR; re-enter once with the
// installation's own runtime, preserving argv and the exit status.
if (hostLocation.runtime !== null && realpathSync(process.execPath) !== hostLocation.runtime) {
  const child = spawnSync(hostLocation.runtime, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  if (child.error) console.error(`credentials-composition: desktop runtime failed: ${child.error.message}`);
  process.exit(child.status ?? 1);
}

const work = mkdtempSync(join(tmpdir(), 'forge-credentials-composition-'));
const evidence = {
  probe: 'credentials-composition',
  scope: 'local composition invariant; NOT process termination, IAM trust or a native OS store',
  startedAt: new Date().toISOString(),
  env: { platform: `${process.platform}-${process.arch}`, node: process.version, sdkLayout: hostLocation.kind },
  steps: [],
  ok: true,
};
const record = (id, ok, detail = {}) => {
  evidence.steps.push({ id, ok, detail });
  if (!ok) evidence.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};

const home = join(work, 'dsh-home');
const legacyFile = join(home, '.credentials.yaml');
process.env.DSH_HOME = home;
delete process.env.DSH_PROFILE;
delete process.env.DSH_PROFILE_DIR;

const host = createRequire(pathToFileURL(hostLocation.anchor));
const load = async (name) => import(pathToFileURL(host.resolve(name)).href);

let Context;
let LocalProvider;
let keychain;
try {
  ({ Context } = await load('@deepseek-ai/cordis'));
  ({ default: LocalProvider } = await load('@deepseek-ai/dsh-credentials-local'));
  keychain = await import(pathToFileURL(join(repo, 'packages/forge-credentials-keychain/src/index.mjs')).href);
} catch (error) {
  console.error(`credentials-composition: cannot load the host SDK or the plugin: ${error.message}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

evidence.env.dshVersion = (() => {
  try {
    return JSON.parse(readFileSync(host.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

/** Mount a keychain provider; `backend` decides availability. */
const mountKeychain = (ctx, backend) => ctx.plugin(keychain, {
  backend,
  allowEphemeral: true,
}).await();

/**
 * Compose one case: `localFirst` is the activation order, `localEnabled`
 * mirrors what the enterprise patch decides for the official row.
 */
async function compose({ localFirst, localEnabled, backend }) {
  const ctx = new Context();
  const local = async () => { if (localEnabled) await ctx.plugin(LocalProvider, {}).await(); };
  const key = async () => { await mountKeychain(ctx, backend); };
  let error;
  try {
    if (localFirst) {
      await local();
      await key();
    } else {
      await key();
      await local();
    }
  } catch (caught) {
    // A refused second provider is a recorded outcome, not a crash.
    error = caught;
  }
  return { ctx, error };
}

const fileExists = () => existsSync(legacyFile);
const resetHome = () => { rmSync(home, { recursive: true, force: true }); };

for (const localFirst of [true, false]) {
  const order = localFirst ? 'local-first' : 'keychain-first';

  // 1. Negative control: the local row is still enabled (the pre-#125 shape).
  resetHome();
  {
    const backend = keychain.createMemoryBackend();
    const { ctx, error } = await compose({ localFirst, localEnabled: true, backend });
    const owner = ctx.get('credentials');
    // 判定 owner 之前先确认确实挂上了一个提供方：两边都挂失败时 owner 为空，
    // 写入会被 `?.` 吞掉、也不会落盘，若不先断言就会把“没挂上”记成 keychain 接管。
    const mounted = typeof owner?.describe === 'function';
    // 第二个提供方必须被拒绝：local 先挂时由 keychain 拒绝（自有错误码），
    // keychain 先挂时由 Cordis 拒绝重复注册。两种顺序都不能出现双提供方。
    const refused = localFirst
      ? error?.code === 'KEYCHAIN_CREDENTIALS_CONFLICT'
      // Cordis 拒绝重复注册时没有稳定错误码，只断言“有错误且提到 credentials 服务”；
      // 具体文案随版本变化，不匹配整句。
      : error !== undefined && /credentials/iu.test(String(error?.message ?? ''));
    record(`enabled-local/${order}-second-provider-refused`, refused, {
      expectedCode: localFirst ? 'KEYCHAIN_CREDENTIALS_CONFLICT' : 'cordis-service-conflict',
      code: error?.code ?? null,
      message: String(error?.message ?? '').slice(0, 160),
    });
    await owner?.set?.('SYNTHETIC_REF', 'synthetic-value').catch(() => {});
    const plaintext = fileExists();
    // 谁真正接管写入按行为判定：local 先挂则落到明文文件，keychain 先挂则不落盘。
    const observed = !mounted ? 'none' : plaintext ? 'local' : 'keychain';
    const expected = localFirst ? 'local' : 'keychain';
    record(`enabled-local/${order}-effective-owner-is-${observed}`, observed === expected, {
      mounted,
      expected,
      reproducedIssue125: plaintext,
      note: plaintext
        ? '写入落到了明文文件：#125 的默认回退形态'
        : '本顺序下写入没有落盘；只说明这一顺序由 keychain 持有，不等于双提供方风险不存在',
    });
    await ctx.fiber.dispose();
  }

  // 2. Fixed composition: the local row is disabled, keychain available.
  resetHome();
  {
    const backend = keychain.createMemoryBackend();
    const { ctx, error } = await compose({ localFirst, localEnabled: false, backend });
    const owner = ctx.get('credentials');
    record(`disabled-local/${order}-mounts-one-provider`, error === undefined && owner !== undefined, { error: error?.code ?? null });
    await owner.set('SYNTHETIC_REF', 'synthetic-value');
    record(`disabled-local/${order}-writes-through-the-keychain-backend`, (await backend.list('heluo-forge/')).includes('heluo-forge/iam/ref/SYNTHETIC_REF'));
    record(`disabled-local/${order}-no-plaintext-file`, fileExists() === false);
    await ctx.fiber.dispose();
  }

  // 3. Fixed composition with an unavailable backend: no provider at all, and
  //    still no plaintext file. This is the fail-closed promise of A.
  resetHome();
  {
    const backend = { ...keychain.createMemoryBackend(), available: false, reason: 'probe: unavailable' };
    const { ctx, error } = await compose({ localFirst, localEnabled: false, backend });
    record(`disabled-local/${order}-unavailable-backend-refuses-to-mount`, error !== undefined, { code: error?.code ?? null });
    record(`disabled-local/${order}-unavailable-backend-publishes-no-provider`, ctx.get('credentials') === undefined, { note: '挂载失败是预期；断言的是 local 没有接替' });
    record(`disabled-local/${order}-unavailable-backend-writes-nothing`, fileExists() === false);
    await ctx.fiber.dispose();
  }

  // 4. Preexisting plaintext file is neither migrated nor deleted by mounting.
  resetHome();
  {
    const backend = keychain.createMemoryBackend();
    const fs = await import('node:fs/promises');
    const before = `refs:\n  SYNTHETIC_REF: synthetic-value\n`;
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(legacyFile, before, { mode: 0o600 });
    const { ctx, error } = await compose({ localFirst, localEnabled: false, backend });
    const after = fileExists() ? readFileSync(legacyFile, 'utf8') : null;
    // 挂载失败时"没动文件"是废话，必须先要求这次组合真的起来了。
    record(`disabled-local/${order}-legacy-file-untouched`, error === undefined && after === before, {
      error: error?.code ?? null,
      existedBefore: true,
      existsAfter: after !== null,
    });
    await ctx.fiber.dispose();
  }
}

// Loader rows are covered by scripts/probe/run-bundle-install-rehearsal.mjs,
// which mounts the installed bundle's real rows through createRuntimeResolution.
// Resolving `@heluo/*` names here would need that installed bundle, and a row
// that cannot resolve is not evidence of anything.
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ ok: evidence.ok, steps: evidence.steps.length, scope: evidence.scope, env: evidence.env }, null, 2));
process.exit(evidence.ok ? 0 : 1);
