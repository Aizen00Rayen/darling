import { getAllSettings } from '@/server/admin/settings';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'settings.manage' } as const;

export const GET = withAccess(access, ({ ctx }) => json(200, getAllSettings(ctx.db)));
