// Task B algorithm fixture only: not an actual IAM login or SDK installer.
export function createConsumerFixture({ kind = 'tool', target = 'synthetic.read', purpose = 'fixture' } = {}) {
  let clock = 1000;
  let revision = 0;
  let ownerActive = true;
  let stage;
  let readBarrier;
  let permission;
  let witness;
  const scope = Object.freeze({ kind, target, purpose });
  const counts = { verify: 0, capture: 0, read: 0, witnessCurrent: 0, permitCurrent: 0, send: 0 };
  const iam = Object.freeze({ fixture: 'local-algorithm-only' });
  const consumer = Object.freeze({ name: 'synthetic-consumer' });
  const replaceWitness = (fields = {}) => {
    witness = Object.freeze({ pin: Object.freeze({}), issuer: 'https://iam.corp.example', subject: 'fixture-person', ...fields });
    return witness;
  };
  replaceWitness();
  const grant = (fields = {}, { ttl = 1000, mutable = false } = {}) => {
    const permit = { issuer: witness?.issuer ?? 'https://iam.corp.example', subject: witness?.subject ?? 'fixture-person',
      ...scope, revision: `revision-${++revision}`, ...fields };
    permission = { original: mutable ? permit : Object.freeze(permit), deadline: clock + ttl };
    return permission.original;
  };
  grant();
  const seen = {};
  const witnessSource = {
    capture() { counts.capture++; return witness; },
    isCurrent(original) { counts.witnessCurrent++; return witness !== undefined && original === witness; },
  };
  const authorizer = {
    async read(originalWitness, requestedScope) {
      counts.read++;
      seen.witness = originalWitness; seen.scope = requestedScope;
      const captured = permission?.original;
      if (readBarrier) await readBarrier();
      return captured;
    },
    isCurrent(original) {
      counts.permitCurrent++;
      return permission !== undefined && permission.original === original && clock < permission.deadline;
    },
  };
  const bind = (next = { iam, witnessSource, authorizer, consumer }) => { stage = Object.freeze({ ...next }); };
  bind();
  const getSources = () => stage;
  const options = {
    getSources,
    verifyConsumerSources(candidateIam, candidateWitness, candidateAuthorizer, candidateConsumer, requestedScope) {
      counts.verify++;
      return ownerActive && stage !== undefined && options.getSources === getSources
        && candidateIam === stage.iam && candidateWitness === stage.witnessSource
        && candidateAuthorizer === stage.authorizer && candidateConsumer === stage.consumer
        && candidateIam === iam && candidateWitness === witnessSource && candidateAuthorizer === authorizer && candidateConsumer === consumer
        && Object.keys(requestedScope).sort().join(',') === 'kind,purpose,target'
        && Object.keys(scope).every((key) => requestedScope[key] === scope[key]);
    },
  };
  return { options, scope, counts, seen, iam, witnessSource, authorizer, consumer,
    bind, unbind() { stage = undefined; }, unload() { ownerActive = false; stage = undefined; },
    grant, revoke() { permission = undefined; }, replaceWitness, clearWitness() { witness = undefined; },
    permit: () => permission?.original, witness: () => witness,
    setReadBarrier(barrier) { readBarrier = barrier; }, advance(ms) { clock += ms; },
    send(input) { counts.send++; return { kind: 'success', input }; },
  };
}

export function execution(id = 'fixture-call', args = { target: 'repo-A', body: { text: 'synthetic input' } }) {
  return { name: 'synthetic.read', callId: id, rootCallId: 'fixture-root', token: Symbol('fixture'),
    agent: Object.freeze({ fixture: 'agent' }), arguments: args, signal: new AbortController().signal };
}

export function hold() {
  const entered = Promise.withResolvers(); const released = Promise.withResolvers();
  return { entered: entered.promise, release: released.resolve, async pause() { entered.resolve(); await released.promise; } };
}
