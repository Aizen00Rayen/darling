import { toMe } from '@/server/auth/principal';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'authenticated', allowDuring2faEnrollment: true } as const;

export const GET = withAccess(access, ({ auth }) => json(200, toMe(auth)));
