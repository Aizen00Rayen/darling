import { ROLES } from '@/shared';
import type { Me } from '@/shared';
import { requireUser } from '@/lib/auth/session';

export const requireAdmin = (): Promise<Me> => requireUser(['super_manager']);
export const requireManager = (): Promise<Me> => requireUser(['sub_manager']);
export const requireAffiliate = (): Promise<Me> => requireUser(['affiliate']);
/** Any role, also while the account still has to enrol in 2FA. */
export const requireAccount = (): Promise<Me> => requireUser([...ROLES], { allowDuring2faEnrollment: true });
