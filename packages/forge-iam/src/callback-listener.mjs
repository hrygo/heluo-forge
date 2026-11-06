// Fixed loopback callback listener for the OIDC redirect.
//
// IAM matches the registered redirect URI byte for byte, and the host web
// server's port can change between launches. With `callbackPort` set the plugin
// binds the port itself: loopback only, one exact path, no fallback to the host
// port. Binding is asynchronous, so the failure is recorded here and every
// sign-in reads it before producing a redirect URI.
import { createServer } from 'node:http';
import { IamError } from './errors.mjs';

/**
 * True only for loopback peers. IPv4-mapped IPv6 addresses are unwrapped first,
 * and the whole 127/8 block counts because the kernel may report any of it.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  const value = String(address ?? '');
  if (value.startsWith('::ffff:')) return isLoopbackAddress(value.slice(7));
  if (value === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Refuse a peer that is not loopback. The listener already binds 127.0.0.1, so
 * this is the second line of defence and the rule a future proxy must keep.
 *
 * @returns {boolean} true when the request was rejected
 */
export function rejectNonLoopbackPeer(req, res) {
  if (isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  res.statusCode = 403;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end('callback is loopback only');
  return true;
}

/**
 * The request gate in front of the callback: loopback peer, exact path, then
 * the shared IAM route handler. Exported so the gate can be tested without a
 * socket; the listener binds 127.0.0.1 as the first line of defence.
 */
export function createCallbackRequestHandler({ origin, path, handler }) {
  const expectedHost = new URL(origin).host;
  return (req, res) => {
    try {
      if (rejectNonLoopbackPeer(req, res)) return;
      // DNS rebinding: a page on another origin can still aim a request at
      // 127.0.0.1, but it cannot make the browser send this Host header. The
      // registered redirect URI fixes the host, so a mismatch is never part of
      // a legitimate sign-in.
      if (req.headers?.host !== expectedHost) {
        res.statusCode = 403;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('callback host is not the registered redirect host');
        return;
      }
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname !== path) {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('not found');
        return;
      }
      handler(req, res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  };
}

/**
 * Start the fixed callback listener.
 *
 * `ready` resolves to `undefined` once bound, or to the IamError once binding
 * fails. A failed bind never retries another port.
 *
 * @param {{
 *   port: number,
 *   origin: string,
 *   path: string,
 *   handler: (req: object, res: object) => unknown,
 *   onFailure?: (error: IamError) => void,
 * }} input
 */
export function startCallbackListener({ port, origin, path, handler, onFailure } = {}) {
  let failure;
  let closed = false;
  let settle = () => {};
  const server = createServer(createCallbackRequestHandler({ origin, path, handler }));

  const ready = new Promise((resolve) => {
    // Whoever settles first wins: a bind result, or a teardown that abandons
    // the bind. Without the teardown branch a caller awaiting `ready` would
    // wait forever on a listener that was closed before it ever listened.
    settle = (result) => {
      settle = () => {};
      resolve(result);
    };
    server.once('listening', () => settle(undefined));
    server.once('error', (error) => {
      const reason = error?.code ?? 'EADDRNOTAVAIL';
      failure = new IamError(
        reason === 'EADDRINUSE' ? 'IAM_CALLBACK_PORT_UNAVAILABLE' : 'IAM_CALLBACK_BIND_FAILED',
        `callback port ${port} is unavailable (${reason}); free the port or register a different one`,
        { port, reason },
      );
      onFailure?.(failure);
      settle(failure);
    });
  });
  server.listen(port, '127.0.0.1');

  return {
    origin,
    port,
    server,
    ready,
    get failure() { return failure; },
    /** Idempotent; returns after the listening socket is released. */
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      settle(failure ?? new IamError(
        'IAM_CALLBACK_BIND_FAILED',
        `callback listener on port ${port} was closed before it started listening`,
        { port },
      ));
      server.close(() => resolve());
      // Close keep-alive sockets so a test or an unload does not wait on them.
      server.closeAllConnections?.();
    }),
  };
}
