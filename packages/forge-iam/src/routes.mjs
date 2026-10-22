const SIGN_IN_ERROR_STATUS = {
  IAM_NOT_IMPLEMENTED: 501,
  IAM_UNCONFIGURED: 409,
  IAM_EXCLUSIVE_CONFLICT: 409,
  IAM_INVALID_TRANSITION: 409,
};

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function errorBody(error) {
  return {
    error: {
      code: error?.code ?? 'IAM_INTERNAL',
      message: error?.message ?? 'IAM operation failed',
      ...(error?.details?.missing ? { missing: error.details.missing } : {}),
    },
  };
}

/**
 * Interim Host route used by the Client skeleton until the Remote namespace is
 * available. It exposes only the non-secret view and sign-in/sign-out intents;
 * the sign-in route is expected to return 501 until the IAM contract is frozen.
 *
 * @param {{ getView: Function, startSignIn: Function, signOut: Function }} service
 */
export function createIamRoutes(service) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const sendJson = (status, body) => send(res, status, body);

      if (url.pathname === '/api/forge-iam/view' || url.pathname === '/api/forge-iam/diagnostics') {
        if (req.method !== 'GET') return sendJson(405, { error: { code: 'IAM_METHOD_NOT_ALLOWED' } });
        return sendJson(200, service.getView());
      }

      if (url.pathname === '/api/forge-iam/sign-in') {
        if (req.method !== 'POST') return sendJson(405, { error: { code: 'IAM_METHOD_NOT_ALLOWED' } });
        try {
          const view = await service.startSignIn();
          return sendJson(200, view);
        } catch (error) {
          const status = SIGN_IN_ERROR_STATUS[error?.code] ?? 500;
          return sendJson(status, errorBody(error));
        }
      }

      if (url.pathname === '/api/forge-iam/sign-out') {
        if (req.method !== 'POST') return sendJson(405, { error: { code: 'IAM_METHOD_NOT_ALLOWED' } });
        try {
          return sendJson(200, await service.signOut());
        } catch (error) {
          return sendJson(500, errorBody(error));
        }
      }

      return sendJson(404, { error: { code: 'IAM_NOT_FOUND' } });
    } catch (error) {
      if (!res.headersSent) return send(res, 500, errorBody(error));
    }
  };
}