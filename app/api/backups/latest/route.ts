import fs from 'node:fs';
import { Readable } from 'node:stream';
import { recordAudit } from '@/server/audit';
import { latestBackup } from '@/server/backup/backup';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'owner' } as const;

/**
 * Downloads the newest backup (owner only). The file holds ALL personal data (customers, phone numbers, password
 * hashes, encrypted 2FA secrets): never cacheable, audited. The name comes from the directory listing filtered by
 * the backup name pattern (symlinks excluded), never from the request.
 */
export const GET = withAccess(access, ({ ctx, auth, ip, requestId }) => {
  const latest = latestBackup(ctx.config.dataDir);
  if (!latest) return json(404, { code: 'not_found' });
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(latest.path);
  } catch {
    return json(404, { code: 'not_found' });
  }
  recordAudit(ctx.db, {
    actorUserId: auth.userId,
    action: 'backup.downloaded',
    entityType: 'backup',
    entityId: latest.name,
    ip,
    requestId,
    at: ctx.clock.now(),
  });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(latest.bytes),
      'Content-Disposition': `attachment; filename="${latest.name}"`,
      'Cache-Control': 'no-store',
    },
  });
});
