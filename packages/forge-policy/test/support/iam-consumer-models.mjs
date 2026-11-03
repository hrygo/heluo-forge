import { createConsumerFixture } from './iam-consumer.mjs';
import { createModelRuntime } from './model-runtime.mjs';
import { installIamConsumerModel } from '../../src/iam-consumer-models.mjs';
export const provider = 'synthetic-iam';
export const model = 'synthetic-model';
export function request() { return { provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic request' }] }], purpose: 'compaction' }; }
export async function* chunks() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'synthetic result' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic result' } };
  yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'synthetic-response' }, blocks: [] } };
}
export const collect = async (iterable) => { const values = []; for await (const value of iterable) values.push(value); return values; };
export function modelFixture(t, { beforeSend, send } = {}) {
  const host = createModelRuntime();
  const authority = createConsumerFixture({ kind: 'model', target: `${provider}/${model}`, purpose: 'business-review' });
  const counts = { source: 0, verify: 0, send: 0 }, requests = [];
  let stage;
  const options = { provider, model, scope: authority.scope, beforeSend,
    getSources(consumer) { counts.source++; return stage?.consumer === consumer ? stage : undefined; },
    verifyConsumerSources(iam, witnessSource, authorizer, consumer, scope) {
      counts.verify++;
      return stage !== undefined && stage.consumer === consumer && stage.iam === iam && iam === authority.iam
        && stage.witnessSource === witnessSource && witnessSource === authority.witnessSource
        && stage.authorizer === authorizer && authorizer === authority.authorizer
        && Object.keys(scope).sort().join(',') === 'kind,purpose,target'
        && Object.keys(authority.scope).every((key) => scope[key] === authority.scope[key]);
    },
    send(input) { counts.send++; requests.push(input); return send ? send(input) : chunks(); },
  };
  const installed = installIamConsumerModel(host.ctx, options);
  const bind = () => { stage = Object.freeze({ iam: authority.iam, witnessSource: authority.witnessSource,
    authorizer: authority.authorizer, consumer: installed.adapter }); };
  bind(); t.after(installed.dispose);
  return { ...host, authority, counts, requests, options, installed, bind, removeIam() { stage = undefined; },
    probe(callback) { host.onAdapterStream = callback; },
    prepare: () => host.ctx.llm.prepareCall({ provider, model }),
    run: (input = request()) => collect(host.ctx.llm.stream(input)),
  };
}
