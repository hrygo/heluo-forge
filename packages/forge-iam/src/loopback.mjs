import { isIPv4, isIPv6 } from 'node:net';

/** Accept real IPv4, IPv6, and IPv4-mapped loopback socket addresses. */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  if (isIPv4(address)) return address.startsWith('127.');
  if (!isIPv6(address) || address.includes('%')) return false;
  const { hostname } = new URL(`http://[${address}]`);
  return hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname);
}
