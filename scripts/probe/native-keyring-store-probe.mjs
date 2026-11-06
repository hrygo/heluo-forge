// Store-level probe for the native credential adapter.
//
// Purpose: turn the on-device acceptance items (read, write, delete, cross
// process visibility, enumeration) into one command whose JSON output can be
// pasted into issue #182. It needs the target machine and nothing else: no
// DSH profile, no model, no network.
//
// The probe never prints a stored value. It writes a synthetic marker, compares
// it in-process, and reports only booleans, error codes and timings.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeKeyringBackend, nativeAddonPath, nativeTargetFor } from '../../packages/forge-credentials-keychain/src/native-keyring.mjs';

const PACKAGE_ENTRY = new URL('../../packages/forge-credentials-keychain/src/index.mjs', import.meta.url).href;

/** A value that is obviously synthetic in a store dump, and never printed. */
function syntheticValue(label) {
  return `probe-${label}-${randomBytes(12).toString('hex')}`;
}

/** Keep store diagnostics but never let a stored value ride along in a report. */
function describeError(error) {
  if (error === null || typeof error !== 'object') return { message: String(error) };
  const message = typeof error.message === 'string' ? error.message.replace(/\s+/gu, ' ').trim().slice(0, 300) : undefined;
  return error.code === undefined ? { message } : { code: error.code, message };
}

/**
 * A second process reading the same entry is the only in-band evidence that the
 * value reached the OS store rather than an in-process cache. The child loads
 * the same package by absolute URL, so it resolves the same staged addon.
 */
