import { readFile } from 'node:fs/promises';
import { startMockOidc } from '../../packages/forge-iam/test/support/mock-oidc.mjs';
import { MemoryCredentials } from '../../packages/forge-iam/test/support/memory-credentials.mjs';
import { createClientSecretFixture } from '../../packages/forge-iam/test/support/client-secret-source.mjs';
import { createToolRuntime } from '../../packages/forge-policy/test/support/tool-runtime.mjs';
import { createModelRuntime } from '../../packages/forge-policy/test/support/model-runtime.mjs';

// Exactly two test-only runtime specifiers. Pure scaffolding above is not a
// runtime API; no helper that creates a private factory or fake witness is used.
const publicEntries = new Map([
  ['@heluo/forge-iam/isolated-testing', new URL('../../packages/forge-iam/', import.meta.url)],
  ['@heluo/forge-policy/isolated-testing', new URL('../../packages/forge-policy/', import.meta.url)],
]);
export async function loadPublicFactory(specifier) {
  const root = publicEntries.get(specifier);
  if (!root) throw new Error('unsupported isolated test specifier');
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const target = manifest.exports?.['./isolated-testing'];
  if (manifest.name !== specifier.slice(0, -'/isolated-testing'.length)
    || target !== './src/isolated-testing.mjs' || !manifest.files?.includes('src')) throw new Error('isolated export is not in the declared package body');
  return import(new URL(target, root).href);
}
export function hold() {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  return { entered: entered.promise, release: released.resolve, async pause() { entered.resolve(); await released.promise; } };
}
export async function atWait(gate, pending) {
  return Promise.race([gate.entered, pending.then(() => { throw new Error('actual owned wait was not entered'); })]);
}
export async function collect(iterable) {
  const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks;
}
export async function* modelChunks() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'joint synthetic model result' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'joint synthetic model result' } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function credentialsBinder(initial) {
  let current = initial, marker = Object.freeze({});
  const getCredentials = () => current;
  const getCredentialsBindingScope = () => current ? marker : undefined;
  return { getCredentials, getCredentialsBindingScope,
    bind(next) { current = next; marker = Object.freeze({}); },
    accepts(candidate, readers) { return current !== undefined && candidate === current
      && readers.getCredentials === getCredentials && readers.getCredentialsBindingScope === getCredentialsBindingScope; },
  };
}
const sameScope = (left, right) => ['kind', 'target', 'purpose'].every((key) => left[key] === right[key]);

