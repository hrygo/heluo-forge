import { createConsumerFixture } from './iam-consumer.mjs';
import { createToolRuntime } from './tool-runtime.mjs';
import { installIamConsumerTools } from '../../src/iam-consumer-tools.mjs';

// C composition uses B's local algorithm source; not an actual IAM login.
export function toolFixture(t, { beforeSend, send, resolveArguments } = {}) {
  const host = createToolRuntime();
  const authority = createConsumerFixture({ target: 'repo-A' });
  const registrations = new Map();
  const counts = { source: 0, verify: 0, handler: 0, send: 0 };
  const requests = [], bodyExecutions = [];
  const options = {
    getSources(consumer) { counts.source++; return registrations.get(consumer); },
    verifyConsumerSources(iam, witnessSource, authorizer, consumer, scope) {
      counts.verify++;
      const stage = registrations.get(consumer);
      return stage !== undefined && stage.iam === iam && iam === authority.iam
        && stage.witnessSource === witnessSource && witnessSource === authority.witnessSource
        && stage.authorizer === authorizer && authorizer === authority.authorizer && stage.consumer === consumer
        && Object.keys(scope).sort().join(',') === 'kind,purpose,target'
        && Object.keys(authority.scope).every((key) => scope[key] === authority.scope[key]);
    },
  };
  const owned = { action: 'synthetic.read', description: 'Read the synthetic repository', scope: authority.scope,
    async beforeSend(exec) { counts.handler++; bodyExecutions.push(exec); if (beforeSend) await beforeSend(exec); },
    async send(input) {
      counts.send++; requests.push(input);
      return send ? await send(input) : { target: input.target, message: 'synthetic result' };
    } };
  options.tools = [{ ...owned, name: 'synthetic.read' }];
  options.commands = [{ ...owned, name: 'synthetic-read',
    resolveArguments: resolveArguments ?? ((invocation) => ({ target: invocation.rawInput, payload: 'synthetic command' })) }];
  const config = { audit: { sink: 'memory', allowNonDurable: true },
    catalog: [{ action: owned.action, kind: 'read', target: 'repository', enabled: true }],
    tools: { 'synthetic.read': owned.action } };
  const installed = installIamConsumerTools(host.ctx, config, options);
  const bind = (consumer) => { registrations.set(consumer, Object.freeze({ iam: authority.iam,
    witnessSource: authority.witnessSource, authorizer: authority.authorizer, consumer })); };
  for (const consumer of [...installed.tools, ...installed.commands]) bind(consumer);
  const policy = host.ctx.get('policy');
  t.after(() => installed.dispose());
  return { ...host, authority, counts, requests, bodyExecutions, options, config, installed, policy,
    bind, removeIam() { registrations.clear(); },
  };
}
