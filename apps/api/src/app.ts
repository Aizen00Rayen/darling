import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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
import { registerErrorHandling } from './plugins/errors';
import { loggerOptions } from './plugins/logging';

export type { Config } from './config';
export type { Clock } from './lib/clock';
export type AppDeps = { config: Config; db: Db; mailer: Mailer; clock: Clock };
export type BuildAppOptions = { logStream?: Writable };

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

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

  registerErrorHandling(app);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/health',
    {
      // The access plugin arrives in Task 6; until then this is just carried on the route.
      config: { access: { kind: 'public' } },
      schema: { response: { 200: healthResponse, 503: healthResponse } },
    },
    async (_req, reply) => {
      try {
        await db.execute('select 1');
        return { ok: true, db: 'up' as const };
      } catch (err) {
        app.log.error({ err }, 'health check: database unreachable');
        return reply.status(503).send({ ok: false, db: 'down' });
      }
    },
  );

  return app;
}
