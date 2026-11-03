import test from 'node:test';
import assert from 'node:assert/strict';
import { jointFixture, loadPublicFactory, hold, atWait } from './support/iam-consumption.mjs';

const fixedTool = (result) => { assert.equal(result.isError, true); assert.match(result.error.message, /IAM_CONSUMPTION_/); };
const fixedCommand = (result) => { assert.equal(result.kind, 'error'); assert.match(result.text, /IAM_CONSUMPTION_/); };
const fixedModel = (chunks, code = /IAM_CONSUMPTION_/) => {
  const last = chunks.at(-1); assert.equal(last?.type, 'finish');
  assert.ok(['error', 'aborted'].includes(last.reason.kind)); assert.match(last.reason.failure.code, code);
};
const sends = (h) => [h.counts.tool, h.counts.command, h.counts.model];
async function deniedAll(h) {
  const values = [await h.tool(), await h.command(), await h.model()];
  fixedTool(values[0]); fixedCommand(values[1]); fixedModel(values[2]); h.assertPrivate(values); return values;
}

test('root runtime lookup admits only the two exact declared isolated exports', async () => {
  const iam = await loadPublicFactory('@heluo/forge-iam/isolated-testing');
  const policy = await loadPublicFactory('@heluo/forge-policy/isolated-testing');
  assert.deepEqual(Object.keys(iam).sort(), ['createIamService', 'createIamViewConsumer', 'createIamViewObserver']);
  assert.deepEqual(Object.keys(policy), ['createIamConsumer', 'installIamConsumerModel', 'installIamConsumerTools']);
  for (const specifier of ['@heluo/forge-iam', '@heluo/forge-iam/src/service.mjs', '@heluo/forge-policy/gate', '../../packages/forge-iam/src/service.mjs', '@other/package/isolated-testing']) {
    await assert.rejects(loadPublicFactory(specifier), /unsupported isolated test specifier/);
  }
});

for (const confidential of [false, true]) {
  test(`actual ${confidential ? 'confidential Basic' : 'public'} login plus independent permits reaches registered tool, command and model once each`, async (t) => {
    const h = await jointFixture(t, { confidential });
    assert.equal(h.registeredIam, h.iam); assert.equal(h.witnessSource.capture(), undefined);
    await h.login();
    const witness = h.witnessSource.capture(); assert.ok(witness);
    assert.deepEqual(Object.keys(witness).sort(), ['issuer', 'pin', 'subject']);
    assert.equal(witness.issuer, h.mock.issuer); assert.equal(h.credentials.records.size, 1);
    assert.ok(h.mock.counts.authorize > 0 && h.mock.counts.token > 0 && h.mock.counts.jwks > 0);
    await deniedAll(h); assert.deepEqual(sends(h), [0, 0, 0], 'login itself grants no business permission');
    h.approveAll();
    for (const permit of h.issued) assert.deepEqual(Object.keys(permit).sort(), ['issuer', 'kind', 'purpose', 'revision', 'subject', 'target']);
    const tool = await h.tool(); assert.equal(tool.isError, false);
    const command = await h.command(); assert.equal(command.kind, 'success');
    const model = await h.model(); assert.equal(model.at(-1).reason.kind, 'stop');
    assert.deepEqual(sends(h), [1, 1, 1]); assert.equal(h.counts.permissionRead, 6);
    h.assertPrivate({ tool, command, model, requests: h.requests, decisions: h.decisions, permits: h.issued });
  });
}

test('actual configured factory before login refuses every registered consumer', async (t) => {
  const h = await jointFixture(t); await deniedAll(h);
  assert.equal(h.witnessSource.capture(), undefined); assert.equal(h.mock.counts.token, 0); assert.deepEqual(sends(h), [0, 0, 0]);
});

for (const field of ['target', 'purpose']) {
  test(`actual session does not make a mismatched permit ${field} valid for any registered consumer`, async (t) => {
    const h = await jointFixture(t); await h.login(); h.approveAll({ [field]: 'different-synthetic-scope' });
    assert.ok(h.witnessSource.capture()); await deniedAll(h); assert.deepEqual(sends(h), [0, 0, 0]);
  });
}

