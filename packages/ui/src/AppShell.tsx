'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from './cx';

export type NavItem = { href: string; label: string; icon?: ReactNode };

export type AppShellProps = {
  brand?: string;
  nav: NavItem[];
  currentPath: string;
  user: { fullName: string; roleLabel: string };
  onLogoutHref: string;
  children: ReactNode;
};

/** The nav item whose href is the longest path-segment prefix of `currentPath`, if any. */
function bestMatch(nav: NavItem[], currentPath: string): string | null {
  let best: string | null = null;
  for (const item of nav) {
    const h = item.href.replace(/\/+$/, '') || '/';
    const hit = h === '/' ? currentPath === '/' : currentPath === h || currentPath.startsWith(`${h}/`);
    if (hit && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best;
}

export function AppShell({ brand = 'Darling', nav, currentPath, user, onLogoutHref, children }: AppShellProps) {
  const navId = useId();
  const [open, setOpen] = useState(false);
  const [seenPath, setSeenPath] = useState(currentPath);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Close the drawer on route change (state adjusted during render, no effect needed).
  if (seenPath !== currentPath) {
    setSeenPath(currentPath);
    setOpen(false);
  }

  // Escape closes the drawer while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Whenever the drawer goes from open to closed, give focus back to the toggle button.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const current = bestMatch(nav, currentPath);

  return (
    <div className="dl-shell">
      <header className="dl-topbar glass">
        <span className="dl-brand">{brand}</span>
        <button
          ref={buttonRef}
          type="button"
          className="dl-menu-btn"
          aria-expanded={open}
          aria-controls={navId}
          aria-label={open ? 'Fermer le menu' : 'Ouvrir le menu'}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="dl-menu-btn__bars" aria-hidden="true" />
          <span>Menu</span>
        </button>
      </header>

      <div className="dl-backdrop" data-open={open} aria-hidden="true" onClick={() => setOpen(false)} />

      <aside className="dl-sidebar" id={navId} data-open={open}>
        <span className="dl-brand dl-sidebar__brand">{brand}</span>
        <nav aria-label="Navigation principale">
          <ul className="dl-nav">
            {nav.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className={cx('dl-nav__link', item.href === current && 'is-current')}
                  aria-current={item.href === current ? 'page' : undefined}
                >
                  {item.icon ? (
                    <span className="dl-nav__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : null}
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="dl-user glass">
          <span className="dl-user__name">{user.fullName}</span>
          <span className="dl-eyebrow">{user.roleLabel}</span>
          <a className="dl-user__logout" href={onLogoutHref}>
            Se déconnecter
          </a>
        </div>
      </aside>

      <main className="dl-main">{children}</main>
    </div>
  );
}
