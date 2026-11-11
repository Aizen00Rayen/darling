import path from 'node:path';
import { createBackup } from '@/server/backup/backup';
import { logError } from '@/server/log';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'owner' } as const;

/** "Sauvegarder maintenant": a verified copy of the database in <DATA_DIR>/backups (owner only). */
export const POST = withAccess(access, async ({ ctx, auth, ip, requestId }) => {
  try {
    const result = await createBackup(ctx, { actorUserId: auth.userId, ip, requestId });
    return json(200, { name: path.basename(result.path), bytes: result.bytes, at: result.at });
  } catch (err) {
    logError('backup.failed', err);
    return json(500, { code: 'backup_failed' });
  }
});