test('independent private permit deadline can expire while the actual IAM witness stays current', async (t) => {
  const h = await jointFixture(t); await h.login(); h.approveAll({}, 1);
  const witness = h.witnessSource.capture(); h.advancePermissionTime(2);
  assert.equal(h.witnessSource.isCurrent(witness), true);
  await deniedAll(h); assert.deepEqual(sends(h), [0, 0, 0]);
});

test('actual signOut during the owned tool beforeSend wait prevents its one send', async (t) => {
  const gate = hold(); t.after(gate.release);
  const h = await jointFixture(t, { beforeTool: () => gate.pause() }); await h.login(); h.approveAll();
  const witness = h.witnessSource.capture(); const pending = h.tool(); await atWait(gate, pending);
  const signingOut = h.iam.signOut();
  assert.equal(h.witnessSource.isCurrent(witness), false);
  assert.equal(h.authorizer.isCurrent(h.issued[0]), true, 'identity and permission are independent gates');
  gate.release(); const result = await pending; await signingOut;
  fixedTool(result); assert.equal(h.counts.tool, 0); assert.equal(h.counts.permissionRead, 1); h.assertPrivate(result);
});

for (const boundary of ['chunk', 'done']) {
  test(`actual signOut during sent model ${boundary} wait cannot adopt obsolete text or stop`, async (t) => {
    const gate = hold(); t.after(gate.release);
    const h = await jointFixture(t, { modelSend: () => (async function* () {
      if (boundary === 'chunk') {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        await gate.pause(); yield { type: 'text-delta', index: 0, text: 'SYNTHETIC_E_STALE text' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } else { yield { type: 'finish', reason: { kind: 'stop' } }; await gate.pause(); }
    })() });
    await h.login(); h.approveAll(); const pending = h.model(); await atWait(gate, pending);
    const signingOut = h.iam.signOut(); gate.release(); const values = await pending; await signingOut;
    fixedModel(values, /CHANGED/); assert.equal(values.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'stop'), false);
    assert.equal(h.counts.model, 1); assert.equal(h.counts.permissionRead, 1); h.assertPrivate(values);
  });
}

test('same actual credential object rebinding during a tool wait invalidates the original witness and operation', async (t) => {
  const gate = hold(); t.after(gate.release);
  const h = await jointFixture(t, { beforeTool: () => gate.pause() }); await h.login(); h.approveAll();
  const witness = h.witnessSource.capture(); const pending = h.tool(); await atWait(gate, pending);
  h.binder.bind(h.credentials); assert.equal(h.witnessSource.isCurrent(witness), false);
  gate.release(); const result = await pending; fixedTool(result);
  assert.equal(h.counts.tool, 0); assert.equal(h.counts.permissionRead, 1); h.assertPrivate(result);
});

test('actual IAM dispose unregisters only its source while policy, tools and model route remain but deny', async (t) => {
  const h = await jointFixture(t); await h.login(); h.approveAll();
  const policy = h.toolHost.ctx.get('policy'); h.iam.dispose();
  assert.equal(h.counts.unregistered, 1); assert.equal(h.offered.size, 0);
  assert.equal(h.toolHost.ctx.get('policy'), policy); assert.ok(h.toolHost.guards.length > 0);
  assert.ok(h.toolHost.definitions.has('joint.read')); assert.ok(h.toolHost.commands.has('joint-read'));
  assert.equal(h.modelHost.routes.get(h.provider).adapter, h.modelOwner.adapter);
  await deniedAll(h); assert.deepEqual(sends(h), [0, 0, 0]);
});

test('actual consumer-owner disposal withdraws both abilities and rejects old waits without disposing IAM', async (t) => {
  const toolGate = hold(), modelGate = hold(); t.after(toolGate.release); t.after(modelGate.release);
  const h = await jointFixture(t, { beforeTool: () => toolGate.pause(), modelSend: () => (async function* () {
    await modelGate.pause(); yield { type: 'text-delta', index: 0, text: 'SYNTHETIC_E_STALE owner' };
  })() });
  await h.login(); h.approveAll(); const witness = h.witnessSource.capture();
  const tool = h.tool(), model = h.model(); await Promise.all([atWait(toolGate, tool), atWait(modelGate, model)]);
  h.toolOwner.dispose(); h.modelOwner.dispose();
  assert.equal(h.toolHost.definitions.has('joint.read'), false); assert.equal(h.toolHost.commands.has('joint-read'), false);
  assert.equal(h.modelHost.routes.has(h.provider), false); assert.equal(h.witnessSource.isCurrent(witness), true);
  toolGate.release(); modelGate.release(); const results = [await tool, await model];
  fixedTool(results[0]); fixedModel(results[1], /CHANGED/); assert.deepEqual(sends(h), [0, 0, 1]);
  assert.equal(h.counts.unregistered, 0); h.assertPrivate(results);
});

