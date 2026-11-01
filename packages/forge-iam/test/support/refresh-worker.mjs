// Child process entry for the cross-process refresh test. It builds the same
// service the host builds, using a file-backed credential store shared with its
// peer, then performs exactly one refresh attempt and prints the outcome as
// JSON on stdout. Nothing secret is printed: only codes, timings and whether a
// token was obtained.
//
// When the test runner discovers this file without worker arguments it has no
// side effects, so it counts as a file with no tests rather than a failure.

import { FileCredentials } from './file-credentials.mjs';
import { createIamService } from './trusted-service.mjs';
import { validateConfig } from '../../src/config.mjs';

function readArgv(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const dir = readArgv('dir');
  const configJson = readArgv('config');
  if (!dir || !configJson) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing arguments' }));
    process.exitCode = 2;
    return;
  }

  const checked = validateConfig(JSON.parse(configJson));
  if ('issues' in checked) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'config-invalid', issues: checked.issues }));
    process.exitCode = 2;
    return;
  }

  // A cold service, like a process that starts and immediately needs a token.
  // Hydrating first would let the boot path start the refresh instead, which is
  // a different case: hydrate may refresh on its own and hide the measurement.
  const service = createIamService(checked.value, { credentials: new FileCredentials(dir) });
  const startedAt = Date.now();
  try {
    const token = await service.resolveToken();
    process.stdout.write(JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      state: service.getView().state,
      hasToken: typeof token === 'string' && token.length > 0,
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - startedAt,
      code: error?.code ?? 'UNKNOWN',
      state: service.getView().state,
    }));
  }
}

// Only act when spawned as a worker; a bare discovery run must stay inert.
if (process.argv.includes('--dir')) await main();