function childRead({ key, service, timeoutMs = 30_000 }) {
  const script = `
    const key = ${JSON.stringify(key)};
    const service = ${JSON.stringify(service)};
    import(${JSON.stringify(PACKAGE_ENTRY)}).then(async (module) => {
      const backend = module.createNativeKeyringBackend({ service, platform: process.platform });
      const value = await backend.get(key);
      process.stdout.write(JSON.stringify({ ok: true, found: value !== undefined, value }));
    }).catch((error) => {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (child.error !== undefined && child.error !== null) {
    return { ok: false, message: child.error.message };
  }
  const text = (child.stdout ?? '').trim();
  if (text.length === 0) {
    return { ok: false, message: `child produced no output (status ${child.status}, stderr ${(child.stderr ?? '').slice(0, 200)})` };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: 'child output was not JSON' };
  }
}

/**
 * Drive the acceptance steps against a backend. Pure in the sense that the only
 * side effects are the probe key's own lifecycle: the key is unique per run, so
 * a previous probe never makes "absent" look "present".
 *
 * @param {{
 *   backend: { get: Function, set: Function, delete: Function, list?: Function, listEntries?: Function },
 *   service: string,
 *   key: string,
 *   enumeration?: boolean,
 *   readFromChild?: (input: { key: string, service: string }) => { ok: boolean, found?: boolean, value?: string, code?: string, message?: string },
 * }} options
 */
export async function runStoreProbe(options) {
  const { backend, service, key } = options;
  const enumeration = options.enumeration === true;
  const readFromChild = options.readFromChild ?? childRead;
  const steps = [];

  const step = async (name, run) => {
    const started = Date.now();
    try {
      const detail = await run();
      steps.push({ name, ok: true, durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
      return { ok: true, detail };
    } catch (error) {
      steps.push({ name, ok: false, durationMs: Date.now() - started, error: describeError(error) });
      return { ok: false, error };
    }
  };

  const fail = (message) => {
    const error = new Error(message);
    error.code = 'PROBE_ASSERTION_FAILED';
    return error;
  };

  let written;
  await step('read-absent', async () => {
    const value = await backend.get(key);
    if (value !== undefined) throw fail('entry exists before the probe wrote it');
  });

  await step('write-read', async () => {
    written = syntheticValue('one');
    await backend.set(key, written);
    const value = await backend.get(key);
    if (value !== written) throw fail('read-back differs from the value just written');
  });

  await step('overwrite-read', async () => {
    written = syntheticValue('two');
    await backend.set(key, written);
    const value = await backend.get(key);
    if (value !== written) throw fail('read-back after overwrite differs from the new value');
  });

  await step('cross-process-read', async () => {
    const result = readFromChild({ key, service });
    if (result.ok !== true) {
      const error = new Error(result.message ?? 'child read failed');
      if (typeof result.code === 'string') error.code = result.code;
      throw error;
    }
    if (result.found !== true) throw fail('a second process could not see the entry');
    if (result.value !== written) throw fail('a second process read a different value');
    return { childStatus: 'matched' };
  });

  if (enumeration) {
    await step('enumerate', async () => {
      const list = backend.listEntries ?? backend.list;
      if (typeof list !== 'function') throw fail('backend exposes no enumeration');
      const found = await list.call(backend, key.slice(0, key.lastIndexOf('/') + 1));
      const keys = Array.isArray(found) ? found.map((item) => (typeof item === 'string' ? item : item?.key)) : [];
      if (!keys.includes(key)) throw fail('enumeration did not include the probed key');
      // Foreign accounts are expected on Windows (target suffix filter); report
      // the count so the target-machine record can show the actual hit set.
      return { matched: keys.length, includesProbeKey: true };
    });
  }

  await step('delete', async () => {
    await backend.delete(key);
    const value = await backend.get(key);
    if (value !== undefined) throw fail('entry still readable after delete');
  });

  await step('delete-idempotent', async () => {
    await backend.delete(key);
  });

  return {
    ok: steps.every((item) => item.ok === true),
    key,
    service,
    enumeration,
    steps,
  };
}

function usage() {
  return [
    'usage: node scripts/probe/native-keyring-store-probe.mjs [options]',
    '',
    '  --service <name>      keyring service namespace (default: heluo-forge)',
    '  --key <name>          absolute backend key (default: <service>/probe/<random>)',
    '  --enumeration         also exercise findCredentials',
    '  --json                print only the JSON report',
    '  --help                print this message',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { service: 'heluo-forge', key: undefined, enumeration: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--enumeration') options.enumeration = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--service') { options.service = argv[index += 1]; }
    else if (arg === '--key') { options.key = argv[index += 1]; }
    else return { error: `unknown argument: ${arg}` };
  }
  return { options };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help === true) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n${usage()}\n`);
    return 64;
  }
  const { options } = parsed;
  const platform = process.platform;
  const arch = process.arch;
  const triple = nativeTargetFor(platform, arch);
  const addon = nativeAddonPath(platform, arch);
  const environment = {
    platform,
    arch,
    triple: triple ?? null,
    addon: addon ?? null,
    node: process.version,
  };
  if (triple === undefined) {
    process.stderr.write(`this host has no staged addon mapping (${platform}-${arch}); run on a target machine\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, stage: 'environment', environment }, null, 2)}\n`);
    return 2;
  }

  let backend;
  try {
    backend = createNativeKeyringBackend({ service: options.service, platform, arch, enumeration: options.enumeration ? 'find-credentials' : 'unsupported' });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, stage: 'construct', environment, error: describeError(error) }, null, 2)}\n`);
    return 2;
  }

  const key = options.key ?? `${options.service}/probe/${randomBytes(8).toString('hex')}`;
  const report = await runStoreProbe({ backend, service: options.service, key, enumeration: options.enumeration });
  process.stdout.write(`${JSON.stringify({ ...report, environment }, null, 2)}\n`);
  if (options.json !== true) {
    for (const item of report.steps) {
      process.stderr.write(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name} (${item.durationMs}ms)${item.ok ? '' : ` ${JSON.stringify(item.error)}`}\n`);
    }
    process.stderr.write(report.ok ? 'probe passed\n' : 'probe failed\n');
  }
  return report.ok ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}