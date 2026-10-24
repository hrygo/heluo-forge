// Child entry for the lifecycle matrix: start a sign-in attempt (which arms the
// attempt timeout), dispose, then return. If dispose leaves the timer armed the
// process cannot exit, which is exactly what the parent measures.
import { createIamService } from '../../src/index.mjs';
import { validateConfig } from '../../src/config.mjs';
import { MemoryCredentials } from './memory-credentials.mjs';

async function main() {
  const config = validateConfig({
    issuer: 'https://iam.corp.example',
    authorizationEndpoint: 'https://iam.corp.example/authorize',
    tokenEndpoint: 'https://iam.corp.example/token',
    jwksUri: 'https://iam.corp.example/jwks',
    clientId: 'dsh-desktop',
    gatewayResource: 'https://gateway.corp.example',
    redirectUri: 'http://127.0.0.1:9/iam/callback',
    attemptTimeoutSeconds: 30,
  }).value;
  const service = createIamService(config, { credentials: new MemoryCredentials() });
  const started = await service.startSignIn();
  await service.dispose();
  process.stdout.write(`${JSON.stringify({ state: started.view.state, disposed: true })}\n`);
}

if (process.argv.includes('--attempt-exit')) await main();
