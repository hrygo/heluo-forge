// Plugin-owned loopback callback listener for the OIDC redirect.
//
// IAM accepts any port on a loopback redirect URI, so the listener takes an
// OS-assigned port by default and stays bound only while a sign-in attempt is
// open. `callbackPort` can pin a port instead, for an authorization server that
// still insists on a pre-registered value.
//
// Binding is asynchronous and the port is only known afterwards, so the origin
// is published on the listening event; the request gate reads it lazily.
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
 * Refuse a peer that is not loopback. The listener already binds a loopback
 * address, so this is the second line of defence and the rule a future proxy
 * must keep.
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
 * Build the origin for a loopback bind. IPv6 literals need brackets in a URL,
 * and the best current practice names the address instead of `localhost`.
 *
 * @param {string} address
 * @param {number} port
 * @returns {string}
 */
export function loopbackOrigin(address, port) {
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/**
 * The request gate in front of the callback: loopback peer, exact path, then
 * the shared IAM route handler. Exported so the gate can be tested without a
 * socket; the listener binds a loopback address as the first line of defence.
 */
export function createCallbackRequestHandler({ origin, path, handler }) {
  const expectedHost = new URL(origin).host;
  return (req, res) => {
    try {
      if (rejectNonLoopbackPeer(req, res)) return;
      // DNS rebinding: a page on another origin can still aim a request at the
      // loopback address, but it cannot make the browser send this Host header.
      const host = req.headers?.host;
      if (host !== expectedHost) {
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
 * Start the callback listener on a loopback address.
 *
 * `ready` resolves to `undefined` once bound, or to the IamError once binding
 * fails. A failed bind never retries another port; the caller may try another
 * address family instead.
 *
 * `release()` drains: it stops accepting and lets the in-flight callback
 * response finish, which is what an attempt ending needs. `close()` cuts every
 * socket, which is what teardown needs.
 *
 * @param {{
 *   port?: number,
 *   address?: string,
 *   path: string,
 *   handler: (req: object, res: object) => unknown,
 *   onFailure?: (error: IamError) => void,
 * }} input
 */
export function startCallbackListener({ port = 0, address = '127.0.0.1', path, handler, onFailure } = {}) {
  let failure;
  let origin;
  let closed = false;
  let settle = () => {};
  const server = createServer((req, res) => {
    // A request cannot arrive before `listening`, but a socket accepted during
    // shutdown could; refuse rather than guess an origin.
    if (!origin) {
      res.statusCode = 503;
      res.end();
      return;
    }
    createCallbackRequestHandler({ origin, path, handler })(req, res);
  });

  const ready = new Promise((resolve) => {
    // Whoever settles first wins: a bind result, or a teardown that abandons
    // the bind. Without the teardown branch a caller awaiting `ready` would
    // wait forever on a listener that was closed before it ever listened.
    settle = (result) => {
      settle = () => {};
      resolve(result);
    };
    server.once('listening', () => {
      const bound = server.address();
      origin = loopbackOrigin(address, bound.port);
      settle(undefined);
    });
    server.once('error', (error) => {
      const reason = error?.code ?? 'EADDRNOTAVAIL';
      failure = new IamError(
        reason === 'EADDRINUSE' ? 'IAM_CALLBACK_PORT_UNAVAILABLE' : 'IAM_CALLBACK_BIND_FAILED',
        `callback address ${address}:${port} is unavailable (${reason}); free the port or let the system assign one`,
        { port, address, reason },
      );
      onFailure?.(failure);
      settle(failure);
    });
  });
  server.listen(port, address);

  const shutdown = (cut) => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    settle(failure ?? new IamError(
      'IAM_CALLBACK_BIND_FAILED',
      `callback listener on ${address}:${port} was closed before it started listening`,
      { port, address },
    ));
    server.close(() => resolve());
    // Draining must keep the response that is being written; teardown must not
    // wait on a browser that never closes its socket.
    if (cut) server.closeAllConnections?.();
  });

  return {
    get origin() { return origin; },
    get port() { return server.address()?.port ?? port; },
    address,
    server,
    ready,
    get failure() { return failure; },
    /** Idempotent; stops accepting and lets the in-flight response finish. */
    release: () => shutdown(false),
    /** Idempotent; stops accepting and drops every open socket. */
    close: () => shutdown(true),
  };
}
/**
 * Binds the callback listener only while an attempt needs it.
 *
 * `ensure()` returns the origin of the live listener, binding first if there is
 * none. `release()` drains the current listener: the attempt is over, but the
 * response being written must still reach the browser. `close()` cuts it and is
 * only used on teardown.
 *
 * The default is `auto`: the IPv4 loopback is always tried first, because that
 * is the prefix IAM registers, and IPv6 is only tried when the IPv4 loopback
 * does not exist on this host. Both IPv6 options need IAM to register
 * `http://[::1]` as well.
 *
 * @param {{
 *   port?: number,
 *   address?: 'auto' | '127.0.0.1' | '::1',
 *   path: string,
 *   handler: (req: object, res: object) => unknown,
 *   startListener?: typeof startCallbackListener,
 * }} input
 */
export function createCallbackManager({ port = 0, address = 'auto', path, handler, startListener = startCallbackListener } = {}) {
  const candidates = address === 'auto' ? ['127.0.0.1', '::1'] : [address];
  let listener;
  let chain = Promise.resolve();

  async function bind() {
    let failure;
    for (const candidate of candidates) {
      const attempt = startListener({ port, address: candidate, path, handler });
      const outcome = await attempt.ready;
      if (!outcome) {
        listener = attempt;
        return attempt.origin;
      }
      await attempt.release();
      failure = outcome;
      const familyMissing = outcome.code === 'IAM_CALLBACK_BIND_FAILED'
        && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(outcome.details?.reason);
      if (!familyMissing) throw outcome;
    }
    throw failure;
  }

  function serial(run) {
    const next = chain.then(run);
    chain = next.then(() => {}, () => {});
    return next;
  }

  return {
    get origin() { return listener?.origin; },
    get port() { return listener?.port; },
    ensure: () => serial(async () => {
      if (listener) return listener.origin;
      return bind();
    }),
    release: () => serial(async () => {
      const current = listener;
      listener = undefined;
      if (current) await current.release();
    }),
    close: () => serial(async () => {
      const current = listener;
      listener = undefined;
      if (current) await current.close();
    }),
  };
}
