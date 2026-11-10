import type { Writable } from 'node:stream';
import type { FastifyRequest, FastifyServerOptions } from 'fastify';
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

// The invitation lookup carries its token in the path; no log line may keep it.
const INVITE_LOOKUP_PATH = /^(\/api\/auth\/invite\/)(?!accept(?:[?#]|$))[^?#]*/;

export function redactUrl(url: string): string {
  return url.replace(INVITE_LOOKUP_PATH, '$1[Redacted]');
}

/** Fastify's default request serializer, with the URL passed through `redactUrl`. */
function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: redactUrl(request.url),
    version: request.headers['accept-version'] as string | undefined,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket ? request.socket.remotePort : undefined,
  };
}

export function loggerOptions(
  config: Pick<Config, 'nodeEnv'>,
  stream?: Writable,
): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: stream || config.nodeEnv !== 'test' ? 'info' : 'silent',
    redact: { paths: LOG_REDACT_PATHS, censor: '[Redacted]' },
    serializers: { req: serializeRequest },
    ...(stream ? { stream } : {}),
  };
}
