import { auditQuery, listAuditLog } from '@/server/admin/audit-log';
import { parseQuery } from '@/server/admin/query';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'audit.read' } as const;

export const GET = withAccess(access, ({ request, ctx }) => {
  const query = parseQuery(request, auditQuery);
  if (!query.ok) return query.response;
  return json(200, listAuditLog(ctx.db, query.data));
});
