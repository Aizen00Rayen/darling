import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { ApiError } from '@darling/shared';

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

function validationErrors(error: { validation: { instancePath: string; message?: string }[] }) {
  const errors: Record<string, string> = {};
  for (const issue of error.validation) {
    const field = issue.instancePath.split('/').filter(Boolean).join('.') || '_';
    if (!(field in errors)) errors[field] = issue.message ?? 'Invalid value';
  }
  return errors;
}

function send(reply: FastifyReply, status: number, body: ApiError) {
  return reply.status(status).send(body);
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) =>
    send(reply, 404, { code: 'not_found' }),
  );

  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return send(reply, 400, { code: 'validation', errors: validationErrors(error) });
    }
    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return send(reply, status, { code: CLIENT_ERROR_CODES[status] ?? 'bad_request' });
    }
    // Anything else is a bug or an outage: log it with the request id, tell the client nothing.
    req.log.error({ err: error, reqId: req.id }, 'unhandled error');
    return send(reply, 500, { code: 'internal' });
  });
}
