import { Suspense } from 'react';
import type { ReactNode } from 'react';
import '@darling/ui/tokens.css';
import '@darling/ui/portal.css';
import './portal-extra.css';
import { Notice } from '@darling/ui';
import { ROLE_LABELS } from '@darling/shared';
import type { Role } from '@darling/shared';
import { requireUser } from '@/lib/auth/session';
import { navFor } from '@/lib/portal/nav';
import { PortalShell } from './PortalShell';

type Props = {
  roles: Role[];
  /** Only the account layout: lets a user who must enrol in 2FA in, with no navigation. */
  allowDuring2faEnrollment?: boolean;
  children: ReactNode;
};

const Loading = () => (
  <p className="p-loading" role="status">
    Chargement…
  </p>
);

/** Every portal layout renders this: the `dl-portal` root, the session gate and the app shell. */
export function PortalFrame(props: Props) {
  return (
    <div className="dl-portal">
      <Suspense fallback={<Loading />}>
        <Gate {...props} />
      </Suspense>
    </div>
  );
}

async function Gate({ roles, allowDuring2faEnrollment, children }: Props) {
  const me = await requireUser(roles, { allowDuring2faEnrollment: allowDuring2faEnrollment ?? false });
  const nav = navFor(me.role, me.permissions, { enrolling: me.mustEnroll2fa });
  return (
    <PortalShell nav={nav} user={{ fullName: me.fullName, roleLabel: ROLE_LABELS[me.role] }}>
      {me.mustEnroll2fa ? (
        <div className="p-banner">
          <Notice tone="info">La double authentification est obligatoire pour votre rôle.</Notice>
        </div>
      ) : null}
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </PortalShell>
  );
}
