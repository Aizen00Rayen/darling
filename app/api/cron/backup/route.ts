import path from 'node:path';
import { createBackup } from '@/server/backup/backup';
import { logError } from '@/server/log';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'public' } as const;

/**
 * Called by the hPanel cron job: `curl -fsS -X POST -H "Authorization: Bearer $CRON_TOKEN" https://<domain>/api/cron/backup`.
 * Public rule, but guarded by the bearer token (`csrf: 'bearer'`): 404 when CRON_TOKEN is unset, 401 without the
 * right token, 403 for browsers (Origin header), 429 above 10 calls an hour per address.
 */
export const POST = withAccess(
  access,
  async ({ ctx, ip, requestId }) => {
    try {
      const result = await createBackup(ctx, { actorUserId: null, ip, requestId });
      return json(200, { ok: true, name: path.basename(result.path), bytes: result.bytes, at: result.at });
    } catch (err) {
      logError('backup.cron_failed', err);
      return json(500, { code: 'backup_failed' });
    }
  },
  { csrf: 'bearer' },
);
