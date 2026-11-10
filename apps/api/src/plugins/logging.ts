import type { Writable } from 'node:stream';
import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config';

const SENSITIVE_FIELDS = ['password', 'newPassword', 'currentPassword', 'token'] as const;

// Fastify's default request serializer does not log headers or bodies, so these are
// defence in depth for anything a handler or a later serializer might add.
export const LOG_REDACT_PATHS: string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  ...SENSITIVE_FIELDS,
  ...SENSITIVE_FIELDS.map((f) => `*.${f}`),
  ...SENSITIVE_FIELDS.map((f) => `req.body.${f}`),
];

export function loggerOptions(
  config: Pick<Config, 'nodeEnv'>,
  stream?: Writable,
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: stream || config.nodeEnv !== 'test' ? 'info' : 'silent',
    redact: { paths: LOG_REDACT_PATHS, censor: '[Redacted]' },
    ...(stream ? { stream } : {}),
  };
}
