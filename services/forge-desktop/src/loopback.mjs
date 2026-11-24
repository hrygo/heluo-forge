import { fail } from './errors.mjs';

/** The one address the shell's web service may listen on and the window may load. */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Accept only `http://127.0.0.1:<port>…`. A refusal names the host and
 * nothing else: the rest of the address carries the web profile's process token.
 */
export function loopbackUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    fail('LAUNCH_URL_INVALID', 'the launch address is not a valid URL');
  }
  if (url.protocol !== 'http:') fail('LAUNCH_URL_REJECTED', 'the launch address must use http');
  if (url.hostname !== LOOPBACK_HOST) fail('LAUNCH_URL_REJECTED', `the launch address must be on ${LOOPBACK_HOST}, not ${url.hostname || 'an address without a host'}`);
  if (url.port === '') fail('LAUNCH_URL_REJECTED', 'the launch address must name an explicit port');
  if (url.username !== '' || url.password !== '') fail('LAUNCH_URL_REJECTED', 'the launch address must not carry credentials');
  return { href: url.href, origin: url.origin };
}

/** The bind address the shell passes to the web profile. The list of accepted values is this one. */
export function assertBindHost(host) {
  if (host !== LOOPBACK_HOST) fail('BIND_HOST_REJECTED', `the shell may bind only ${LOOPBACK_HOST}`);
  return host;
}
