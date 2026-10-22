import { startMockOidc } from './mock-oidc.mjs';

const mock = await startMockOidc();
const config = {
  issuer: mock.issuer,
  authorizationEndpoint: mock.endpoints.authorizationEndpoint,
  tokenEndpoint: mock.endpoints.tokenEndpoint,
  jwksUri: mock.endpoints.jwksUri,
  revocationEndpoint: mock.endpoints.revocationEndpoint,
  clientId: mock.clientId,
  gatewayResource: 'https://gateway.corp.example',
  redirectUri: `${process.env.DSH_WEB_ORIGIN ?? 'http://127.0.0.1:4567'}/iam/callback`,
  allowInsecureHttp: true,
};

console.log(JSON.stringify(config, null, 2));
console.log('Mock OIDC listening at', mock.issuer);
console.log('Press Ctrl+C to stop.');

const stop = async () => {
  await mock.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
