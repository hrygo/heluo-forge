import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';

export function isolateHostDiagnostics() {
  let previousHome;
  before(() => {
    previousHome = process.env.DSH_HOME;
    const home = mkdtempSync(join(tmpdir(), 'forge-iam-host-diagnostics-'));
    // Host teardown queues log writes. Leave the directory in place until the
    // test file's process drains its asynchronous work.
    process.once('exit', () => rmSync(home, { recursive: true, force: true }));
    process.env.DSH_HOME = home;
  });
  after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
}
