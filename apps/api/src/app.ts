import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config';
import type { Db } from './db/client';
import type { Clock } from './lib/clock';
import type { Mailer } from './mail/mailer';
import { authRoutes } from './modules/auth/routes';
import { accessPlugin } from './plugins/access';
import { authPlugin } from './plugins/auth';
import { csrfPlugin } from './plugins/csrf';
import { registerErrorHandling } from './plugins/errors';
import { loggerOptions } from './plugins/logging';

export type { Config } from './config';
export type { Clock } from './lib/clock';
export type AppDeps = { config: Config; db: Db; mailer: Mailer; clock: Clock };
export type BuildAppOptions = {
  logStream?: Writable;
  /**
   * Called once the shared plugins are in place, so probe routes and hooks registered here are
   * subject to the access and CSRF plugins exactly like production routes. Used by tests.
   */
  extend?: (app: FastifyInstance) => void | Promise<void>;
};

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const HEALTH_DB_TIMEOUT_MS = 2_000;

const healthResponse = z.object({ ok: z.boolean(), db: z.enum(['up', 'down']) });

export async function buildApp(
  deps: AppDeps,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const { config, db } = deps;

  const app = Fastify({
    logger: loggerOptions(config, options.logStream),
    trustProxy: config.trustProxy,
    // Accept a caller-supplied id only when it is well formed; otherwise mint one.
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  await app.register(helmet, {
    // API responses are JSON: nothing should ever load or frame from them.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Both are non-encapsulated and must come before any route so their hooks cover every route.
  await app.register(csrfPlugin, { appOrigin: config.appOrigin });
  // The auth plugin resolves the session in onRequest; the access plugin enforces in preValidation.
  await app.register(authPlugin, { config, db, clock: deps.clock });
  await app.register(accessPlugin);

  registerErrorHandling(app);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/health',
    {
      config: { access: { kind: 'public' } },
      schema: { response: { 200: healthResponse, 503: healthResponse } },
    },
    async (_req, reply) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          db.execute(sql`select 1`),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`database did not answer within ${HEALTH_DB_TIMEOUT_MS} ms`)),
              HEALTH_DB_TIMEOUT_MS,
            );
          }),
        ]);
        return { ok: true, db: 'up' as const };
      } catch (err) {
        app.log.error({ err }, 'health check: database unreachable');
        return reply.status(503).send({ ok: false, db: 'down' });
      } finally {
        clearTimeout(timer);
      }
    },
  );

  await app.register(authRoutes, deps);

  await options.extend?.(app);

  return app;
}
