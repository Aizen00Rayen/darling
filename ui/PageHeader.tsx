import type { ReactNode } from 'react';

export function PageHeader({ eyebrow, title, actions }: { eyebrow?: string; title: string; actions?: ReactNode }) {
  return (
    <header className="dl-page-header">
      <div className="dl-page-header__text">
        {eyebrow ? <p className="dl-eyebrow">{eyebrow}</p> : null}
        <h1 className="dl-page-header__title">{title}</h1>
      </div>
      {actions ? <div className="dl-page-header__actions">{actions}</div> : null}
    </header>
  );
}
