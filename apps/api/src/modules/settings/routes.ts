import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SETTINGS } from '@darling/shared';
import type { AppDeps } from '../../app';
import { getAllSettings, updateSetting } from './service';

const ACCESS = { kind: 'permission', permission: 'settings.manage' } as const;

const keyParams = z.object({ key: z.string() });
// The value is checked against the key's own schema in the service, after the key is known to exist.
const patchBody = z.object({ value: z.unknown() });

/** Company and security settings: read and change, both behind `settings.manage`. */
export async function settingsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/settings',
    { config: { access: ACCESS }, schema: { response: { 200: z.object(SETTINGS) } } },
    async () => getAllSettings(deps.db),
  );

  typed.patch(
    '/api/settings/:key',
    {
      config: { access: ACCESS },
      schema: {
        params: keyParams,
        body: patchBody,
        response: { 200: z.object({ key: z.string(), value: z.unknown() }) },
      },
    },
    async (request) => {
      const auth = request.auth;
      // The access plugin has already refused anonymous callers; this keeps the types honest.
      if (!auth) throw new Error('settings route reached without a session');
      return updateSetting(
        deps,
        { userId: auth.userId, ip: request.ip, requestId: request.id },
        request.params.key,
        request.body.value,
      );
    },
  );
}
