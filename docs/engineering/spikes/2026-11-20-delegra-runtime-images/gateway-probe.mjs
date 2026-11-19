import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const run = promisify(execFile);
const gatewayKey = 'fixture-gateway-key';
const iamToken = 'fixture-iam-access-token';
const marker = 'FORGE_GATEWAY_PROBE_OK';
const model = 'gpt-5.4';
const requests = [];

function invokeCodex(args, env) {
  const result = run('codex', args, { env, timeout: 30_000 });
  result.child.stdin.end();
  return result;
}

const message = {
  id: 'msg_probe',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: marker, annotations: [] }],
};
const completed = {
  id: 'resp_probe',
  object: 'response',
  model,
  created_at: 0,
  status: 'completed',
  output: [message],
  usage: {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  },
};
const events = [
  { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
  { type: 'response.output_item.done', output_index: 0, item: message },
  { type: 'response.completed', response: completed },
];

const server = createServer((request, response) => {
  request.resume();

  const matches = {
    endpoint: request.method === 'POST' && request.url === '/aig/v1/responses',
    gatewayKey: request.headers.authorization === `Bearer ${gatewayKey}`,
    iamToken: request.headers['x-iam-token'] === iamToken,
    consumer: request.headers['x-consumer-type'] === 'personal',
  };
  requests.push(matches);

  if (!matches.endpoint) {
    response.writeHead(404).end();
    return;
  }
  if (!matches.gatewayKey || !matches.iamToken || !matches.consumer) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fixture authorization rejected', code: 'invalid_iam_token' } }));
    return;
  }

  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [sequence_number, event] of events.entries()) {
    response.write(`data: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
  }
  response.end();
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
  const baseURL = `http://127.0.0.1:${server.address().port}/aig/v1`;
  const args = [
    'exec', '--skip-git-repo-check', '--ephemeral', '--json', '--sandbox', 'read-only', '-m', model,
    '-c', 'model_provider="forge_probe"',
    '-c', 'model_providers.forge_probe.name="Forge runtime probe"',
    '-c', `model_providers.forge_probe.base_url=${JSON.stringify(baseURL)}`,
    '-c', 'model_providers.forge_probe.wire_api="responses"',
    '-c', 'model_providers.forge_probe.env_key="FORGE_PROBE_GATEWAY_KEY"',
    '-c', 'model_providers.forge_probe.env_http_headers={"X-IAM-Token"="FORGE_PROBE_IAM_TOKEN"}',
    '-c', 'model_providers.forge_probe.http_headers={"X-Consumer-Type"="personal"}',
    '-c', 'model_providers.forge_probe.request_max_retries=0',
    '-c', 'model_providers.forge_probe.stream_max_retries=0',
    'Reply with the fixture result.',
  ];
  const environment = { PATH: process.env.PATH, FORGE_PROBE_GATEWAY_KEY: gatewayKey };
  const { stdout } = await invokeCodex(args, { ...environment, FORGE_PROBE_IAM_TOKEN: iamToken });
  const result = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(result.some(event => event.type === 'item.completed' && event.item?.text === marker));
  assert.ok(result.some(event => event.type === 'turn.completed'));

  await assert.rejects(invokeCodex(args, environment), error => error.code === 1);
  assert.deepEqual(requests, [
    { endpoint: true, gatewayKey: true, iamToken: true, consumer: true },
    { endpoint: true, gatewayKey: true, iamToken: false, consumer: true },
  ]);
  console.log('Codex Responses probe passed: dual credentials accepted, missing IAM token rejected');
} finally {
  await new Promise(resolve => server.close(resolve));
}
