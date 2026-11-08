// SSE heartbeat probe for the managed gateway profile.
//
// The gateway keeps a streaming call alive with `: ping` comment lines every
// 15s. This probe feeds such a stream to the same pi-ai parser the host uses
// and records which parser events appear, so the idle-watchdog bound in
// `src/managed-models.mjs` rests on measurement rather than assumption.
//
// It needs the host's pi-ai package; nothing is written and no gateway or model
// is called.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'pi-ai': { type: 'string' },
    'heartbeat-ms': { type: 'string', default: '15000' },
    'first-token-ms': { type: 'string', default: '70000' },
  },
});
const heartbeatMs = Number(values['heartbeat-ms']);
const firstTokenMs = Number(values['first-token-ms']);
const piAiDir = values['pi-ai'] ?? process.env.PI_AI_DIR
  ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles/node_modules/@earendil-works/pi-ai');

const { openAICompletionsApi } = await import(pathToFileURL(path.join(piAiDir, 'dist/api/openai-completions.lazy.js')).href);
const api = openAICompletionsApi();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const ping = setInterval(() => res.write(`: ping - ${new Date().toISOString()}\n\n`), heartbeatMs);
  const chunk = (text, finish = null) => res.write(`data: ${JSON.stringify({
    id: 'probe', object: 'chat.completion.chunk', created: 0, model: 'probe',
    choices: [{ index: 0, delta: text === null ? {} : { content: text }, finish_reason: finish }],
  })}\n\n`);
  setTimeout(() => {
    chunk('hello'); chunk(null, 'stop'); res.write('data: [DONE]\n\n');
    clearInterval(ping); res.end();
  }, firstTokenMs);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const model = {
  id: 'probe', name: 'probe', provider: 'probe', api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}`,
  reasoning: false, input: ['text'],
  compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const started = Date.now();
const events = [];
try {
  const stream = api.streamSimple(model, { messages: [{ role: 'user', content: 'probe' }] }, { apiKey: 'synthetic', maxTokens: 8 });
  for await (const event of stream) events.push({ at: Date.now() - started, type: event.type, text: event.text });
} catch (error) {
  console.log(JSON.stringify({ ok: false, elapsed: Date.now() - started, error: String(error?.message ?? error), events }, null, 2));
  server.close();
  process.exitCode = 1;
} finally {
  server.close();
}
const beforeFirstToken = events.filter(event => event.at < firstTokenMs);
console.log(JSON.stringify({
  ok: true,
  heartbeatMs, firstTokenMs,
  elapsed: events.at(-1)?.at,
  events: events.map(event => `${event.at}ms:${event.type}${event.text ? `:${event.text}` : ''}`),
  // Comments may wake the transport once (the first body byte produces
  // `start`); they must never surface as content or as a later event.
  eventsBeforeFirstToken: beforeFirstToken.map(event => `${event.at}ms:${event.type}`),
  leakedContent: events.filter(event => event.type === 'text-delta' && event.at < firstTokenMs).length,
}, null, 2));
