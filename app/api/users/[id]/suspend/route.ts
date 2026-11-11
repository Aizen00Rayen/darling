import { userAction } from '@/server/admin/actions';
import { suspendUser } from '@/server/admin/users';
import { withAccess } from '@/server/security/access';

export const access = { kind: 'permission', permission: 'users.manage' } as const;

export const POST = withAccess<typeof access, { id: string }>(access, userAction(suspendUser));
