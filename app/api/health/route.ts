import { json, withAccess } from '@/server/security/access';
import { logError } from '@/server/log';

export const access = { kind: 'public' } as const;

/** Liveness + database check for uptime monitors. No detail is ever returned. */
export const GET = withAccess(access, ({ ctx }) => {
  try {
    ctx.db.get('SELECT 1 AS ok');
    return json(200, { ok: true, db: 'up' });
  } catch (err) {
    logError('health.db_down', err);
    return json(503, { ok: false, db: 'down' });
  }
});
