// Child-process entry for the cross-process sign-out test. It attaches to the
// same file-backed store as its peer and either signs out or asks for a token,
// printing only codes and booleans.
//
// Discovered without arguments by the test runner it does nothing.

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
  const mode = readArgv('mode') ?? 'token';
  // Discovered as a plain module by the test runner: stay silent and succeed.
  if (!dir || !configJson) return;
  const checked = validateConfig(JSON.parse(configJson));
  if ('issues' in checked) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'config-invalid' }));
    return;
  }
  const service = createIamService(checked.value, { credentials: new FileCredentials(dir) });
  if (mode === 'sign-out') {
    const result = await service.signOut();
    process.stdout.write(JSON.stringify({
      ok: true,
      revocation: result?.revocation ?? 'unknown',
      state: service.getView().state,
      signedIn: service.getView().signedIn,
    }));
    return;
  }
  try {
    const token = await service.resolveToken();
    process.stdout.write(JSON.stringify({ ok: true, hasToken: typeof token === 'string' && token.length > 0 }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? 'UNKNOWN' }));
  }
}

await main();