test('a candidate tuple cannot vouch for an unregistered lookalike source even after actual login', async (t) => {
  const h = await jointFixture(t); await h.login(); h.approveAll();
  const adapter = h.modelOwner.adapter;
  h.offered.set(adapter, Object.freeze({ iam: h.iam, authorizer: h.authorizer, consumer: adapter,
    witnessSource: Object.freeze({ capture: h.witnessSource.capture, isCurrent: h.witnessSource.isCurrent }) }));
  const result = await h.model(); fixedModel(result, /UNVERIFIED/);
  assert.ok(h.witnessSource.capture()); assert.equal(h.counts.model, 0); h.assertPrivate(result);
});

test('actual identity and scope do not turn an unknown sent model outcome into a replay or raw error', async (t) => {
  const h = await jointFixture(t, { modelSend: () => (async function* () { throw new Error('SYNTHETIC_E_FOREIGN provider'); })() });
  await h.login(); h.approveAll(); const witness = h.witnessSource.capture(); const values = await h.model();
  fixedModel(values, /UNKNOWN/); assert.equal(h.counts.model, 1); assert.equal(h.counts.permissionRead, 1);
  assert.equal(h.witnessSource.isCurrent(witness), true); assert.equal(h.modelHost.ctx.llm.providerRetryPolicy(h.provider).maxRetries, 0);
  h.assertPrivate({ values, requests: h.requests, decisions: h.decisions });
});

test('actual IAM issuer and person replacement rejects an old wait while both sources and original permit remain current', async (t) => {
  const gate = hold(); t.after(gate.release);
  const a = await jointFixture(t, { subject: 'joint-person-A', beforeTool: () => gate.pause() });
  await a.login(); a.approveAll();
  const sourceA = a.witnessSource, witnessA = sourceA.capture(), permitA = a.issued[0];
  const consumer = a.toolOwner.tools[0], stageA = a.offered.get(consumer);
  const pending = a.tool(); await atWait(gate, pending);
  const b = await jointFixture(t, { subject: 'joint-person-B', onActualWitness: a.registerActualWitness });
  await b.login(); const sourceB = b.witnessSource, witnessB = sourceB.capture();
  assert.ok(witnessA && witnessB); assert.notEqual(witnessA.issuer, witnessB.issuer); assert.notEqual(witnessA.subject, witnessB.subject);
  assert.equal(sourceA.isCurrent(witnessA), true); assert.equal(sourceB.isCurrent(witnessB), true);
  assert.equal(a.authorizer.isCurrent(permitA), true, 'no old permission was revoked to manufacture the failure');
  gate.release(); const oldResult = await pending;
  assert.equal(a.counts.tool, 0, 'issuer/person replacement must prevent the actual old A send');
  fixedTool(oldResult); assert.match(oldResult.error.message, /CHANGED/); assert.equal(a.counts.permissionRead, 1);
  assert.equal(a.registeredIam, b.iam); assert.equal(a.witnessSource, sourceB);
  const stageB = a.offered.get(consumer); assert.notEqual(stageB, stageA); assert.ok(Object.isFrozen(stageB));
  assert.equal(stageB.iam, b.iam); assert.equal(stageB.witnessSource, sourceB); assert.equal(stageB.authorizer, a.authorizer);
  a.iam.dispose(); assert.equal(a.registeredIam, b.iam, 'the old registration disposer cannot erase the new actual source');
  assert.equal(a.offered.get(consumer), stageB); assert.equal(sourceB.isCurrent(witnessB), true);
  a.approveAll();
  const freshResult = await a.tool(); assert.equal(freshResult.isError, false);
  assert.equal(a.counts.tool, 1); assert.equal(a.counts.permissionRead, 2);
  assert.equal(a.issued.at(-2).issuer, witnessB.issuer); assert.equal(a.issued.at(-2).subject, witnessB.subject);
  const observables = { oldResult, freshResult, requests: a.requests, decisions: a.decisions, permits: a.issued };
  a.assertPrivate(observables); b.assertPrivate(observables);
});
