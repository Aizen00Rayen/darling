import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'pink' | 'success' | 'warning' | 'danger';

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`dl-badge dl-badge--${tone}`}>{children}</span>;
}
