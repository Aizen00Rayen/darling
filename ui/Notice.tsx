import type { ReactNode } from 'react';

export type NoticeTone = 'info' | 'error' | 'success';

/** Errors are announced assertively (`role="alert"`); everything else politely (`role="status"`). */
export function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  return (
    <div className={`dl-notice dl-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
