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
import { isLoopbackAddress } from './loopback.mjs';

export { isLoopbackAddress };

// A release waits for the callback response it just produced, but nothing else.
// A local client that connects and never completes its request must not hold
// the port, the next bind or the unload behind it.
const RELEASE_GRACE_MS = 1000;

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
 * }} input
 */
export function startCallbackListener({ port = 0, address = '127.0.0.1', path, handler } = {}) {
  let failure;
  let origin;
  let gate;
  let closing;
  let settle = () => {};
  const server = createServer((req, res) => {
    // A request cannot arrive before `listening`, but a socket accepted during
    // shutdown could; refuse rather than guess an origin.
    if (!gate) {
      res.statusCode = 503;
      res.end();
      return;
    }
    gate(req, res);
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
      origin = loopbackOrigin(address, server.address().port);
      gate = createCallbackRequestHandler({ origin, path, handler });
      settle(undefined);
    });
    server.once('error', (error) => {
      const reason = error?.code ?? 'EADDRNOTAVAIL';
      failure = new IamError(
        reason === 'EADDRINUSE' ? 'IAM_CALLBACK_PORT_UNAVAILABLE' : 'IAM_CALLBACK_BIND_FAILED',
        `callback address ${address}:${port} is unavailable (${reason}); free the port or let the system assign one`,
        { port, address, reason },
      );
      settle(failure);
    });
  });
  server.listen(port, address);

  const shutdown = (cut) => {
    // Teardown escalates even when a release is already draining.
    if (cut) server.closeAllConnections?.();
    if (closing) return closing;
    settle(failure ?? new IamError(
      'IAM_CALLBACK_BIND_FAILED',
      `callback listener on ${address}:${port} was closed before it started listening`,
      { port, address },
    ));
    closing = new Promise((resolve) => {
      // Draining keeps the response that is being written; the grace timer then
      // drops whatever refused to finish, so the port cannot stay held.
      const grace = setTimeout(() => server.closeAllConnections?.(), RELEASE_GRACE_MS);
      grace.unref?.();
      server.close(() => {
        clearTimeout(grace);
        resolve();
      });
    });
    return closing;
  };

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
 * `ensure(owner)` returns the origin of the listener for that sign-in attempt.
 * `release(owner, responseDone)` drains only its listener after the response
 * or a bounded wait. Rebinding and teardown can release the previous listener
 * while its response is waiting.
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
 *   responseTimeoutMs?: number,
 *   startListener?: typeof startCallbackListener,
 * }} input
 */
export function createCallbackManager({
  port = 0, address = 'auto', path, handler, responseTimeoutMs = 10_000,
  startListener = startCallbackListener,
} = {}) {
  const candidates = address === 'auto' ? ['127.0.0.1', '::1'] : [address];
  let listener;
  let listenerOwner;
  let chain = Promise.resolve();

  async function bind(owner) {
    let failure;
    for (const candidate of candidates) {
      const attempt = startListener({ port, address: candidate, path, handler });
      const outcome = await attempt.ready;
      if (!outcome) {
        listener = attempt;
        listenerOwner = owner;
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

  function takeListener() {
    const current = listener;
    listener = undefined;
    listenerOwner = undefined;
    return current;
  }

  function release(owner, responseDone) {
    const releaseListener = () => serial(async () => {
      if (!listener || (owner !== undefined && owner !== listenerOwner)) return;
      await takeListener().release();
    });
    if (!responseDone) return releaseListener();
    // Keep waiting outside the bind queue so a new attempt or teardown can
    // free the port. A late response still releases only its original owner.
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(responseTimeoutMs, RELEASE_GRACE_MS));
      timer.unref?.();
    });
    return Promise.race([responseDone, deadline])
      .finally(() => clearTimeout(timer))
      .then(releaseListener, releaseListener);
  }

  return {
    get origin() { return listener?.origin; },
    get port() { return listener?.port; },
    ensure: (owner) => serial(async () => {
      if (listener && owner === listenerOwner) return listener.origin;
      if (listener) await takeListener().release();
      return bind(owner);
    }),
    release,
    close: () => serial(async () => {
      await takeListener()?.close();
    }),
  };
}
