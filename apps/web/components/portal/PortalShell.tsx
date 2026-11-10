'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppShell } from '@darling/ui';
import type { NavItem } from '@darling/ui';
import { LogoutButton } from './LogoutButton';

type Props = {
  nav: NavItem[];
  user: { fullName: string; roleLabel: string };
  children: ReactNode;
};

/** Client wrapper so the current nav item follows client-side navigation (layouts are not re-rendered). */
export function PortalShell({ nav, user, children }: Props) {
  const pathname = usePathname();
  return (
    <AppShell nav={nav} currentPath={pathname} user={user} logoutSlot={<LogoutButton />}>
      {children}
    </AppShell>
  );
}