export async function jointFixture(t, { confidential = false, beforeTool, modelSend, subject = 'E1001', onActualWitness } = {}) {
  const [{ createIamService }, { installIamConsumerTools, installIamConsumerModel }] = await Promise.all([
    loadPublicFactory('@heluo/forge-iam/isolated-testing'), loadPublicFactory('@heluo/forge-policy/isolated-testing'),
  ]);
  const clientSecret = 'SYNTHETIC_E_CLIENT_PRIVATE';
  const mock = await startMockOidc({ subject, ...(confidential ? { clientAuthMethod: 'client_secret_basic', clientSecret } : {}) });
  t.after(() => mock.close());
  const credentials = new MemoryCredentials(), binder = credentialsBinder(credentials);
  const secret = confidential ? createClientSecretFixture(credentials, { issuer: mock.issuer, clientId: mock.clientId,
    method: 'client_secret_basic', value: clientSecret }) : undefined;
  const toolHost = createToolRuntime(), modelHost = createModelRuntime();
  const toolScope = Object.freeze({ kind: 'tool', target: 'repo-E', purpose: 'joint-review' });
  const provider = 'joint-synthetic', model = 'joint-model';
  const modelScope = Object.freeze({ kind: 'model', target: `${provider}/${model}`, purpose: 'joint-review' });
  const scopes = [toolScope, modelScope];
  const trustedConsumers = new Map(), offered = new Map(), permits = new Map();
  const counts = { registered: 0, unregistered: 0, permissionRead: 0, tool: 0, command: 0, model: 0 };
  const requests = [], decisions = [], issued = [];
  let registration, witnessSource, permissionTime = 0, revision = 0;
  const authorizer = Object.freeze({
    async read(witness, scope) {
      counts.permissionRead++;
      const trusted = scopes.find((candidate) => sameScope(scope, candidate));
      const entry = permits.get(trusted);
      return entry && entry.deadline > permissionTime && entry.permit.issuer === witness.issuer
        && entry.permit.subject === witness.subject ? entry.permit : undefined;
    },
    isCurrent(permit) { return [...permits.values()].some((entry) => entry.permit === permit && entry.deadline > permissionTime); },
  });
  function stage(consumer) {
    if (registration) offered.set(consumer, Object.freeze({ iam: registration.iam,
      witnessSource: registration.source, authorizer, consumer }));
  }
  function recognize(consumer, scope) { trustedConsumers.set(consumer, scope); stage(consumer); }
  const sourceOptions = {
    getSources: (consumer) => offered.get(consumer),
    verifyConsumerSources(iam, source, permissionSource, consumer, scope) {
      const trusted = trustedConsumers.get(consumer);
      return registration !== undefined && trusted !== undefined && registration.iam === iam
        && registration.source === source && permissionSource === authorizer
        && Object.keys(scope).sort().join(',') === 'kind,purpose,target' && sameScope(scope, trusted);
    },
  };
  function registerActualWitness(actualIam, source) {
    counts.registered++; witnessSource = source;
    const entry = Object.freeze({ iam: actualIam, source }); registration = entry;
    for (const consumer of trustedConsumers.keys()) stage(consumer);
    return () => { if (registration === entry) { registration = undefined; offered.clear(); counts.unregistered++; } };
  }
  const config = { ...mock.endpoints, clientId: mock.clientId, ...secret?.config,
    redirectUri: 'http://127.0.0.1:4567/iam/callback', httpTimeoutMs: 2000 };
  const iam = createIamService(config, { ...secret?.options,
    getCredentials: binder.getCredentials, getCredentialsBindingScope: binder.getCredentialsBindingScope,
    verifyAtomicStore: (candidate) => candidate === credentials,
    verifyWitnessBindings(candidate, source, scope, readers) {
      const common = binder.accepts(candidate, readers) && Object.isFrozen(scope) && Object.isFrozen(readers)
        && scope.issuer === mock.issuer && scope.clientId === mock.clientId;
      if (confidential) return common && secret.acceptsWitnessBinding(source, scope, readers)
        && Object.keys(scope).sort().join(',') === 'clientId,issuer,method,mode,ref'
        && Object.keys(readers).sort().join(',') === 'getClientSecretBindingScope,getClientSecretSource,getCredentials,getCredentialsBindingScope';
      return common && source === undefined && scope.mode === 'public' && scope.method === 'none'
        && Object.keys(scope).sort().join(',') === 'clientId,issuer,method,mode'
        && Object.keys(readers).sort().join(',') === 'getCredentials,getCredentialsBindingScope';
    },
    registerWitness(actualIam, source) {
      const unregister = registerActualWitness(actualIam, source);
      const forwarded = onActualWitness?.(actualIam, source);
      return () => { forwarded?.(); unregister(); };
    },
  });
  t.after(() => iam.dispose());
  const toolOwner = installIamConsumerTools(toolHost.ctx, {
    audit: { sink: 'memory', allowNonDurable: true },
    catalog: [{ action: 'joint.read', kind: 'read', target: 'repository', enabled: true }],
    tools: { 'joint.read': 'joint.read' }, onDecision: (decision) => decisions.push(decision),
  }, { ...sourceOptions,
    tools: [{ name: 'joint.read', action: 'joint.read', description: 'Synthetic joint read', scope: toolScope, beforeSend: beforeTool,
      send(input) { counts.tool++; requests.push(input); return { target: input.target, message: 'joint synthetic tool result' }; } }],
    commands: [{ name: 'joint-read', action: 'joint.read', description: 'Synthetic joint command', scope: toolScope,
      send(input) { counts.command++; requests.push(input); return { target: input.target, message: 'joint synthetic command result' }; } }],
  });
  t.after(() => toolOwner.dispose());
  const modelOwner = installIamConsumerModel(modelHost.ctx, { ...sourceOptions, provider, model, scope: modelScope,
    send(input) { counts.model++; requests.push(input); return modelSend ? modelSend(input) : modelChunks(); } });
  t.after(() => modelOwner.dispose());
  for (const consumer of [...toolOwner.tools, ...toolOwner.commands]) recognize(consumer, toolScope);
  recognize(modelOwner.adapter, modelScope);
  function approve(scope, patch = {}, ttl = 10) {
    const witness = witnessSource.capture();
    if (!witness) throw new Error('actual IAM witness required before independent approval');
    const permit = Object.freeze({ issuer: witness.issuer, subject: witness.subject, kind: scope.kind,
      target: patch.target ?? scope.target, purpose: patch.purpose ?? scope.purpose, revision: String(++revision) });
    permits.set(scope, { permit, deadline: permissionTime + ttl }); issued.push(permit);
    return permit;
  }
  return { iam, mock, credentials, binder, secret, registerActualWitness, authorizer, offered, counts, issued, requests, decisions,
    get witnessSource() { return witnessSource; },
    toolHost, modelHost, toolOwner, modelOwner, toolScope, modelScope, provider, modelId: model,
    get registeredIam() { return registration?.iam; },
    async login() {
      const started = await iam.startSignIn();
      const response = await fetch(started.authorizationUrl, { redirect: 'manual' });
      if (response.status !== 302) throw new Error('mock authorization did not redirect');
      const result = await iam.handleCallback(response.headers.get('location'));
      if (result.state !== 'ready') throw new Error('actual IAM did not adopt the mock session');
      return result;
    },
    approveAll(patch, ttl) { for (const scope of scopes) approve(scope, patch, ttl); },
    advancePermissionTime(amount) { permissionTime += amount; },
    tool: () => toolHost.run('joint.read', { target: toolScope.target, payload: 'joint synthetic tool request' }),
    command: () => toolHost.command('joint-read', { rawInput: toolScope.target }),
    model: () => collect(modelHost.ctx.llm.stream({ provider, model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'joint synthetic model request' }] }], purpose: 'compaction' })),
    assertPrivate(value) {
      const encoded = JSON.stringify(value);
      const basic = Buffer.from(`${encodeURIComponent(mock.clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
      const privateValues = [clientSecret, basic];
      for (const record of credentials.records.values()) {
        const grant = record.payload;
        for (const key of ['accessToken', 'refreshToken', 'idToken']) if (typeof grant?.[key] === 'string') privateValues.push(grant[key]);
      }
      if (privateValues.some((privateValue) => encoded.includes(privateValue)) || /access-\d+|refresh-[a-f0-9-]+|SYNTHETIC_E_STALE|SYNTHETIC_E_FOREIGN/.test(encoded)) {
        throw new Error('authentication material or obsolete provider data reached a public observable');
      }
    },
  };
}
