import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDocs } from '../scripts/lib/doc-rules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('catalog CLI renders every validated ID in order, including historical reservations', () => {
  const { catalog, errors } = checkDocs(root);
  assert.deepEqual(errors, []);
  const output = execFileSync(process.execPath, [resolve(root, 'scripts/check-docs.mjs'), '--catalog', root], { encoding: 'utf8' });
  const ids = [...output.matchAll(/^\| (CORP-DSH-[^ ]+) \|/gmu)].map((match) => match[1]);
  assert.deepEqual(ids, catalog.map((entry) => entry.id));
  assert.deepEqual(ids, [...ids].sort());
  assert.match(output, /CORP-DSH-PLAN-017A/u);
  assert.match(output, /CORP-DSH-UAT-001.*docs\/operations\/enterprise-uat-2026-11\/README\.md/u);
  for (const id of ['CORP-DSH-CONF-003', 'CORP-DSH-SDD-001']) {
    const retired = catalog.find((entry) => entry.id === id);
    assert.equal(retired?.status, '已废止');
    assert.equal(retired.path, null);
    assert.ok(retired.gate);
  }
});
