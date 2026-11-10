import fp from 'fastify-plugin';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfOptions = {
  /** The one origin the web app is served from, normalised (no path, no trailing slash). */
  appOrigin: string;
};

/**
 * Every state-changing request must come from our own web app: it sends `X-Requested-With: fetch`
 * (which a cross-site form cannot set) and a browser-supplied `Origin` equal to the app origin.
 * Public routes are not exempt: login and password reset must be protected too. Comparison is exact
 * and case-sensitive against the normalised origin; there is no pattern matching to get wrong.
 */
export const csrfPlugin = fp<CsrfOptions>(
  async (app, { appOrigin }) => {
    app.addHook('onRequest', async (request, reply) => {
      if (SAFE_METHODS.has(request.method)) return;
      const requestedWith = request.headers['x-requested-with'];
      const origin = request.headers.origin;
      if (requestedWith === 'fetch' && origin === appOrigin) return;
      return reply.code(403).send({ code: 'csrf' });
    });
  },
  { name: 'darling-csrf' },
);
